#!/usr/bin/env node
// Inventory / WMS sync starter (e.g. SkuVault). `npm run inventory-sync`   (cleanup: `npm run inventory-sync -- --cleanup`)
//
// Flow:
//   PUT /inventory/locations/{id}   declare the warehouse as a Storefront stock location
//   every SYNC_SECONDS: read WMS on-hand -> PUT /inventory/levels (absolute counts, idempotent)
//   inventory.changed webhook       log availability transitions Storefront reports back
//
// SAFE ON A REAL STORE: the location is declared isFulfillable:false, so these counts are
// recorded but never change what shoppers can buy. Flip it to true only on a store you own,
// or once the merchant asks for it.
import { deriveIdempotencyKey } from '../../vendor/connector-kit/index.js';
import { loadConfig } from '../../core/config.mjs';
import { log, logError } from '../../core/log.mjs';
import { startWebhookServer } from '../../core/server.mjs';
import { createTot } from '../../core/tot.mjs';
import { startMockWms } from './mock-wms.mjs';

const cfg = loadConfig('inventory-sync');
const tot = createTot(cfg);
const syncSeconds = Number(cfg.env.SYNC_SECONDS || 30);
const locationId = cfg.env.STARTER_LOCATION_ID || 'loc-starter-wms';
const fulfillable = cfg.env.STARTER_LOCATION_FULFILLABLE === '1';

async function declareLocation(status = 'active') {
  const r = await tot.call('PUT', `/inventory/locations/${encodeURIComponent(locationId)}`, {
    body: { name: 'Starter warehouse (mock WMS)', kind: 'warehouse', isFulfillable: fulfillable, status },
    idempotencyKey: await deriveIdempotencyKey('sv-loc', locationId, status, String(fulfillable), String(Date.now())),
  });
  log('storefront.location', { locationId, status, isFulfillable: fulfillable, http: r.status, code: r.body?.code, field: r.body?.field, requestId: r.requestId });
  return r.ok;
}

// ---- WMS client (mock by default) ----
const providerBase = cfg.env.PROVIDER_API_URL || `http://127.0.0.1:${cfg.mockPort}`;
async function provider(method, path) {
  const res = await fetch(`${providerBase}${path}`, { method });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`provider ${method} ${path} -> ${res.status}`), { code: 'provider_error', status: res.status });
  return json;
}

const lastSent = new Map(); // sku -> onHand we last pushed
async function sync(reason) {
  const inv = await provider('GET', '/inventory');
  const changed = inv.items.filter((i) => lastSent.get(i.sku) !== i.quantityOnHand);
  if (!changed.length) return;
  const items = changed.map((i) => ({ sku: i.sku, locationId, onHand: i.quantityOnHand, observedAt: inv.asOf }));
  const r = await tot.call('PUT', '/inventory/levels', {
    body: { items },
    // Same snapshot -> same key, so a retry after a timeout can never double-apply.
    idempotencyKey: await deriveIdempotencyKey('sv-lvl', locationId, inv.asOf, JSON.stringify(items)),
  });
  log('storefront.levels', { reason, http: r.status, code: r.body?.code, field: r.body?.field, items: items.map(({ sku, onHand }) => ({ sku, onHand })), receiptId: r.body?.receiptId, requestId: r.requestId });
  if (r.ok) for (const i of changed) lastSent.set(i.sku, i.quantityOnHand);
}

async function cleanup() {
  const inv = await provider('GET', '/inventory');
  const r = await tot.call('PUT', '/inventory/levels', {
    body: { items: inv.items.map((i) => ({ sku: i.sku, locationId, onHand: 0, observedAt: new Date().toISOString() })) },
    idempotencyKey: await deriveIdempotencyKey('sv-clean', locationId, String(Date.now())),
  });
  log('cleanup.levels_zeroed', { http: r.status, code: r.body?.code });
  await declareLocation('archived');
  process.exit(0);
}

// Seed the mock with a few of the store's real SKUs (inventory reads list SKUs; the catalog list does not).
const sample = await tot.call('GET', '/inventory', { query: { limit: Number(cfg.env.MOCK_SKU_COUNT || 3) } });
if (!sample.ok) {
  log('inventory.read_failed', { http: sample.status, code: sample.body?.code, requestId: sample.requestId });
  process.exit(1);
}
const skus = sample.body.items.map((i) => i.sku);
if (!cfg.env.PROVIDER_API_URL) await startMockWms({ port: cfg.mockPort, skus, driftSeconds: Number(cfg.env.MOCK_DRIFT_SECONDS || 20) });
log('inventory-sync.ready', { provider: cfg.env.PROVIDER_API_URL ? 'real API' : `mock on ${providerBase}`, tenant: cfg.tenant, locationId, skus });

if (process.argv.includes('--cleanup')) await cleanup();
if (!(await declareLocation())) process.exit(1);

if (cfg.webhookEndpoint) {
  startWebhookServer({
    cfg,
    tot,
    handlers: { 'inventory.changed': async (e) => log('inventory.changed.event', { data: e.data }) },
  });
} else {
  log('webhooks.off', { hint: 'set WEBHOOK_PUBLIC_URL (README "Tunnel") to receive inventory.changed' });
}

const tick = (reason) => sync(reason).catch((e) => logError('sync.error', e));
await tick('startup');
setInterval(() => tick('poll'), syncSeconds * 1000);
