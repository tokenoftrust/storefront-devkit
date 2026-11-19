#!/usr/bin/env node
// Label station starter (e.g. ShipStation). `npm run label-station`
//
// Flow per Storefront assignment:
//   fulfillment.assignment.created webhook (or the safety-net poll)
//   -> GET /fulfillment/assignments            what to ship, allowed carriers, adult signature?
//   -> GET /fulfillment/orders/{id}/recipient  ship-to, in memory only, never logged
//   -> label provider: create order + create label
//   -> POST shipment-evidence label-outcome    label purchased (carrier, tracking, adultSignature)
//   -> carrier pickup (SHIP_NOTIFY; the mock fires it after MOCK_PICKUP_SECONDS)
//   -> POST shipment-evidence handoff          Storefront marks the order fulfilled
//
// MOCK_VOID_FIRST=1 voids the first label and buys a replacement (the label-voided path).
import { deriveIdempotencyKey } from '../../vendor/connector-kit/index.js';
import { loadConfig } from '../../core/config.mjs';
import { log, logError } from '../../core/log.mjs';
import { startWebhookServer } from '../../core/server.mjs';
import { createTot } from '../../core/tot.mjs';
import { startMockLabelProvider } from './mock-label-provider.mjs';

const cfg = loadConfig('label-station');
const tot = createTot(cfg);
const pollSeconds = Number(cfg.env.POLL_SECONDS || 30);
const pickupSeconds = Number(cfg.env.MOCK_PICKUP_SECONDS || 5);
const voidFirst = cfg.env.MOCK_VOID_FIRST === '1';

// Storefront carrier code -> provider carrier + default service. Storefront service codes are UPPERCASE.
const CARRIER_MAP = {
  UPS: { carrierCode: 'ups', serviceCode: 'ups_ground', service: 'GROUND', trackingUrl: (n) => `https://www.ups.com/track?tracknum=${n}` },
  FEDEX: { carrierCode: 'fedex', serviceCode: 'fedex_ground', service: 'GROUND', trackingUrl: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
};

// ---- label provider client (mock by default; set PROVIDER_API_URL + key/secret for the real API) ----
const providerBase = cfg.env.PROVIDER_API_URL || `http://127.0.0.1:${cfg.mockPort}`;
const providerAuth = cfg.env.PROVIDER_API_KEY ? `Basic ${Buffer.from(`${cfg.env.PROVIDER_API_KEY}:${cfg.env.PROVIDER_API_SECRET}`).toString('base64')}` : undefined;
async function provider(method, path, body) {
  const res = await fetch(`${providerBase}${path}`, { method, headers: { 'content-type': 'application/json', ...(providerAuth ? { authorization: providerAuth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`provider ${method} ${path} -> ${res.status} ${json.Message ?? ''}`), { code: 'provider_error', status: res.status });
  return json;
}

// ---- state (in memory; a real app persists this) ----
const work = new Map(); // assignmentId -> { orderId, purchaseId, shipment, stage }
const evidence = async (orderId, body, step) =>
  tot.call('POST', `/fulfillment/orders/${encodeURIComponent(orderId)}/shipment-evidence`, {
    body,
    idempotencyKey: await deriveIdempotencyKey('ss', body.assignmentId, body.purchaseId, step),
  });

async function buyLabel(a, w, recipient, attempt) {
  const pick = a.allowedCarriers.map((c) => [c, CARRIER_MAP[c]]).find(([, m]) => m);
  if (!pick) {
    log('label-station.no_mapped_carrier', { assignmentId: a.assignmentId, allowedCarriers: a.allowedCarriers });
    return false;
  }
  const [carrier, m] = pick;
  const order = await provider('POST', '/orders/createorder', {
    orderNumber: a.orderId,
    orderStatus: 'awaiting_shipment',
    shipTo: recipient, // in memory only
    items: a.lines.map((l) => ({ sku: l.sku, quantity: l.remaining })),
  });
  const label = await provider('POST', '/orders/createlabelfororder', {
    orderId: order.orderId,
    carrierCode: m.carrierCode,
    serviceCode: m.serviceCode,
    confirmation: a.adultSignatureRequired ? 'adult_signature' : 'none',
    testLabel: true,
  });
  const r = await evidence(a.orderId, {
    kind: 'label-outcome',
    assignmentId: a.assignmentId,
    purchaseId: w.purchaseId,
    outcome: 'purchased',
    carrier,
    service: m.service,
    trackingNumber: label.trackingNumber,
    trackingUrl: m.trackingUrl(label.trackingNumber),
    // The station attests the adult-signature service was bought on the label.
    adultSignature: a.adultSignatureRequired ? 'accepted' : 'absent',
  }, `label-${attempt}`);
  log('storefront.label_outcome', { orderId: a.orderId, status: r.status, code: r.body?.code, label: r.body?.label, carrier, requestId: r.requestId });
  if (!r.ok) return false;
  w.shipment = { ...label, carrier };
  return true;
}

async function processAssignment(a) {
  if (work.has(a.assignmentId)) return;
  const w = { orderId: a.orderId, purchaseId: a.purchaseId, stage: 'new' };
  work.set(a.assignmentId, w);
  try {
    log('assignment.start', { assignmentId: a.assignmentId, orderId: a.orderId, allowedCarriers: a.allowedCarriers, adultSignatureRequired: a.adultSignatureRequired, lines: a.lines });
    const rec = await tot.call('GET', `/fulfillment/orders/${encodeURIComponent(a.orderId)}/recipient`);
    if (!rec.ok) throw Object.assign(new Error('recipient read refused'), { code: rec.body?.code, status: rec.status, requestId: rec.requestId });
    const { orderId: _ignored, ...recipient } = rec.body;

    if (!(await buyLabel(a, w, recipient, 1))) throw Object.assign(new Error('label not recorded'), { code: 'label_failed' });

    if (voidFirst) {
      await provider('POST', '/shipments/voidlabel', { shipmentId: w.shipment.shipmentId });
      const v = await evidence(a.orderId, { kind: 'label-voided', assignmentId: a.assignmentId, purchaseId: w.purchaseId }, 'void');
      log('storefront.label_voided', { orderId: a.orderId, status: v.status, code: v.body?.code, nextPurchaseId: v.body?.purchaseId });
      if (!v.ok) throw Object.assign(new Error('void refused'), { code: v.body?.code });
      w.purchaseId = v.body.purchaseId; // the replacement label is reported under the new attempt's id
      if (!(await buyLabel(a, w, recipient, 2))) throw Object.assign(new Error('replacement label not recorded'), { code: 'label_failed' });
    }

    w.stage = 'labelled';
    if (!cfg.env.PROVIDER_API_URL) {
      setTimeout(() => fetch(`${providerBase}/_mock/pickup/${w.shipment.shipmentId}`, { method: 'POST' }).catch((e) => logError('mock.pickup', e)), pickupSeconds * 1000);
    }
  } catch (err) {
    logError('assignment.failed', err, { assignmentId: a.assignmentId, orderId: a.orderId });
    work.delete(a.assignmentId); // retried on the next poll
  }
}

async function onShipNotify(shipment) {
  const entry = [...work.entries()].find(([, w]) => w.shipment?.shipmentId === shipment.shipmentId);
  if (!entry) return;
  const [assignmentId, w] = entry;
  const r = await evidence(w.orderId, { kind: 'handoff', assignmentId, purchaseId: w.purchaseId, carrier: w.shipment.carrier }, 'handoff');
  log('storefront.handoff', { orderId: w.orderId, status: r.status, code: r.body?.code, handoff: r.body?.handoff, requestId: r.requestId });
  if (r.ok) w.stage = 'handed_off';
}

let reconciling = null;
function reconcile(reason) {
  reconciling ??= (async () => {
    const r = await tot.call('GET', '/fulfillment/assignments');
    if (!r.ok) return log('assignments.read_failed', { status: r.status, code: r.body?.code, requestId: r.requestId });
    if (r.body.assignments.length || reason !== 'poll') log('assignments.reconcile', { reason, count: r.body.assignments.length });
    for (const a of r.body.assignments) await processAssignment(a);
  })()
    .catch((e) => logError('reconcile.error', e))
    .finally(() => (reconciling = null));
  return reconciling;
}

if (!cfg.env.PROVIDER_API_URL) await startMockLabelProvider({ port: cfg.mockPort, onShipNotify: (s) => onShipNotify(s).catch((e) => logError('ship_notify', e)) });
log('label-station.ready', { provider: cfg.env.PROVIDER_API_URL ? 'real API' : `mock on ${providerBase}`, tenant: cfg.tenant, installId: cfg.installId });

if (cfg.webhookEndpoint) {
  startWebhookServer({
    cfg,
    tot,
    handlers: {
      // Ack fast; the work runs after the 202 (the poll catches anything that fails).
      'fulfillment.assignment.created': async () => void reconcile('webhook'),
      'fulfillment.assignment.updated': async (e) => log('assignment.updated', { assignmentId: e.data.assignmentId, state: e.data.state }),
      'fulfillment.label.voided': async (e) => log('label.voided.event', { data: e.data }),
      'order.fulfilled': async (e) => log('order.fulfilled.event', { data: e.data }),
    },
  });
} else {
  log('webhooks.off', { hint: 'set WEBHOOK_PUBLIC_URL (README "Tunnel"); polling only' });
}

reconcile('startup');
setInterval(() => reconcile('poll'), pollSeconds * 1000);
