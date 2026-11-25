#!/usr/bin/env node
// Accounting & ERP Invoice Sync Connector Recipe (QuickBooks Online, Xero, NetSuite):
// 1. Verifies and deduplicates signed `order.invoiced` and `invoice.settled` CloudEvents with
//    the vendored connector-kit `WebhookReceiver` (body digest, RFC 9421, replay guard).
// 2. Hydrates the install-scoped minimized order and `Order.invoice` object via
//    `GET /api/apps/v1/orders/{id}` (`orders:read-minimal`), obtaining the install's opaque
//    `customerHash` without ever receiving raw customer PII, PO numbers, or notes.
// 3. Maps the canonical invoice and settlement state through plug-in ERP adapters for
//    QuickBooks Online (`QBO`), Xero (`XERO`), and NetSuite (`NS`).
// 4. Writes back `externalAccountingRef` (e.g. `QBO:inv-1042`) via idempotent
//    `POST /api/apps/v1/orders/{id}/accounting-ref` (`orders:write-accounting-ref`) with a
//    deterministic `Idempotency-Key`, handling 200 replay and 409 conflict responses cleanly.
//
// Run offline self-test:
//   node index.mjs --self-test
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ApiClient, ApiError, AuthorizationMetadata, WebhookReceiver } from './vendor/connector-kit/index.js';

const SAMPLE_INVOICED_EVENT = JSON.parse(
  readFileSync(new URL('./fixtures/order.invoiced.cloudevent.json', import.meta.url), 'utf8'),
);
const SAMPLE_SETTLED_EVENT = JSON.parse(
  readFileSync(new URL('./fixtures/invoice.settled.cloudevent.json', import.meta.url), 'utf8'),
);

const ACCOUNTING_REF_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function deriveIdempotencyKey(prefix, payload) {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 36);
  return `${prefix}-${digest}`;
}

/**
 * Combines an `order.invoiced` CloudEvent data payload with the hydrated `GET /orders/{id}` response
 * into an adapter-agnostic ERP invoice model. Carries zero raw customer PII, PO numbers, or notes.
 */
export function buildCanonicalErpInvoice({ eventData, order }) {
  const invoice = order?.invoice ?? {};
  const subtotal = Number(eventData.subtotal ?? order?.subtotal ?? 0);
  const total = Number(eventData.total ?? order?.total ?? 0);
  const freightAmount = Math.max(0, Number((total - subtotal).toFixed(2)));
  return {
    orderId: eventData.orderId,
    invoiceNumber: invoice.invoiceNumber ?? eventData.invoiceNumber,
    quoteId: invoice.quoteId ?? eventData.quoteId ?? null,
    settlementMode: invoice.settlementMode ?? eventData.settlementMode,
    settlementStatus: invoice.settlementStatus ?? 'issued',
    netTermsDays: invoice.netTermsDays ?? eventData.netTermsDays ?? null,
    dueAt: invoice.dueAt ?? eventData.dueAt ?? null,
    issuedAt: eventData.issuedAt ?? order?.createdAt,
    currency: eventData.currency ?? order?.currency ?? 'USD',
    customerHash: order?.customerHash ?? null,
    subtotal,
    freightAmount,
    total,
    lineItems: (eventData.lineItems ?? order?.lineItems ?? []).map((line) => ({
      sku: line.sku,
      ...(line.handle ? { handle: line.handle } : {}),
      quantity: line.quantity,
      lineTotal: Number(line.lineTotal ?? 0),
    })),
  };
}

/**
 * Plug-in ERP adapters for QuickBooks Online (`QBO`), Xero (`XERO`), and NetSuite (`NS`).
 * Each adapter maps the canonical invoice/settlement into the target ERP's wire shape and returns
 * a deterministic `externalAccountingRef` matching `^[A-Za-z0-9._:-]{1,128}$`.
 */
export const ERP_ADAPTERS = Object.freeze({
  QBO: {
    provider: 'QBO',
    mapInvoice(canonical) {
      return {
        DocNumber: canonical.invoiceNumber,
        TxnDate: canonical.issuedAt.slice(0, 10),
        ...(canonical.dueAt ? { DueDate: canonical.dueAt.slice(0, 10) } : {}),
        CurrencyRef: { value: canonical.currency },
        CustomerRef: { value: `cust_${(canonical.customerHash ?? 'anon').slice(0, 16)}` },
        SalesTermRef: canonical.netTermsDays !== null ? { value: `NET_${canonical.netTermsDays}` } : { value: canonical.settlementMode },
        Line: [
          ...canonical.lineItems.map((line, index) => ({
            LineNum: index + 1,
            DetailType: 'SalesItemLineDetail',
            Amount: line.lineTotal,
            SalesItemLineDetail: {
              ItemRef: { value: line.sku },
              Qty: line.quantity,
            },
          })),
          ...(canonical.freightAmount > 0
            ? [{ DetailType: 'SalesItemLineDetail', Amount: canonical.freightAmount, SalesItemLineDetail: { ItemRef: { value: 'SHIPPING' }, Qty: 1 } }]
            : []),
        ],
      };
    },
    formatExternalRef(canonical) {
      return `QBO:${canonical.invoiceNumber}`;
    },
    mapSettlement(eventData, externalAccountingRef) {
      return {
        LinkedInvoiceRef: externalAccountingRef,
        DocNumber: eventData.invoiceNumber,
        TotalAmt: eventData.total,
        CurrencyRef: { value: eventData.currency },
        TxnDate: eventData.settledAt.slice(0, 10),
        PaymentMethodRef: { value: eventData.settlementMode },
      };
    },
  },

  XERO: {
    provider: 'XERO',
    mapInvoice(canonical) {
      return {
        Type: 'ACCREC',
        InvoiceNumber: canonical.invoiceNumber,
        Reference: canonical.quoteId ?? canonical.orderId,
        Contact: { ContactNumber: `tot_${(canonical.customerHash ?? 'anon').slice(0, 16)}` },
        Date: canonical.issuedAt.slice(0, 10),
        ...(canonical.dueAt ? { DueDate: canonical.dueAt.slice(0, 10) } : {}),
        CurrencyCode: canonical.currency,
        Status: 'AUTHORISED',
        LineItems: [
          ...canonical.lineItems.map((line) => ({
            ItemCode: line.sku,
            Quantity: line.quantity,
            LineAmount: line.lineTotal,
          })),
          ...(canonical.freightAmount > 0
            ? [{ ItemCode: 'FREIGHT', Quantity: 1, LineAmount: canonical.freightAmount }]
            : []),
        ],
      };
    },
    formatExternalRef(canonical) {
      return `XERO:${canonical.invoiceNumber}`;
    },
    mapSettlement(eventData, externalAccountingRef) {
      return {
        Invoice: { InvoiceNumber: eventData.invoiceNumber, ExternalRef: externalAccountingRef },
        Date: eventData.settledAt.slice(0, 10),
        Amount: eventData.total,
        CurrencyCode: eventData.currency,
      };
    },
  },

  NS: {
    provider: 'NS',
    mapInvoice(canonical) {
      return {
        recordType: 'invoice',
        tranId: canonical.invoiceNumber,
        externalId: canonical.orderId,
        entity: { externalId: `tot_${(canonical.customerHash ?? 'anon').slice(0, 16)}` },
        currency: { refName: canonical.currency },
        tranDate: canonical.issuedAt,
        ...(canonical.dueAt ? { dueDate: canonical.dueAt } : {}),
        item: {
          items: canonical.lineItems.map((line) => ({
            item: { refName: line.sku },
            quantity: line.quantity,
            amount: line.lineTotal,
          })),
        },
        shippingCost: canonical.freightAmount,
      };
    },
    formatExternalRef(canonical) {
      return `NS:${canonical.invoiceNumber}`;
    },
    mapSettlement(eventData, externalAccountingRef) {
      return {
        recordType: 'customerPayment',
        appliedToTransaction: externalAccountingRef,
        tranId: eventData.invoiceNumber,
        payment: eventData.total,
        tranDate: eventData.settledAt,
      };
    },
  },
});

function createRequest({ baseUrl, accessToken, fetchImpl }) {
  const api = new ApiClient({ origin: baseUrl, auth: { getAccessToken: async () => accessToken }, fetch: fetchImpl });
  return async function request(method, path, { query, body, idempotencyKey } = {}) {
    try {
      const res = await api.request({ method, path, query, body, idempotencyKey });
      return { status: res.status, ok: true, body: res.body };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, ok: false, body: { code: err.code } };
      throw err;
    }
  };
}

export function createAccountingErpConnector({
  baseUrl,
  accessToken,
  erpProvider = 'QBO',
  fetchImpl = fetch,
}) {
  const adapter = ERP_ADAPTERS[erpProvider];
  if (!adapter) {
    throw new Error(`Unsupported ERP provider: ${erpProvider} (expected QBO, XERO, or NS)`);
  }

  const seenEvents = new Set();
  const erpInvoicesByOrder = new Map();
  const erpSettlementsByOrder = new Map();
  const request = createRequest({ baseUrl, accessToken, fetchImpl });

  return {
    getOrder(orderId) {
      return request('GET', `/orders/${encodeURIComponent(orderId)}`);
    },

    listOrders({ status, limit = 24, cursor, updatedSince } = {}) {
      return request('GET', '/orders', {
        query: {
          limit,
          ...(status ? { status } : {}),
          ...(cursor ? { cursor } : {}),
          ...(updatedSince ? { updatedSince } : {}),
        },
      });
    },

    writeAccountingRef(orderId, externalAccountingRef, { idempotencyKey } = {}) {
      if (typeof externalAccountingRef !== 'string' || !ACCOUNTING_REF_RE.test(externalAccountingRef)) {
        throw new Error(`Invalid externalAccountingRef: ${externalAccountingRef}`);
      }
      const body = { externalAccountingRef };
      const key = idempotencyKey ?? deriveIdempotencyKey('erp-ref', { orderId, externalAccountingRef });
      return request('POST', `/orders/${encodeURIComponent(orderId)}/accounting-ref`, {
        body,
        idempotencyKey: key,
      });
    },

    /**
     * Handles an `order.invoiced` CloudEvent:
     * 1. Deduplicates on CloudEvents `id`.
     * 2. Hydrates `GET /orders/{orderId}` for `customerHash` and `Order.invoice`.
     * 3. Maps the invoice through the configured ERP adapter (`QBO`, `XERO`, or `NS`).
     * 4. Writes back `externalAccountingRef` via `POST /orders/{orderId}/accounting-ref`.
     */
    async handleOrderInvoicedWebhook(event) {
      if (seenEvents.has(event.id)) {
        return { duplicate: true, orderId: event.data.orderId, externalAccountingRef: null };
      }
      seenEvents.add(event.id);

      const { orderId } = event.data;
      const orderRes = await this.getOrder(orderId);
      if (!orderRes.ok) {
        throw new Error(`Failed to hydrate order ${orderId}: ${orderRes.status}`);
      }

      const canonical = buildCanonicalErpInvoice({ eventData: event.data, order: orderRes.body });
      const erpPayload = adapter.mapInvoice(canonical);
      const externalAccountingRef = orderRes.body?.invoice?.externalAccountingRef ?? adapter.formatExternalRef(canonical);

      const writeback = await this.writeAccountingRef(orderId, externalAccountingRef);
      erpInvoicesByOrder.set(orderId, {
        provider: adapter.provider,
        externalAccountingRef,
        canonical,
        erpPayload,
        writebackStatus: writeback.status,
      });

      return {
        duplicate: false,
        provider: adapter.provider,
        orderId,
        invoiceNumber: canonical.invoiceNumber,
        externalAccountingRef,
        erpPayload,
        writeback,
      };
    },

    /**
     * Handles an `invoice.settled` CloudEvent:
     * 1. Deduplicates on CloudEvents `id`.
     * 2. Hydrates `GET /orders/{orderId}` if the invoice's `externalAccountingRef` is not yet cached.
     * 3. Maps the payment/settlement record into the configured ERP adapter.
     */
    async handleInvoiceSettledWebhook(event) {
      if (seenEvents.has(event.id)) {
        return { duplicate: true, orderId: event.data.orderId, settlementPayload: null };
      }
      seenEvents.add(event.id);

      const { orderId } = event.data;
      let externalAccountingRef = erpInvoicesByOrder.get(orderId)?.externalAccountingRef ?? null;
      if (!externalAccountingRef) {
        const orderRes = await this.getOrder(orderId);
        externalAccountingRef = orderRes.body?.invoice?.externalAccountingRef ?? `${adapter.provider}:${event.data.invoiceNumber}`;
      }

      const settlementPayload = adapter.mapSettlement(event.data, externalAccountingRef);
      erpSettlementsByOrder.set(orderId, {
        provider: adapter.provider,
        externalAccountingRef,
        settlementPayload,
      });

      return {
        duplicate: false,
        provider: adapter.provider,
        orderId,
        invoiceNumber: event.data.invoiceNumber,
        externalAccountingRef,
        settlementPayload,
      };
    },

    getSyncedInvoice(orderId) {
      return erpInvoicesByOrder.get(orderId) ?? null;
    },

    getSyncedSettlement(orderId) {
      return erpSettlementsByOrder.get(orderId) ?? null;
    },
  };
}

/**
 * Verifies inbound `order.invoiced` and `invoice.settled` deliveries with the vendored
 * connector-kit `WebhookReceiver` (body digest, RFC 9421 signature, replay guard).
 */
export function createAccountingWebhookReceiver({
  origin,
  endpoint,
  connector,
  keys = new AuthorizationMetadata({ origin }),
  seenEvents,
}) {
  const receiver = new WebhookReceiver({ endpoint, keys, seenEvents });
  return {
    handleRequest: (request) =>
      receiver.handleRequest(request, async (event) => {
        if (event.type === 'com.tokenoftrust.storefront.order.invoiced') {
          await connector.handleOrderInvoicedWebhook(event);
        } else if (event.type === 'com.tokenoftrust.storefront.invoice.settled') {
          await connector.handleInvoiceSettledWebhook(event);
        }
      }),
  };
}

/**
 * In-memory Storefront Private Apps v1 gateway simulator supporting:
 * - `GET /api/apps/v1/orders` and `GET /api/apps/v1/orders/{id}` (with `Order.invoice`)
 * - `POST /api/apps/v1/orders/{id}/accounting-ref` (idempotent writeback, 200 replay, 409 conflicts)
 */
export function createSimulatedAccountingGateway() {
  const orders = new Map();
  const idempotency = new Map();

  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

  return {
    seedInvoiceOrder(order) {
      orders.set(order.id, structuredClone(order));
    },

    async fetchImpl(input, init = {}) {
      const url = new URL(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = Object.fromEntries(
        Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const path = url.pathname.replace(/^\/api\/apps\/v1/, '');

      if (method === 'GET' && path === '/orders') {
        const list = Array.from(orders.values());
        return json(200, {
          orders: list,
          page: 1,
          pageSize: 24,
          total: list.length,
          nextCursor: null,
        });
      }

      const orderMatch = /^\/orders\/([^/]+)$/.exec(path);
      if (method === 'GET' && orderMatch) {
        const id = decodeURIComponent(orderMatch[1]);
        const order = orders.get(id);
        if (!order || order.invoice?.settlementStatus === 'draft') {
          return json(404, { code: 'not_found', error: 'order not found' });
        }
        return json(200, order);
      }

      const refMatch = /^\/orders\/([^/]+)\/accounting-ref$/.exec(path);
      if (method === 'POST' && refMatch) {
        const id = decodeURIComponent(refMatch[1]);
        const key = headers['idempotency-key'];
        if (!key) return json(400, { code: 'bad_request', error: 'Idempotency-Key header is required' });

        let body;
        try {
          body = JSON.parse(init.body);
        } catch {
          return json(400, { code: 'bad_request', error: 'invalid JSON body' });
        }
        const extraKeys = Object.keys(body ?? {}).filter((k) => k !== 'externalAccountingRef');
        if (
          !body ||
          extraKeys.length > 0 ||
          typeof body.externalAccountingRef !== 'string' ||
          !ACCOUNTING_REF_RE.test(body.externalAccountingRef)
        ) {
          return json(400, { code: 'bad_request', error: 'invalid externalAccountingRef' });
        }

        const bodyHash = createHash('sha256')
          .update(JSON.stringify({ orderId: id, externalAccountingRef: body.externalAccountingRef }))
          .digest('hex');
        const cached = idempotency.get(key);
        if (cached) {
          if (cached.bodyHash !== bodyHash) {
            return json(409, { code: 'idempotency_conflict', error: 'Idempotency-Key reused with a different request' });
          }
          return json(200, cached.response);
        }

        const order = orders.get(id);
        if (!order || !order.invoice || order.invoice.settlementStatus === 'draft') {
          return json(404, { code: 'not_found', error: 'order not found' });
        }
        if (
          order.invoice.externalAccountingRef &&
          order.invoice.externalAccountingRef !== body.externalAccountingRef
        ) {
          return json(409, {
            code: 'accounting_ref_conflict',
            error: 'order already carries a different external accounting reference',
          });
        }

        order.invoice.externalAccountingRef = body.externalAccountingRef;
        const response = {
          orderId: order.id,
          invoiceNumber: order.invoice.invoiceNumber,
          externalAccountingRef: body.externalAccountingRef,
        };
        idempotency.set(key, { bodyHash, response });
        return json(200, response);
      }

      return json(404, { code: 'not_found', error: 'not_found' });
    },
  };
}

export async function runSelfTest() {
  const providersTested = [];

  for (const provider of ['QBO', 'XERO', 'NS']) {
    const sim = createSimulatedAccountingGateway();
    sim.seedInvoiceOrder({
      id: 'ord_manual_1042',
      status: 'created',
      currency: 'USD',
      customerHash: '9a7f2c4e8b1d60336a2f0c1e7d4b8395f0a1c2d3e4f5061728394a5b6c7d8e9',
      subtotal: 240.0,
      total: 255.0,
      createdAt: '2026-11-25T16:00:00.000Z',
      lineItems: [
        { sku: 'VAPE-KIT-STARTER', handle: 'starter-kit', quantity: 4, lineTotal: 200.0 },
        { sku: 'CUSTOM-DISPLAY-RACK', quantity: 1, lineTotal: 40.0 },
      ],
      invoice: {
        invoiceNumber: 'INV-000104',
        quoteId: 'bq_11111111111111111111111111111111',
        settlementMode: 'net_terms',
        settlementStatus: 'issued',
        netTermsDays: 30,
        dueAt: '2026-12-25T16:00:00.000Z',
      },
    });

    const connector = createAccountingErpConnector({
      baseUrl: 'https://tot-preview.tokenoftrust.store',
      accessToken: 'sim-erp-token',
      erpProvider: provider,
      fetchImpl: sim.fetchImpl,
    });

    // 1. Process order.invoiced -> hydrates order, maps to ERP, writes back externalAccountingRef
    const invoiced = await connector.handleOrderInvoicedWebhook(SAMPLE_INVOICED_EVENT);
    assert.equal(invoiced.duplicate, false);
    assert.equal(invoiced.writeback.status, 200);
    assert.equal(invoiced.externalAccountingRef, `${provider}:INV-000104`);

    // 2. Verify GET /orders/{id} now reflects externalAccountingRef
    const hydrated = await connector.getOrder('ord_manual_1042');
    assert.equal(hydrated.body.invoice.externalAccountingRef, `${provider}:INV-000104`);

    // 3. Verify idempotent replay of the exact same writeback returns 200
    const replay = await connector.writeAccountingRef('ord_manual_1042', `${provider}:INV-000104`);
    assert.equal(replay.status, 200);

    // 4. Verify writing a conflicting reference returns 409 accounting_ref_conflict
    const conflict = await connector.writeAccountingRef('ord_manual_1042', `${provider}:INV-999999`, {
      idempotencyKey: `conflict-key-${provider}`,
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'accounting_ref_conflict');

    // 5. Process invoice.settled -> maps payment against the recorded externalAccountingRef
    const settled = await connector.handleInvoiceSettledWebhook(SAMPLE_SETTLED_EVENT);
    assert.equal(settled.duplicate, false);
    assert.equal(settled.externalAccountingRef, `${provider}:INV-000104`);

    providersTested.push(provider);
  }

  return {
    ok: true,
    providersTested,
    invoiceNumber: 'INV-000104',
  };
}

if (process.argv.includes('--self-test') || import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runSelfTest();
  console.log(JSON.stringify({ event: 'accounting-erp-sync:self-test:passed', ...summary }));
}
