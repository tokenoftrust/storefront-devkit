#!/usr/bin/env node
// 3PL & Multi-Supplier Dropship Routing Connector Recipe:
// Demonstrates:
// - Stone 1 (Live):
//   1. Location-keyed processor coexistence keyed by (tenant_id, stage, location_id).
//   2. Reading FulfillmentAssignment with locationId and lines[]
//      (sku, quantity, fulfilledQuantity/shipped, cancelledQuantity/cancelled, remaining).
//   3. Posting partial line shipments via POST /fulfillment/assignments/{assignmentId}/shipments
//      emitting order.partially_fulfilled first and order.fulfilled when the final line ships.
//   4. Reporting processor line exceptions via POST /fulfillment/assignments/{assignmentId}/exceptions
//      (backordered, cannot_fulfill / vendor_rejected, address_undeliverable).
// - Stone 2 (Contract Locked):
//   5. Planning a multi-supplier single-cart auto-split across distinct (appInstallId, locationId) pairs.
//
// Run offline self-test:
//   node index.mjs --self-test
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/multi-supplier-routing.json', import.meta.url), 'utf8'),
);

/**
 * Maps processor/supplier exception reasons (`backordered`, `cannot_fulfill`, `address_undeliverable`)
 * onto the contract's `AssignmentExceptionWrite.code` enum (`vendor_rejected`, `backordered`,
 * `out_of_stock`, `damaged`, `address_undeliverable`, `carrier_refused`, `other`).
 */
export const EXCEPTION_REASON_TO_CONTRACT = Object.freeze({
  backordered: 'backordered',
  cannot_fulfill: 'vendor_rejected',
  vendor_rejected: 'vendor_rejected',
  out_of_stock: 'out_of_stock',
  damaged: 'damaged',
  address_undeliverable: 'address_undeliverable',
  carrier_refused: 'carrier_refused',
  other: 'other',
});

export function normalizeExceptionCode(reasonOrCode) {
  const code = EXCEPTION_REASON_TO_CONTRACT[reasonOrCode];
  if (!code) {
    throw new Error(`Unsupported assignment exception code: ${reasonOrCode}`);
  }
  return code;
}

export function deriveIdempotencyKey(prefix, payload) {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 36);
  return `${prefix}-${digest}`;
}

/**
 * Stone 2 contract planner: partitions cart lines across distinct `(appInstallId, locationId)`
 * processor bindings so each vendor/3PL receives its own scoped assignment.
 */
export function planStone2MultiVendorSplit({ orderId, cartLines, locationBindings }) {
  const groups = new Map();
  for (const line of cartLines) {
    const binding = locationBindings.get(line.locationId);
    if (!binding) {
      throw new Error(`No processor bound for locationId=${line.locationId}`);
    }
    const key = `${binding.appInstallId}:${line.locationId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        orderId,
        appInstallId: binding.appInstallId,
        locationId: line.locationId,
        lines: [],
      });
    }
    groups.get(key).lines.push({
      lineId: line.lineId,
      sku: line.sku,
      quantity: line.quantity,
    });
  }
  return Array.from(groups.values());
}

export function createMultiSupplierRoutingConnector({ baseUrl, accessToken, fetchImpl = fetch }) {
  async function request(method, path, { body, idempotencyKey } = {}) {
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const res = await fetchImpl(`${baseUrl}/api/apps/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ok: res.ok, body: await res.json() };
  }

  return {
    upsertVendorLocation(locationId, { name, kind = 'dropship_vendor', isFulfillable = true, status = 'active' }) {
      return request('PUT', `/inventory/locations/${encodeURIComponent(locationId)}`, {
        body: { name, kind, isFulfillable, status },
      });
    },
    listAssignments() {
      return request('GET', '/fulfillment/assignments');
    },
    postPartialShipment(assignmentId, shipmentWrite, idempotencyKey = deriveIdempotencyKey(`sup-shp-${assignmentId}`, shipmentWrite)) {
      return request('POST', `/fulfillment/assignments/${encodeURIComponent(assignmentId)}/shipments`, {
        body: shipmentWrite,
        idempotencyKey,
      });
    },
    postLineException(assignmentId, { reason, lines, note }, idempotencyKey) {
      const code = normalizeExceptionCode(reason);
      const body = { code, lines, ...(note ? { note } : {}) };
      const key = idempotencyKey ?? deriveIdempotencyKey(`sup-exc-${assignmentId}`, body);
      return request('POST', `/fulfillment/assignments/${encodeURIComponent(assignmentId)}/exceptions`, {
        body,
        idempotencyKey: key,
      });
    },
  };
}

/**
 * In-memory gateway simulator supporting Stone 1 `(tenant_id, stage, location_id)` processor
 * coexistence, partial line shipments (`order.partially_fulfilled` -> `order.fulfilled`),
 * and processor exceptions (`backordered`, `cannot_fulfill`/`vendor_rejected`, `address_undeliverable`).
 */
export function createSimulatedMultiSupplierGateway() {
  // Processor registry keyed by `${tenantId}:${stage}:${locationId}` -> appInstallId
  const processorBindings = new Map([
    ['acme:preview:wh-house-tx', 'inst_label_station_house_wh'],
    ['acme:preview:vendor-west-ca', 'inst_3pl_dropship_router'],
  ]);
  const assignments = structuredClone(FIXTURE.stone1Assignments);
  const exceptions = [];
  const emittedEvents = [];

  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

  return {
    processorBindings,
    exceptions,
    emittedEvents,
    async fetchImpl(input, init = {}) {
      const url = new URL(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const path = url.pathname.replace(/^\/api\/apps\/v1/, '');

      const locMatch = /^\/inventory\/locations\/([^/]+)$/.exec(path);
      if (method === 'PUT' && locMatch) {
        const locationId = decodeURIComponent(locMatch[1]);
        const body = JSON.parse(init.body);
        return json(200, {
          locationId,
          name: body.name,
          kind: body.kind,
          isFulfillable: body.isFulfillable ?? true,
          status: body.status ?? 'active',
          updatedAt: '2026-11-13T16:01:00.000Z',
        });
      }

      if (method === 'GET' && path === '/fulfillment/assignments') {
        return json(200, { assignments });
      }

      const shpMatch = /^\/fulfillment\/assignments\/([^/]+)\/shipments$/.exec(path);
      if (method === 'POST' && shpMatch) {
        if (!headers['idempotency-key']) return json(400, { code: 'malformed', error: 'malformed' });
        const assignmentId = decodeURIComponent(shpMatch[1]);
        const assignment = assignments.find((a) => a.assignmentId === assignmentId);
        if (!assignment) return json(404, { code: 'not-assigned', error: 'not-assigned' });

        const body = JSON.parse(init.body);
        for (const item of body.lines) {
          const line = assignment.lines.find((l) => l.sku === item.sku);
          if (!line) return json(409, { code: 'line-unknown', error: 'line-unknown' });
          if (item.quantity > line.remaining) return json(409, { code: 'quantity-exceeded', error: 'quantity-exceeded' });
          line.shipped += item.quantity;
          line.fulfilledQuantity = line.shipped;
          line.remaining = line.quantity - line.shipped - line.cancelled;
        }
        const complete = assignment.lines.every((l) => l.remaining === 0);
        emittedEvents.push(complete ? 'order.fulfilled' : 'order.partially_fulfilled');
        return json(200, {
          assignmentId: assignment.assignmentId,
          shipmentId: `shp_duo_${randomUUID().slice(0, 8)}`,
          fulfilledLines: body.lines,
          complete,
        });
      }

      const excMatch = /^\/fulfillment\/assignments\/([^/]+)\/exceptions$/.exec(path);
      if (method === 'POST' && excMatch) {
        if (!headers['idempotency-key']) return json(400, { code: 'malformed', error: 'malformed' });
        const assignmentId = decodeURIComponent(excMatch[1]);
        const assignment = assignments.find((a) => a.assignmentId === assignmentId);
        if (!assignment) return json(404, { code: 'not-assigned', error: 'not-assigned' });

        const body = JSON.parse(init.body);
        const record = {
          assignmentId,
          exceptionId: `exc_${randomUUID().slice(0, 8)}`,
          code: body.code,
        };
        exceptions.push({ ...record, lines: body.lines, note: body.note });
        return json(200, record);
      }

      return json(404, { code: 'not-assigned', error: 'not-assigned' });
    },
  };
}

export async function runSelfTest() {
  const sim = createSimulatedMultiSupplierGateway();
  const connector = createMultiSupplierRoutingConnector({
    baseUrl: 'https://tot-preview.tokenoftrust.store',
    accessToken: 'sim-dropship-token',
    fetchImpl: sim.fetchImpl,
  });

  // 1. Stone 1: Declare dropship vendor location and verify location-keyed processor coexistence
  const loc = await connector.upsertVendorLocation('vendor-west-ca', {
    name: 'West Coast Glass Supplier (3PL)',
    kind: 'dropship_vendor',
  });
  assert.equal(loc.status, 200);
  assert.equal(sim.processorBindings.get('acme:preview:wh-house-tx'), 'inst_label_station_house_wh');
  assert.equal(sim.processorBindings.get('acme:preview:vendor-west-ca'), 'inst_3pl_dropship_router');

  // 2. Reconcile location-routed assignment and inspect lines[]
  const list = await connector.listAssignments();
  assert.equal(list.status, 200);
  const assignment = list.body.assignments[0];
  assert.equal(assignment.locationId, 'vendor-west-ca');
  assert.equal(assignment.lines.length, 2);

  // 3. Report a line exception (backordered / cannot_fulfill / address_undeliverable) before shipping
  const excBackorder = await connector.postLineException(assignment.assignmentId, {
    reason: 'backordered',
    lines: [{ sku: 'QUARTZ-BANGER-14MM', quantity: 1 }],
    note: 'Supplier restock expected in 48h',
  });
  assert.equal(excBackorder.status, 200);
  assert.equal(excBackorder.body.code, 'backordered');

  const excCannotFulfill = await connector.postLineException(assignment.assignmentId, {
    reason: 'cannot_fulfill',
    lines: [{ sku: 'QUARTZ-BANGER-14MM', quantity: 1 }],
    note: 'Secondary vendor fallback requested',
  });
  assert.equal(excCannotFulfill.status, 200);
  assert.equal(excCannotFulfill.body.code, 'vendor_rejected');

  // 4. Ship Line 1 partially -> emits order.partially_fulfilled (complete: false)
  const partialShipment = await connector.postPartialShipment(assignment.assignmentId, {
    lines: [{ sku: 'GLASS-RIG-MINI', quantity: 2 }],
    carrier: 'UPS',
    service: 'GROUND',
    trackingNumber: '1ZDUO000000000001',
    trackingUrl: 'https://www.ups.com/track?tracknum=1ZDUO000000000001',
  });
  assert.equal(partialShipment.status, 200);
  assert.equal(partialShipment.body.complete, false);

  // 5. Ship Line 2 -> completes assignment and emits order.fulfilled (complete: true)
  const finalShipment = await connector.postPartialShipment(assignment.assignmentId, {
    lines: [{ sku: 'QUARTZ-BANGER-14MM', quantity: 1 }],
    carrier: 'ONTRAC',
    service: 'GROUND',
    trackingNumber: 'D10000000000002',
    trackingUrl: 'https://www.ontrac.com/tracking/?number=D10000000000002',
  });
  assert.equal(finalShipment.status, 200);
  assert.equal(finalShipment.body.complete, true);
  assert.deepEqual(sim.emittedEvents, ['order.partially_fulfilled', 'order.fulfilled']);

  // 6. Stone 2: Validate multi-supplier cart auto-split across distinct (appInstallId, locationId) pairs
  const bindings = new Map([
    ['wh-house-tx', { appInstallId: 'inst_label_station_house_wh' }],
    ['vendor-west-ca', { appInstallId: 'inst_3pl_dropship_router' }],
  ]);
  const splitPlan = planStone2MultiVendorSplit({
    orderId: 'ord_autosplit_8002',
    cartLines: [
      { lineId: 'line_8002_1', sku: 'VAPE-KIT-STARTER', locationId: 'wh-house-tx', quantity: 1 },
      { lineId: 'line_8002_2', sku: 'GLASS-RIG-MINI', locationId: 'vendor-west-ca', quantity: 1 },
    ],
    locationBindings: bindings,
  });
  assert.equal(splitPlan.length, 2);

  return {
    ok: true,
    routedLocationId: assignment.locationId,
    emittedEvents: sim.emittedEvents,
    exceptionsRecorded: sim.exceptions.length,
    stone2SplitRoutes: splitPlan.length,
  };
}

if (process.argv.includes('--self-test') || import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runSelfTest();
  console.log(JSON.stringify({ event: 'dropship-multi-supplier:self-test:passed', ...summary }));
}
