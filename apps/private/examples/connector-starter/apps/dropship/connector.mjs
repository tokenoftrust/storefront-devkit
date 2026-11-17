#!/usr/bin/env node
// Dropship starter (e.g. Duoplane). `npm run dropship`
//
// Flow per Storefront assignment:
//   fulfillment.assignment.created webhook (or the safety-net poll)
//   -> GET /fulfillment/assignments            lines, allowed carriers, adult signature?
//   -> GET /fulfillment/orders/{id}/recipient  ship-to, in memory only, never logged
//   -> dropship platform: create a purchase order for the supplier
//   -> poll the purchase order; for each supplier shipment:
//        POST /fulfillment/assignments/{id}/shipments   (per line; partial -> order.partially_fulfilled, last -> order.fulfilled)
//      for each backorder, or a carrier Storefront refuses:
//        POST /fulfillment/assignments/{id}/exceptions  (the merchant desk resolves it; nothing is cancelled)
import { deriveIdempotencyKey } from '../../vendor/connector-kit/index.js';
import { loadConfig } from '../../core/config.mjs';
import { log, logError } from '../../core/log.mjs';
import { startWebhookServer } from '../../core/server.mjs';
import { createTot } from '../../core/tot.mjs';
import { startMockDropshipPlatform } from './mock-dropship-platform.mjs';

const cfg = loadConfig('dropship');
const tot = createTot(cfg);
const pollSeconds = Number(cfg.env.POLL_SECONDS || 15);

const TRACKING_URL = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${n}`,
  FEDEX: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
};

// ---- dropship platform client (mock by default) ----
const providerBase = cfg.env.PROVIDER_API_URL || `http://127.0.0.1:${cfg.mockPort}`;
async function provider(method, path, body) {
  const res = await fetch(`${providerBase}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`provider ${method} ${path} -> ${res.status} ${json.error ?? ''}`), { code: 'provider_error', status: res.status });
  return json;
}

// ---- state (in memory; a real app persists this) ----
const work = new Map(); // assignmentId -> { orderId, poId, reported:Set<shipmentId|backorder sku>, adultSignatureRequired }

async function startAssignment(a) {
  if (work.has(a.assignmentId)) return;
  const w = { orderId: a.orderId, poId: null, reported: new Set(), adultSignatureRequired: a.adultSignatureRequired };
  work.set(a.assignmentId, w);
  try {
    log('assignment.start', { assignmentId: a.assignmentId, orderId: a.orderId, locationId: a.locationId, lines: a.lines });
    const rec = await tot.call('GET', `/fulfillment/orders/${encodeURIComponent(a.orderId)}/recipient`);
    if (!rec.ok) throw Object.assign(new Error('recipient read refused'), { code: rec.body?.code, status: rec.status, requestId: rec.requestId });
    const { orderId: _ignored, ...shipTo } = rec.body;
    const po = await provider('POST', '/purchase_orders', {
      order_reference: a.orderId,
      shipping_address: shipTo, // in memory only
      items: a.lines.filter((l) => l.remaining > 0).map((l) => ({ sku: l.sku, quantity: l.remaining })),
      notes: a.adultSignatureRequired ? 'ADULT SIGNATURE (21+) REQUIRED' : undefined,
    });
    w.poId = po.id;
    log('provider.po_created', { orderId: a.orderId, poId: po.id });
  } catch (err) {
    logError('assignment.failed', err, { assignmentId: a.assignmentId, orderId: a.orderId });
    work.delete(a.assignmentId); // retried on the next poll
  }
}

async function reportException(assignmentId, w, key, code, lines, note) {
  const r = await tot.call('POST', `/fulfillment/assignments/${encodeURIComponent(assignmentId)}/exceptions`, {
    body: { code, lines, note },
    idempotencyKey: await deriveIdempotencyKey('dp-exc', assignmentId, key),
  });
  log('storefront.exception', { orderId: w.orderId, code, status: r.status, refused: r.ok ? undefined : r.body?.code, requestId: r.requestId });
  if (r.ok) w.reported.add(key);
}

async function syncPurchaseOrder(assignmentId, w) {
  if (!w.poId) return;
  const po = await provider('GET', `/purchase_orders/${w.poId}`);
  for (const s of po.shipments) {
    const key = `ship-${s.id}`;
    if (w.reported.has(key)) continue;
    const body = {
      carrier: s.carrier,
      service: s.service,
      trackingNumber: s.tracking_number,
      trackingUrl: TRACKING_URL[s.carrier]?.(s.tracking_number),
      // The supplier attests the parcel was sent with adult signature on delivery.
      adultSignature: w.adultSignatureRequired ? 'accepted' : 'absent',
      lines: s.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    };
    if (!body.trackingUrl) delete body.trackingUrl;
    const r = await tot.call('POST', `/fulfillment/assignments/${encodeURIComponent(assignmentId)}/shipments`, {
      body,
      idempotencyKey: await deriveIdempotencyKey('dp-ship', assignmentId, s.id),
    });
    log('storefront.shipment', { orderId: w.orderId, supplierShipment: s.id, carrier: s.carrier, status: r.status, code: r.body?.code, complete: r.body?.complete, requestId: r.requestId });
    if (r.ok) w.reported.add(key);
    else if (r.body?.code === 'carrier-prohibited' || r.body?.code === 'adult-signature') {
      // Storefront refused the supplier's shipment (compliance). Tell the merchant; don't retry forever.
      await reportException(assignmentId, w, key, 'carrier_refused', body.lines, `supplier shipped with ${s.carrier}; Storefront refused: ${r.body.code}`);
    }
  }
  for (const b of po.backorders) {
    const key = `bo-${b.sku}`;
    if (!w.reported.has(key)) await reportException(assignmentId, w, key, 'backordered', [{ sku: b.sku, quantity: b.quantity }], 'supplier backorder');
  }
}

let busy = null;
function reconcile(reason) {
  busy ??= (async () => {
    const r = await tot.call('GET', '/fulfillment/assignments');
    if (!r.ok) return log('assignments.read_failed', { status: r.status, code: r.body?.code, requestId: r.requestId });
    if (r.body.assignments.length || reason !== 'poll') log('assignments.reconcile', { reason, count: r.body.assignments.length });
    for (const a of r.body.assignments) await startAssignment(a);
    const active = new Set(r.body.assignments.map((a) => a.assignmentId));
    for (const [assignmentId, w] of work) {
      await syncPurchaseOrder(assignmentId, w);
      if (!active.has(assignmentId) && w.poId) work.delete(assignmentId); // assignment closed (fully shipped or cancelled)
    }
  })()
    .catch((e) => logError('reconcile.error', e))
    .finally(() => (busy = null));
  return busy;
}

if (!cfg.env.PROVIDER_API_URL) {
  await startMockDropshipPlatform({
    port: cfg.mockPort,
    shipSeconds: Number(cfg.env.MOCK_SHIP_SECONDS || 8),
    backorder: cfg.env.MOCK_BACKORDER === '1',
    carrier: (cfg.env.MOCK_SUPPLIER_CARRIER || 'UPS').toUpperCase(),
  });
}
log('dropship.ready', { provider: cfg.env.PROVIDER_API_URL ? 'real API' : `mock on ${providerBase}`, tenant: cfg.tenant, installId: cfg.installId });

if (cfg.webhookEndpoint) {
  startWebhookServer({
    cfg,
    tot,
    handlers: {
      'fulfillment.assignment.created': async () => void reconcile('webhook'),
      'fulfillment.assignment.updated': async (e) => log('assignment.updated', { assignmentId: e.data.assignmentId, state: e.data.state }),
      'order.partially_fulfilled': async (e) => log('order.partially_fulfilled.event', { data: e.data }),
      'order.fulfilled': async (e) => log('order.fulfilled.event', { data: e.data }),
    },
  });
} else {
  log('webhooks.off', { hint: 'set WEBHOOK_PUBLIC_URL (README "Tunnel"); polling only' });
}

reconcile('startup');
setInterval(() => reconcile('poll'), pollSeconds * 1000);
