#!/usr/bin/env node
// Label station starter (e.g. ShipStation). `npm run label-station`
//
// Flow per Storefront assignment:
//   startup: GET /fulfillment/carriers + provider carriers -> the carriers this station can buy
//   fulfillment.assignment.created webhook (or the safety-net poll)
//   -> GET /fulfillment/assignments            what to ship, allowed carriers, adult signature?
//   -> GET /fulfillment/orders/{id}/recipient  ship-to, in memory only, never logged or stored
//   -> label provider: create order + create label
//   -> POST shipment-evidence label-outcome    label purchased (carrier, tracking, adultSignature; what ShipStation's SHIP_NOTIFY signals)
//   -> carrier pickup / first carrier scan     (the mock fires it after MOCK_PICKUP_SECONDS; never report handoff on label creation alone)
//   -> POST shipment-evidence handoff          carrier accepted the parcel; Storefront marks the order fulfilled
//
// fulfillment.assignment.updated (Storefront -> station):
//   held       -> put the provider order on hold; no label is bought and no handoff is reported
//   active     -> hold cleared: restore the provider order and carry on
//   cancelled  -> void any unshipped label and cancel the provider order; nothing more is reported
//
// Progress lives in a StateStore (core/state.mjs, file-backed by default), so a restart never
// buys a second label for an order. MOCK_VOID_FIRST=1 voids the first label and buys a
// replacement (the label-voided path).
import { pathToFileURL } from 'node:url';
import { deriveIdempotencyKey } from '../../vendor/connector-kit/index.js';
import { log as defaultLog, logError } from '../../core/log.mjs';

/** Provider carrier code -> Storefront CarrierCode. Extend for your provider's codes. */
export const PROVIDER_TO_STOREFRONT = { ups: 'UPS', fedex: 'FEDEX', stamps_com: 'USPS', usps: 'USPS', dhl_express: 'DHL', ontrac: 'ONTRAC' };
/** Tracking page per Storefront carrier; used only when its host is on the catalog's trackingHosts. */
const TRACKING_URL = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${n}`,
  FEDEX: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
};
/** Storefront service code (UPPERCASE) for a provider service code: ups_ground -> GROUND. */
export const serviceFor = (serviceCode) => serviceCode.replace(/^[a-z]+_/, '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40);

/**
 * The carriers this station may buy for a tenant: provider carriers (mapped to Storefront codes)
 * ∩ the tenant's catalog allowedCarriers ∩ STATION_CARRIERS (optional), each with a tracking
 * URL whose host the catalog accepts.
 */
export function stationCarriers({ catalog, providerCarriers, configured }) {
  const allowed = new Set(catalog.allowedCarriers);
  const profiles = new Map(catalog.carriers.map((c) => [c.code, c]));
  const out = new Map();
  for (const pc of providerCarriers) {
    const code = PROVIDER_TO_STOREFRONT[pc.code];
    if (!code || out.has(code) || !allowed.has(code)) continue;
    if (configured?.length && !configured.includes(code)) continue;
    const services = pc.services ?? [];
    const serviceCode = services.find((s) => /ground/.test(s)) ?? services[0];
    const trackingUrl = TRACKING_URL[code];
    const hosts = profiles.get(code)?.trackingHosts ?? [];
    if (!serviceCode || !trackingUrl || !hosts.includes(new URL(trackingUrl('X')).hostname)) continue;
    out.set(code, { carrierCode: pc.code, serviceCode, service: serviceFor(serviceCode), trackingUrl });
  }
  return out;
}

/** First carrier the order allows (in the assignment's order) that this station can buy. */
export function pickCarrier(allowedCarriers, carriers) {
  const code = allowedCarriers.find((c) => carriers.has(c));
  return code ? [code, carriers.get(code)] : null;
}

/**
 * @param {object} deps
 * @param {{ call: Function }} deps.tot           from core/tot.mjs (or a test double)
 * @param {(method, path, body?) => Promise<any>} deps.provider  label provider client
 * @param {object} deps.store                     StateStore (core/state.mjs)
 * @param {string[]} [deps.configuredCarriers]    STATION_CARRIERS, e.g. ['UPS']
 * @param {(shipment) => void} [deps.schedulePickup]  mock only: simulate the carrier scan later
 * @param {boolean} [deps.voidFirst]
 */
export function createLabelStation({ tot, provider, store, configuredCarriers = [], schedulePickup = () => {}, voidFirst = false, log = defaultLog }) {
  let carriers = new Map();
  const key = (assignmentId) => `assign:${assignmentId}`;

  const evidence = async (orderId, body, step) =>
    tot.call('POST', `/fulfillment/orders/${encodeURIComponent(orderId)}/shipment-evidence`, {
      body,
      idempotencyKey: await deriveIdempotencyKey('ss', body.assignmentId, body.purchaseId, step),
    });

  async function discoverCarriers() {
    const r = await tot.call('GET', '/fulfillment/carriers');
    if (!r.ok) throw Object.assign(new Error('carrier catalog read refused'), { code: r.body?.code, status: r.status, requestId: r.requestId });
    const providerCarriers = await provider('GET', '/carriers');
    carriers = stationCarriers({ catalog: r.body, providerCarriers, configured: configuredCarriers });
    log('label-station.carriers', { station: [...carriers.keys()], tenantAllowed: r.body.allowedCarriers, pactEnabled: r.body.pactEnabled });
    return carriers;
  }

  /** Buy (or re-report) one label. The provider shipment is saved before Storefront hears of it. */
  async function buyLabel(a, w, recipient, attempt) {
    if (!w.shipment) {
      const pick = pickCarrier(a.allowedCarriers, carriers);
      if (!pick) {
        log('label-station.no_station_carrier', { assignmentId: a.assignmentId, allowedCarriers: a.allowedCarriers, station: [...carriers.keys()] });
        return false;
      }
      const [carrier, m] = pick;
      const order = await provider('POST', '/orders/createorder', {
        orderNumber: a.orderId,
        orderStatus: 'awaiting_shipment',
        shipTo: recipient, // in memory only
        items: a.lines.map((l) => ({ sku: l.sku, quantity: l.remaining })),
      });
      w.providerOrderId = order.orderId;
      const label = await provider('POST', '/orders/createlabelfororder', {
        orderId: order.orderId,
        carrierCode: m.carrierCode,
        serviceCode: m.serviceCode,
        confirmation: a.adultSignatureRequired ? 'adult_signature' : 'none',
        testLabel: true,
      });
      w.shipment = { shipmentId: label.shipmentId, trackingNumber: label.trackingNumber, carrier, service: m.service, trackingUrl: m.trackingUrl(label.trackingNumber) };
      w.stage = 'label_bought';
      await store.set(key(a.assignmentId), w);
    }
    const s = w.shipment;
    const r = await evidence(a.orderId, {
      kind: 'label-outcome',
      assignmentId: a.assignmentId,
      purchaseId: w.purchaseId,
      outcome: 'purchased',
      carrier: s.carrier,
      service: s.service,
      trackingNumber: s.trackingNumber,
      trackingUrl: s.trackingUrl,
      // The station attests the adult-signature service was bought on the label.
      adultSignature: a.adultSignatureRequired ? 'accepted' : 'absent',
    }, `label-${attempt}`);
    log('storefront.label_outcome', { orderId: a.orderId, status: r.status, code: r.body?.code, holds: r.body?.holds, carrier: s.carrier, requestId: r.requestId });
    if (!r.ok) return false;
    w.stage = 'labelled';
    await store.set(key(a.assignmentId), w);
    return true;
  }

  async function processAssignment(a) {
    const existing = await store.get(key(a.assignmentId));
    if (existing && existing.stage !== 'new' && existing.stage !== 'label_bought') return; // done, held or cancelled
    if (existing?.state === 'held' || existing?.state === 'cancelled') return;
    const w = existing ?? { stage: 'new', state: 'active', eventVersion: a.eventVersion, attempt: 1 };
    w.orderId = a.orderId;
    w.purchaseId ??= a.purchaseId;
    await store.set(key(a.assignmentId), w);
    try {
      log('assignment.start', { assignmentId: a.assignmentId, orderId: a.orderId, allowedCarriers: a.allowedCarriers, adultSignatureRequired: a.adultSignatureRequired, lines: a.lines, resumed: Boolean(existing) });
      let recipient;
      if (!w.shipment) {
        const rec = await tot.call('GET', `/fulfillment/orders/${encodeURIComponent(a.orderId)}/recipient`);
        if (!rec.ok) throw Object.assign(new Error('recipient read refused'), { code: rec.body?.code, status: rec.status, requestId: rec.requestId });
        const { orderId: _ignored, ...shipTo } = rec.body;
        recipient = shipTo;
      }
      if (!(await buyLabel(a, w, recipient, w.attempt))) throw Object.assign(new Error('label not recorded'), { code: 'label_failed' });

      if (voidFirst && w.attempt === 1) {
        await provider('POST', '/shipments/voidlabel', { shipmentId: w.shipment.shipmentId });
        const v = await evidence(a.orderId, { kind: 'label-voided', assignmentId: a.assignmentId, purchaseId: w.purchaseId }, 'void');
        log('storefront.label_voided', { orderId: a.orderId, status: v.status, code: v.body?.code, nextPurchaseId: v.body?.purchaseId });
        if (!v.ok) throw Object.assign(new Error('void refused'), { code: v.body?.code });
        Object.assign(w, { purchaseId: v.body.purchaseId, shipment: undefined, stage: 'new', attempt: 2 }); // replacement reported under the new id
        await store.set(key(a.assignmentId), w);
        const rec = await tot.call('GET', `/fulfillment/orders/${encodeURIComponent(a.orderId)}/recipient`);
        const { orderId: _i, ...shipTo } = rec.body ?? {};
        if (!rec.ok || !(await buyLabel(a, w, shipTo, 2))) throw Object.assign(new Error('replacement label not recorded'), { code: 'label_failed' });
      }
      schedulePickup(w.shipment);
    } catch (err) {
      logError('assignment.failed', err, { assignmentId: a.assignmentId, orderId: a.orderId });
      // Kept in the store: the next poll resumes from w.stage instead of buying again.
    }
  }

  async function onCarrierPickup(shipment) {
    const entry = (await store.entries('assign:')).find(([, w]) => w.shipment?.shipmentId === shipment.shipmentId);
    if (!entry) return;
    const [k, w] = entry;
    const assignmentId = k.slice('assign:'.length);
    if (w.state !== 'active' || w.stage !== 'labelled') {
      log('label-station.handoff_skipped', { assignmentId, state: w.state, stage: w.stage });
      return;
    }
    const r = await evidence(w.orderId, { kind: 'handoff', assignmentId, purchaseId: w.purchaseId, carrier: w.shipment.carrier }, 'handoff');
    log('storefront.handoff', { orderId: w.orderId, status: r.status, code: r.body?.code, holds: r.body?.holds, handoff: r.body?.handoff, requestId: r.requestId });
    if (r.ok) {
      w.stage = 'handed_off';
      await store.set(k, w);
    }
  }
  const onShipNotify = onCarrierPickup;

  /** fulfillment.assignment.updated: hold, resume or cancel the provider order. Older eventVersions are ignored. */
  async function onAssignmentUpdated(data) {
    const k = key(data.assignmentId);
    const w = (await store.get(k)) ?? { orderId: data.orderId, stage: 'new', state: 'active', eventVersion: -1, attempt: 1 };
    // Deliveries can arrive late or out of order: an older eventVersion never overrides a newer one.
    if (data.eventVersion < w.eventVersion || (data.eventVersion === w.eventVersion && data.state === w.state)) {
      return log('assignment.updated.stale', { assignmentId: data.assignmentId, state: data.state, eventVersion: data.eventVersion });
    }
    if (w.state === 'cancelled') return log('assignment.updated.after_cancel', { assignmentId: data.assignmentId, state: data.state });
    const unshipped = w.stage !== 'handed_off';
    if (data.state === 'held' && unshipped && w.providerOrderId) await provider('POST', '/orders/holduntil', { orderId: w.providerOrderId });
    if (data.state === 'active' && w.state === 'held' && w.providerOrderId) await provider('POST', '/orders/restorefromhold', { orderId: w.providerOrderId });
    if (data.state === 'cancelled' && unshipped) {
      if (w.shipment && !w.shipment.voided) {
        await provider('POST', '/shipments/voidlabel', { shipmentId: w.shipment.shipmentId });
        w.shipment.voided = true;
      }
      if (w.providerOrderId) await provider('POST', '/orders/cancel', { orderId: w.providerOrderId });
    }
    Object.assign(w, { state: data.state, eventVersion: data.eventVersion });
    await store.set(k, w);
    log('assignment.updated', { assignmentId: data.assignmentId, orderId: data.orderId, state: data.state, stage: w.stage, eventVersion: data.eventVersion });
    if (data.state === 'active' && w.stage === 'labelled') schedulePickup(w.shipment);
    if (data.state === 'active') await reconcile('resumed');
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

  const handlers = {
    // Ack fast; the work runs after the 202 (the poll catches anything that fails).
    'fulfillment.assignment.created': async () => void reconcile('webhook'),
    'fulfillment.assignment.updated': async (e) => onAssignmentUpdated(e.data),
    'fulfillment.label.voided': async (e) => log('label.voided.event', { data: e.data }),
    'order.fulfilled': async (e) => log('order.fulfilled.event', { data: e.data }),
  };

  return { discoverCarriers, processAssignment, onCarrierPickup, onShipNotify, onAssignmentUpdated, reconcile, handlers, get carriers() { return carriers; } };
}

/** HTTP client for the label provider (the in-process mock unless PROVIDER_API_URL is set). */
export function providerClient(base, authHeader) {
  return async function provider(method, path, body) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(authHeader ? { authorization: authHeader } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`provider ${method} ${path} -> ${res.status} ${json.Message ?? ''}`), { code: 'provider_error', status: res.status });
    return json;
  };
}

async function main() {
  const { loadConfig } = await import('../../core/config.mjs');
  const { createTot } = await import('../../core/tot.mjs');
  const { createFileStateStore, seenEventsFrom } = await import('../../core/state.mjs');
  const { startWebhookServer } = await import('../../core/server.mjs');
  const { startMockLabelProvider } = await import('./mock-label-provider.mjs');

  const cfg = loadConfig('label-station');
  const store = createFileStateStore(cfg.statePath);
  const tot = createTot(cfg, { seenEvents: seenEventsFrom(store) });
  const pollSeconds = Number(cfg.env.POLL_SECONDS || 30);
  const pickupSeconds = Number(cfg.env.MOCK_PICKUP_SECONDS || 5);
  const real = Boolean(cfg.env.PROVIDER_API_URL);
  const base = cfg.env.PROVIDER_API_URL || `http://127.0.0.1:${cfg.mockPort}`;
  const authHeader = cfg.env.PROVIDER_API_KEY ? `Basic ${Buffer.from(`${cfg.env.PROVIDER_API_KEY}:${cfg.env.PROVIDER_API_SECRET}`).toString('base64')}` : undefined;
  const provider = providerClient(base, authHeader);

  const station = createLabelStation({
    tot,
    provider,
    store,
    configuredCarriers: (cfg.env.STATION_CARRIERS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    voidFirst: cfg.env.MOCK_VOID_FIRST === '1',
    schedulePickup: real ? () => {} : (s) => setTimeout(() => fetch(`${base}/_mock/pickup/${s.shipmentId}`, { method: 'POST' }).catch((e) => logError('mock.pickup', e)), pickupSeconds * 1000),
  });
  if (!real) await startMockLabelProvider({ port: cfg.mockPort, onShipNotify: (s) => station.onShipNotify(s).catch((e) => logError('ship_notify', e)) });
  defaultLog('label-station.ready', { provider: real ? 'real API' : `mock on ${base}`, tenant: cfg.tenant, installId: cfg.installId, state: cfg.statePath });
  await station.discoverCarriers();

  if (cfg.webhookEndpoint) startWebhookServer({ cfg, tot, handlers: station.handlers });
  else defaultLog('webhooks.off', { hint: 'set WEBHOOK_PUBLIC_URL (README "Tunnel"); polling only' });

  station.reconcile('startup');
  setInterval(() => station.reconcile('poll'), pollSeconds * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
