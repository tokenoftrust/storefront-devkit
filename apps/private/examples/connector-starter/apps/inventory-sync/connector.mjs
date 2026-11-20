#!/usr/bin/env node
// Inventory / WMS sync starter (e.g. SkuVault). `npm run inventory-sync`
//   cleanup: `npm run inventory-sync -- --cleanup`   velocity report only: `npm run inventory-sync -- --report`
//
// Flow:
//   PUT  /inventory/locations/{id}   declare the warehouse as a Storefront stock location
//   first sync: PUT /inventory/levels with the WMS counts (the baseline)
//   every SYNC_SECONDS:
//     POST /inventory/movements      the WMS movements since the last sync, as one reason-coded batch
//                                    (received / picked / damaged / cycle_count / adjustment)
//     PUT  /inventory/levels         absolute counts from the same WMS snapshot: drift should be 0
//   inventory.changed webhook        applied only when data.asOf is newer than the last one seen for
//                                    (sku, locationId); a redelivered event id answers 200 duplicate
//   GET  /reports?windowDays=30      sales velocity / days of cover for the synced SKUs
//
// SAFE ON A REAL STORE: the location is declared isFulfillable:false, so these counts are
// recorded but never change what shoppers can buy. Flip it to true only on a store you own,
// or once the merchant asks for it.
import { pathToFileURL } from 'node:url';
import { deriveIdempotencyKey } from '../../vendor/connector-kit/index.js';
import { log as defaultLog, logError } from '../../core/log.mjs';

/** WMS movement reason -> Storefront InventoryMovementReason. Extend for your WMS's codes. */
export const REASONS = { RECEIVE: 'received', PICK: 'picked', RESTOCK: 'restock', DAMAGE: 'damaged', CYCLE_COUNT: 'cycle_count', TRANSFER: 'transfer' };
const MAX_BATCH = 250;

export function createInventorySync({ tot, provider, store, locationId, fulfillable = false, log = defaultLog }) {
  async function declareLocation(status = 'active') {
    const r = await tot.call('PUT', `/inventory/locations/${encodeURIComponent(locationId)}`, {
      body: { name: 'Starter warehouse (mock WMS)', kind: 'warehouse', isFulfillable: fulfillable, status },
    });
    log('storefront.location', { locationId, status, isFulfillable: fulfillable, http: r.status, code: r.body?.code, field: r.body?.field, requestId: r.requestId });
    return r.ok;
  }

  /**
   * One atomic batch. A 422 names the refused item (`index`): log it, drop it, send the rest once.
   * `movementIds` are the WMS's own identities for these movements (sequence + time recorded). The
   * Idempotency-Key covers them and the exact items, so a retry of the same batch replays its receipt,
   * while a different movement can never reuse an old key, even when a WMS restarts its numbering.
   */
  async function postBatch(items, movementIds) {
    let batch = items;
    for (let attempt = 1; attempt <= 2 && batch.length; attempt++) {
      const r = await tot.call('POST', '/inventory/movements', {
        body: { items: batch },
        idempotencyKey: await deriveIdempotencyKey('sv-mv', locationId, movementIds, batch),
      });
      log('storefront.movements', { http: r.status, code: r.body?.code, index: r.body?.index, field: r.body?.field, count: batch.length, receiptId: r.body?.receiptId, requestId: r.requestId });
      if (r.ok) return true;
      if (r.status !== 422 || r.body?.index === undefined) return false;
      log('storefront.movement_refused', { item: batch[r.body.index], code: r.body.code, field: r.body.field });
      batch = batch.filter((_, i) => i !== r.body.index);
    }
    return batch.length === 0;
  }

  async function pushLevels(inv, reason) {
    const items = inv.items.map((i) => ({ sku: i.sku, locationId, onHand: i.quantityOnHand, observedAt: inv.asOf }));
    const r = await tot.call('PUT', '/inventory/levels', {
      body: { items },
      // Same snapshot -> same key, so a retry after a timeout can never double-apply.
      idempotencyKey: await deriveIdempotencyKey('sv-lvl', locationId, inv.asOf, items),
    });
    const drift = r.ok ? r.body.items.filter((i) => i.quantityDelta !== 0).map(({ sku, quantityDelta }) => ({ sku, quantityDelta })) : undefined;
    log('storefront.levels', { reason, http: r.status, code: r.body?.code, index: r.body?.index, field: r.body?.field, drift, receiptId: r.body?.receiptId, requestId: r.requestId });
    return r;
  }

  async function sync(reason) {
    const inv = await provider('GET', '/inventory');
    const cursor = await store.get('wms:cursor');
    if (cursor === undefined) {
      // Baseline: absolute counts first, so later deltas never start from an empty ledger.
      const r = await pushLevels(inv, `${reason}:baseline`);
      if (r.ok) await store.set('wms:cursor', inv.lastMovement);
      return;
    }
    const { movements } = await provider('GET', `/movements?after=${cursor}`);
    const inSnapshot = movements.filter((m) => m.seq <= inv.lastMovement);
    if (inSnapshot.length) {
      const items = inSnapshot.map((m) => ({ sku: m.sku, locationId, quantityDelta: m.quantityDelta, reason: REASONS[m.reason] ?? 'adjustment' }));
      for (let i = 0; i < items.length; i += MAX_BATCH) {
        const chunk = items.slice(i, i + MAX_BATCH);
        const moves = inSnapshot.slice(i, i + MAX_BATCH);
        const seqs = moves.map((m) => m.seq);
        if (!(await postBatch(chunk, moves.map((m) => `${m.seq}@${m.at}`)))) return; // cursor not advanced: retried next tick
        await store.set('wms:cursor', seqs.at(-1));
      }
    }
    await store.set('wms:cursor', inv.lastMovement);
    await pushLevels(inv, reason); // reconcile: drift is 0 when every movement arrived
  }

  /** inventory.changed: apply only newer data.asOf per (sku, locationId); persisted, so it survives restarts. */
  async function onInventoryChanged(data) {
    const k = `asof:${data.sku}\u0000${data.locationId}`;
    const last = await store.get(k);
    if (last !== undefined && Date.parse(data.asOf) <= Date.parse(last)) {
      log('inventory.changed.stale', { sku: data.sku, locationId: data.locationId, asOf: data.asOf, lastSeenAsOf: last });
      return 'stale';
    }
    await store.set(k, data.asOf);
    log('inventory.changed.applied', { sku: data.sku, locationId: data.locationId, balance: data.balance, available: data.available, asOf: data.asOf });
    return 'applied';
  }

  async function report(skus, windowDays = 30) {
    const r = await tot.call('GET', '/reports', { query: { windowDays } });
    if (!r.ok) {
      log('reports.read_failed', { http: r.status, code: r.body?.code, hint: r.body?.code === 'scope_denied' ? 'add reports:read: tot app update <installId> --app apps/inventory-sync --tenant <store>' : undefined, requestId: r.requestId });
      return null;
    }
    const velocity = r.body.reports.find((x) => x.id === 'sales-velocity');
    const rows = (velocity?.skus ?? []).filter((row) => !skus || skus.includes(row.sku));
    log('reports.sales_velocity', { window: velocity?.window, rows });
    return rows;
  }

  async function cleanup() {
    const inv = await provider('GET', '/inventory');
    const r = await tot.call('PUT', '/inventory/levels', {
      body: { items: inv.items.map((i) => ({ sku: i.sku, locationId, onHand: 0, observedAt: new Date().toISOString() })) },
      idempotencyKey: await deriveIdempotencyKey('sv-clean', locationId, String(Date.now())),
    });
    log('cleanup.levels_zeroed', { http: r.status, code: r.body?.code });
    await declareLocation('archived');
    await store.delete('wms:cursor');
  }

  const handlers = { 'inventory.changed': async (e) => void (await onInventoryChanged(e.data)) };
  return { declareLocation, sync, onInventoryChanged, report, cleanup, handlers };
}

export function providerClient(base) {
  return async function provider(method, path) {
    const res = await fetch(`${base}${path}`, { method });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`provider ${method} ${path} -> ${res.status}`), { code: 'provider_error', status: res.status });
    return json;
  };
}

async function main() {
  const { loadConfig } = await import('../../core/config.mjs');
  const { createTot } = await import('../../core/tot.mjs');
  const { createFileStateStore, seenEventsFrom } = await import('../../core/state.mjs');
  const { startWebhookServer } = await import('../../core/server.mjs');
  const { startMockWms } = await import('./mock-wms.mjs');

  const cfg = loadConfig('inventory-sync');
  const store = createFileStateStore(cfg.statePath);
  const tot = createTot(cfg, { seenEvents: seenEventsFrom(store) });
  const syncSeconds = Number(cfg.env.SYNC_SECONDS || 30);
  const real = Boolean(cfg.env.PROVIDER_API_URL);
  const base = cfg.env.PROVIDER_API_URL || `http://127.0.0.1:${cfg.mockPort}`;

  // Seed the mock with a few of the store's real SKUs (inventory reads list SKUs; the catalog list does not).
  const sample = await tot.call('GET', '/inventory', { query: { limit: Number(cfg.env.MOCK_SKU_COUNT || 3) } });
  if (!sample.ok) {
    defaultLog('inventory.read_failed', { http: sample.status, code: sample.body?.code, requestId: sample.requestId });
    process.exit(1);
  }
  const skus = sample.body.items.map((i) => i.sku);
  if (!real) await startMockWms({ port: cfg.mockPort, skus, driftSeconds: Number(cfg.env.MOCK_DRIFT_SECONDS || 20) });
  const sync = createInventorySync({ tot, provider: providerClient(base), store, locationId: cfg.locationId, fulfillable: cfg.env.STARTER_LOCATION_FULFILLABLE === '1' });
  defaultLog('inventory-sync.ready', { provider: real ? 'real API' : `mock on ${base}`, tenant: cfg.tenant, locationId: cfg.locationId, skus, state: cfg.statePath });

  if (process.argv.includes('--cleanup')) {
    await sync.cleanup();
    process.exit(0);
  }
  if (process.argv.includes('--report')) {
    await sync.report(skus);
    process.exit(0);
  }
  if (!(await sync.declareLocation())) process.exit(1);
  await sync.report(skus);

  if (cfg.webhookEndpoint) startWebhookServer({ cfg, tot, handlers: sync.handlers });
  else defaultLog('webhooks.off', { hint: 'set WEBHOOK_PUBLIC_URL (README "Tunnel") to receive inventory.changed' });

  const tick = (reason) => sync.sync(reason).catch((e) => logError('sync.error', e));
  await tick('startup');
  setInterval(() => tick('poll'), syncSeconds * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
