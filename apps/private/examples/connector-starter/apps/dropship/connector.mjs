#!/usr/bin/env node
// Dropship starter (e.g. Duoplane). `npm run dropship`
//
// Flow per Storefront assignment:
//   fulfillment.assignment.created webhook (or the safety-net poll)
//   -> GET /fulfillment/assignments            lines, allowed carriers, adult signature?
//   -> GET /fulfillment/orders/{id}/recipient  ship-to, in memory only, never logged or stored
//   -> dropship platform: create a purchase order for the supplier
//   -> poll the purchase order; for each supplier shipment:
//        POST /fulfillment/assignments/{id}/shipments   (per line; partial -> order.partially_fulfilled, last -> order.fulfilled)
//      for each backorder, or a carrier Storefront refuses:
//        POST /fulfillment/assignments/{id}/exceptions  (the merchant desk resolves it; nothing is cancelled)
//
// fulfillment.assignment.updated (Storefront -> supplier):
//   held       -> hold the purchase order: the supplier ships nothing more; nothing is reported
//   active     -> hold cleared: resume the purchase order
//   cancelled  -> cancel the purchase order's unshipped lines; nothing more is reported
//
// Progress lives in a StateStore (core/state.mjs), so a restart never creates a second purchase
// order or reports a supplier shipment twice.
import { pathToFileURL } from 'node:url';
import { deriveIdempotencyKey } from '../../vendor/connector-kit/index.js';
import { log as defaultLog, logError } from '../../core/log.mjs';

const TRACKING_URL = {
  UPS: (n) => `https://www.ups.com/track?tracknum=${n}`,
  FEDEX: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  USPS: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
};

/**
 * @param {object} deps
 * @param {{ call: Function }} deps.tot
 * @param {(method, path, body?) => Promise<any>} deps.provider  dropship platform client
 * @param {object} deps.store  StateStore (core/state.mjs)
 */
export function createDropship({ tot, provider, store, log = defaultLog }) {
  const key = (assignmentId) => `assign:${assignmentId}`;

  async function startAssignment(a) {
    const existing = await store.get(key(a.assignmentId));
    if (existing?.poId || existing?.state === 'held' || existing?.state === 'cancelled') return;
    const w = existing ?? { reported: [], state: 'active', eventVersion: a.eventVersion };
    Object.assign(w, { orderId: a.orderId, adultSignatureRequired: a.adultSignatureRequired, poId: null });
    await store.set(key(a.assignmentId), w);
    try {
      log('assignment.start', { assignmentId: a.assignmentId, orderId: a.orderId, locationId: a.locationId, lines: a.lines });
      const rec = await tot.call('GET', `/fulfillment/orders/${encodeURIComponent(a.orderId)}/recipient`);
      if (!rec.ok) throw Object.assign(new Error('recipient read refused'), { code: rec.body?.code, status: rec.status, requestId: rec.requestId });
      const { orderId: _ignored, ...shipTo } = rec.body;
      // The platform upserts by order_reference, so a retry after a crash finds the same purchase order.
      const po = await provider('POST', '/purchase_orders', {
        order_reference: a.orderId,
        shipping_address: shipTo, // in memory only
        items: a.lines.filter((l) => l.remaining > 0).map((l) => ({ sku: l.sku, quantity: l.remaining })),
        notes: a.adultSignatureRequired ? 'ADULT SIGNATURE (21+) REQUIRED' : undefined,
      });
      w.poId = po.id;
      await store.set(key(a.assignmentId), w);
      log('provider.po_created', { orderId: a.orderId, poId: po.id });
    } catch (err) {
      logError('assignment.failed', err, { assignmentId: a.assignmentId, orderId: a.orderId });
    }
  }

  async function markReported(assignmentId, w, reportKey) {
    w.reported.push(reportKey);
    await store.set(key(assignmentId), w);
  }

  async function reportException(assignmentId, w, reportKey, code, lines, note) {
    const r = await tot.call('POST', `/fulfillment/assignments/${encodeURIComponent(assignmentId)}/exceptions`, {
      body: { code, lines, note },
      idempotencyKey: await deriveIdempotencyKey('dp-exc', assignmentId, reportKey),
    });
    log('storefront.exception', { orderId: w.orderId, code, status: r.status, refused: r.ok ? undefined : r.body?.code, field: r.body?.field, requestId: r.requestId });
    if (r.ok) await markReported(assignmentId, w, reportKey);
  }

  /** Reports new supplier shipments and backorders. Returns the purchase order, or null when nothing was read. */
  async function syncPurchaseOrder(assignmentId, w) {
    if (!w.poId || w.state !== 'active') return null;
    const po = await provider('GET', `/purchase_orders/${w.poId}`);
    for (const s of po.shipments) {
      const reportKey = `ship-${s.id}`;
      if (w.reported.includes(reportKey)) continue;
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
      log('storefront.shipment', { orderId: w.orderId, supplierShipment: s.id, carrier: s.carrier, status: r.status, code: r.body?.code, holds: r.body?.holds, complete: r.body?.complete, requestId: r.requestId });
      if (r.ok) await markReported(assignmentId, w, reportKey);
      else if (r.body?.code === 'assignment-ended') {
        // Cancelled, released or superseded in Storefront: nothing more can be reported for it.
        w.ended = true;
        await store.set(key(assignmentId), w);
        log('assignment.ended', { assignmentId, orderId: w.orderId, poId: w.poId });
        return po;
      } else if (r.body?.code === 'carrier-prohibited' || r.body?.code === 'adult-signature') {
        // Storefront refused the supplier's shipment (compliance). Tell the merchant; don't retry forever.
        await reportException(assignmentId, w, reportKey, 'carrier_refused', body.lines, `supplier shipped with ${s.carrier}; Storefront refused: ${r.body.code}`);
      }
    }
    for (const b of po.backorders) {
      const reportKey = `bo-${b.sku}`;
      if (!w.reported.includes(reportKey)) await reportException(assignmentId, w, reportKey, 'backordered', [{ sku: b.sku, quantity: b.quantity }], 'supplier backorder');
    }
    return po;
  }

  /** The supplier side is done: every ordered unit shipped and reported, or the purchase order is cancelled. */
  function supplierDone(po, w) {
    if (po.status === 'cancelled') return true;
    const shipped = (sku) => po.shipments.flatMap((s) => s.items).filter((i) => i.sku === sku).reduce((n, i) => n + i.quantity, 0);
    return po.items.every((i) => shipped(i.sku) >= i.quantity) && po.shipments.every((s) => w.reported.includes(`ship-${s.id}`));
  }

  /** fulfillment.assignment.updated: hold, resume or cancel the purchase order. Older eventVersions are ignored. */
  async function onAssignmentUpdated(data) {
    const k = key(data.assignmentId);
    const w = (await store.get(k)) ?? { orderId: data.orderId, poId: null, reported: [], state: 'active', eventVersion: -1 };
    if (data.eventVersion < w.eventVersion || (data.eventVersion === w.eventVersion && data.state === w.state)) {
      return log('assignment.updated.stale', { assignmentId: data.assignmentId, state: data.state, eventVersion: data.eventVersion });
    }
    if (w.state === 'cancelled') return log('assignment.updated.after_cancel', { assignmentId: data.assignmentId, state: data.state });
    if (w.poId) {
      const action = { held: 'hold', active: w.state === 'held' ? 'resume' : null, cancelled: 'cancel' }[data.state];
      if (action) await provider('POST', `/purchase_orders/${w.poId}/${action}`);
    }
    Object.assign(w, { state: data.state, eventVersion: data.eventVersion });
    await store.set(k, w);
    log('assignment.updated', { assignmentId: data.assignmentId, orderId: data.orderId, state: data.state, poId: w.poId, eventVersion: data.eventVersion });
    if (data.state === 'active') await reconcile('resumed');
  }

  let busy = null;
  function reconcile(reason) {
    busy ??= (async () => {
      const r = await tot.call('GET', '/fulfillment/assignments');
      if (!r.ok) return log('assignments.read_failed', { status: r.status, code: r.body?.code, requestId: r.requestId });
      if (r.body.assignments.length || reason !== 'poll') log('assignments.reconcile', { reason, count: r.body.assignments.length });
      for (const a of r.body.assignments) await startAssignment(a);
      const active = new Set(r.body.assignments.map((a) => a.assignmentId));
      for (const [k, w] of await store.entries('assign:')) {
        const assignmentId = k.slice('assign:'.length);
        const po = await syncPurchaseOrder(assignmentId, w);
        if (active.has(assignmentId) || !w.poId) continue;
        // Absent from the read: fully shipped, held, cancelled or released. The held or cancelled
        // webhook can arrive after this poll, so absence alone never closes a record: forget it only
        // once Storefront said it is cancelled or ended, or the supplier finished and every carton is reported.
        if (w.state === 'cancelled' || w.ended || (po && supplierDone(po, w))) await store.delete(k);
      }
    })()
      .catch((e) => logError('reconcile.error', e))
      .finally(() => (busy = null));
    return busy;
  }

  const handlers = {
    'fulfillment.assignment.created': async () => void reconcile('webhook'),
    'fulfillment.assignment.updated': async (e) => onAssignmentUpdated(e.data),
    'order.partially_fulfilled': async (e) => log('order.partially_fulfilled.event', { data: e.data }),
    'order.fulfilled': async (e) => log('order.fulfilled.event', { data: e.data }),
  };

  return { startAssignment, syncPurchaseOrder, onAssignmentUpdated, reconcile, handlers };
}

export function providerClient(base) {
  return async function provider(method, path, body) {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`provider ${method} ${path} -> ${res.status} ${json.error ?? ''}`), { code: 'provider_error', status: res.status });
    return json;
  };
}

async function main() {
  const { loadConfig } = await import('../../core/config.mjs');
  const { createTot } = await import('../../core/tot.mjs');
  const { createFileStateStore, seenEventsFrom } = await import('../../core/state.mjs');
  const { startWebhookServer } = await import('../../core/server.mjs');
  const { startMockDropshipPlatform } = await import('./mock-dropship-platform.mjs');

  const cfg = loadConfig('dropship');
  const store = createFileStateStore(cfg.statePath);
  const tot = createTot(cfg, { seenEvents: seenEventsFrom(store) });
  const pollSeconds = Number(cfg.env.POLL_SECONDS || 15);
  const real = Boolean(cfg.env.PROVIDER_API_URL);
  const base = cfg.env.PROVIDER_API_URL || `http://127.0.0.1:${cfg.mockPort}`;
  if (!real) {
    await startMockDropshipPlatform({
      port: cfg.mockPort,
      shipSeconds: Number(cfg.env.MOCK_SHIP_SECONDS || 8),
      backorder: cfg.env.MOCK_BACKORDER === '1',
      carrier: (cfg.env.MOCK_SUPPLIER_CARRIER || 'UPS').toUpperCase(),
    });
  }
  const dropship = createDropship({ tot, provider: providerClient(base), store });
  defaultLog('dropship.ready', { provider: real ? 'real API' : `mock on ${base}`, tenant: cfg.tenant, installId: cfg.installId, state: cfg.statePath });

  if (cfg.webhookEndpoint) startWebhookServer({ cfg, tot, handlers: dropship.handlers });
  else defaultLog('webhooks.off', { hint: 'set WEBHOOK_PUBLIC_URL (README "Tunnel"); polling only' });

  dropship.reconcile('startup');
  setInterval(() => dropship.reconcile('poll'), pollSeconds * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
