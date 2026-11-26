import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildCanonicalErpInvoice,
  createAccountingErpConnector,
  createAccountingWebhookReceiver,
  createSimulatedAccountingGateway,
  ERP_ADAPTERS,
  runSelfTest,
} from '../index.mjs';

test('accounting-erp-sync manifest declares least-privilege invoice scopes and private_key_jwt clientAuth', () => {
  const manifest = JSON.parse(readFileSync(new URL('../tot-app.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contractVersion, '1');
  assert.deepEqual(manifest.scopes, ['orders:read-minimal', 'orders:webhook', 'orders:write-accounting-ref']);
  assert.deepEqual(manifest.webhooks.topics, ['order.invoiced', 'invoice.settled']);
  assert.equal(manifest.clientAuth.method, 'private_key_jwt');
  assert.match(manifest.clientAuth.jwksUri, /^https:\/\//);
});

test('self-test exercises QBO, XERO, and NS adapters, idempotent POST /orders/{id}/accounting-ref writeback, 200 replay, and 409 conflict handling', async () => {
  const result = await runSelfTest();
  assert.equal(result.ok, true);
  assert.deepEqual(result.providersTested, ['QBO', 'XERO', 'NS']);
  assert.equal(result.invoiceNumber, 'INV-000104');
});

test('duplicate order.invoiced and invoice.settled CloudEvent ids are deduplicated without double-writing', async () => {
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
    baseUrl: 'https://storefront.tokenoftrust.store',
    tenant: 'acme',
    accessToken: 'sim-erp-token',
    erpProvider: 'QBO',
    fetchImpl: sim.fetchImpl,
  });

  const invoicedFixture = JSON.parse(
    readFileSync(new URL('../fixtures/order.invoiced.cloudevent.json', import.meta.url), 'utf8'),
  );
  const firstInvoiced = await connector.handleOrderInvoicedWebhook(invoicedFixture);
  assert.equal(firstInvoiced.duplicate, false);
  assert.equal(firstInvoiced.externalAccountingRef, 'QBO:INV-000104');

  const secondInvoiced = await connector.handleOrderInvoicedWebhook(invoicedFixture);
  assert.equal(secondInvoiced.duplicate, true);
  assert.equal(secondInvoiced.externalAccountingRef, null);

  const settledFixture = JSON.parse(
    readFileSync(new URL('../fixtures/invoice.settled.cloudevent.json', import.meta.url), 'utf8'),
  );
  const firstSettled = await connector.handleInvoiceSettledWebhook(settledFixture);
  assert.equal(firstSettled.duplicate, false);
  assert.equal(firstSettled.externalAccountingRef, 'QBO:INV-000104');

  const secondSettled = await connector.handleInvoiceSettledWebhook(settledFixture);
  assert.equal(secondSettled.duplicate, true);
  assert.equal(secondSettled.settlementPayload, null);
});

test('QBO, XERO, and NS adapters produce PII-free ERP payloads with freight line and customerHash reference', () => {
  const invoicedFixture = JSON.parse(
    readFileSync(new URL('../fixtures/order.invoiced.cloudevent.json', import.meta.url), 'utf8'),
  );
  const canonical = buildCanonicalErpInvoice({
    eventData: invoicedFixture.data,
    order: {
      id: 'ord_manual_1042',
      customerHash: '9a7f2c4e8b1d60336a2f0c1e7d4b8395f0a1c2d3e4f5061728394a5b6c7d8e9',
      invoice: {
        invoiceNumber: 'INV-000104',
        quoteId: 'bq_11111111111111111111111111111111',
        settlementMode: 'net_terms',
        settlementStatus: 'issued',
        netTermsDays: 30,
        dueAt: '2026-12-25T16:00:00.000Z',
      },
    },
  });
  assert.equal(canonical.freightAmount, 15);

  const qbo = ERP_ADAPTERS.QBO.mapInvoice(canonical);
  assert.equal(qbo.DocNumber, 'INV-000104');
  assert.equal(qbo.CustomerRef.value, 'cust_9a7f2c4e8b1d6033');
  assert.equal(qbo.Line.length, 3);

  const xero = ERP_ADAPTERS.XERO.mapInvoice(canonical);
  assert.equal(xero.InvoiceNumber, 'INV-000104');
  assert.equal(xero.Contact.ContactNumber, 'tot_9a7f2c4e8b1d6033');
  assert.equal(xero.LineItems.length, 3);

  const ns = ERP_ADAPTERS.NS.mapInvoice(canonical);
  assert.equal(ns.tranId, 'INV-000104');
  assert.equal(ns.shippingCost, 15);
  assert.equal(ns.item.items.length, 2);
});

test('an unsigned delivery is refused by the kit receiver and never reaches the accounting connector', async () => {
  const sim = createSimulatedAccountingGateway();
  const connector = createAccountingErpConnector({
    baseUrl: 'https://storefront.tokenoftrust.store',
    tenant: 'acme',
    accessToken: 'sim-erp-token',
    fetchImpl: sim.fetchImpl,
  });
  const fixture = readFileSync(new URL('../fixtures/order.invoiced.cloudevent.json', import.meta.url), 'utf8');
  const receiver = createAccountingWebhookReceiver({
    origin: 'https://storefront.tokenoftrust.store',
    endpoint: 'https://erp.integrations.example.com/webhooks/tot-invoices',
    connector,
  });
  const res = await receiver.handleRequest(
    new Request('https://erp.integrations.example.com/webhooks/tot-invoices', {
      method: 'POST',
      body: fixture,
    }),
  );
  assert.equal(res.status, 400);
  assert.equal(connector.getSyncedInvoice('ord_manual_1042'), null);
});
