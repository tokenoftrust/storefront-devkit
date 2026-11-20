#!/usr/bin/env node
// Starter reference app for Storefront Private Apps (contract private-apps@1.4, connector-kit 1.1.0):
// 1. Declares a quarantine stock location (PUT /api/apps/v1/inventory/locations/{locationId},
//    isFulfillable: false) and lists declared locations (GET /api/apps/v1/inventory/locations).
// 2. Posts an atomic WMS batch of movements (POST /api/apps/v1/inventory/movements, { items: [...] },
//    reasons received / damaged / cycle_count / adjustment) and replays the same Idempotency-Key.
// 3. Reconciles absolute on-hand levels (PUT /api/apps/v1/inventory/levels) and shows drift
//    convergence: the first observation writes the difference, the next one writes 0.
// 4. Reads availability (GET /api/apps/v1/inventory): quarantined stock stays in the ledger but
//    never reaches shopper availability.
// 5. Reads a synthetic preview order (GET /api/apps/v1/orders) and the sales-velocity snapshot
//    (GET /api/apps/v1/reports?windowDays=30).
// 6. Verifies signed inventory.changed deliveries (RFC 9421 HTTP signatures) with WebhookReceiver +
//    AuthorizationMetadata and applies them in data.asOf order per (sku, locationId).
//
// Offline (no network, simulated gateway):  node index.mjs --self-test
// Live preview (your test install):         node index.mjs --live [--cleanup]
//   env: TOT_STOREFRONT_ORIGIN (default https://storefront.tokenoftrust.store), TOT_TENANT,
//        TOT_CLIENT_ID, TOT_CLIENT_SECRET, optional TOT_SKU, TOT_LOCATION_ID
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  ApiClient,
  ApiError,
  AuthorizationMetadata,
  ConnectorAuthClient,
  METADATA_PATH,
  TOKEN_PATH,
  WebhookReceiver,
  deriveIdempotencyKey,
} from './vendor/connector-kit/index.js';

export const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/sample-workflow.json', import.meta.url), 'utf8'));
export const DEFAULT_ORIGIN = 'https://storefront.tokenoftrust.store';
const MAX_BATCH = 250;

/** The refusal fields worth logging and branching on; never a body, a message or a credential. */
function refusalOf(err) {
  const body = { code: err.code };
  for (const key of ['holds', 'field', 'index', 'reasons']) if (err[key] !== undefined) body[key] = err[key];
  return { status: err.status, ok: false, body, ...(err.requestId ? { requestId: err.requestId } : {}) };
}

/**
 * The app's API surface. `tenantId` is the store slug on the shared preview host
 * (e.g. `giantvapes.com` on https://storefront.tokenoftrust.store); connector-kit routes
 * both the token request and every API call under it.
 */
export function createHelloInventoryClient({ baseUrl, tenantId, clientId, clientSecret, fetchImpl = fetch, sleep }) {
  const auth = new ConnectorAuthClient({
    origin: baseUrl,
    tenant: tenantId,
    clientId,
    clientSecret,
    method: 'client_secret_post',
    fetch: fetchImpl,
  });
  const api = new ApiClient({ origin: baseUrl, tenant: tenantId, auth, fetch: fetchImpl, ...(sleep ? { sleep } : {}) });

  /** 2xx resolves `{ status, ok: true, body, requestId }`; a refusal resolves `{ status, ok: false, body: { code, holds?, field?, index?, reasons? }, requestId? }`. */
  async function apiRequest(method, path, { query, body, idempotencyKey } = {}) {
    try {
      const res = await api.request({ method, path, query, body, idempotencyKey });
      return { status: res.status, ok: true, body: res.body, ...(res.requestId ? { requestId: res.requestId } : {}) };
    } catch (err) {
      if (err instanceof ApiError) return refusalOf(err);
      throw err;
    }
  }

  return {
    /** Full replacement of the location's fields; repeating it is idempotent without a key. */
    upsertLocation(locationId, { name, kind = 'warehouse', isFulfillable = false, status = 'active' }) {
      return apiRequest('PUT', `/inventory/locations/${encodeURIComponent(locationId)}`, {
        body: { name, kind, isFulfillable, status },
      });
    },
    listLocations() {
      return apiRequest('GET', '/inventory/locations');
    },
    getInventory({ sku, locationId = 'unspecified', limit = 50 } = {}) {
      return apiRequest('GET', '/inventory', { query: { locationId, limit, ...(sku ? { sku } : {}) } });
    },
    /**
     * One atomic WMS batch (1..250 items, each with a `reason`). 201 answers
     * `{ receiptId, asOf, items: [{ sku, locationId, quantityDelta, reason, balance }] }`;
     * one refused item refuses the batch and names it in `body.index` / `body.field`.
     * The default key is derived from the batch, so a retry after a lost answer replays.
     */
    async postMovements(items, idempotencyKey) {
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) {
        throw new RangeError(`POST /inventory/movements takes 1..${MAX_BATCH} items`);
      }
      const body = { items };
      const key = idempotencyKey ?? (await deriveIdempotencyKey('hello-inv-mv', body));
      return { ...(await apiRequest('POST', '/inventory/movements', { body, idempotencyKey: key })), idempotencyKey: key };
    },
    /**
     * Absolute on-hand observations (1..250 items). The ledger writes the difference as a
     * `reconcile` movement: `items[i].quantityDelta` is nonzero on drift and 0 once converged.
     */
    async putLevels(items, idempotencyKey) {
      if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) {
        throw new RangeError(`PUT /inventory/levels takes 1..${MAX_BATCH} items`);
      }
      const body = { items };
      const key = idempotencyKey ?? (await deriveIdempotencyKey('hello-inv-lv', body));
      return { ...(await apiRequest('PUT', '/inventory/levels', { body, idempotencyKey: key })), idempotencyKey: key };
    },
    /** The `sales-velocity` snapshot: soldUnits, unsoldUnits, velocityPerDay, daysOfCover per sku. */
    getReports({ windowDays = 30 } = {}) {
      return apiRequest('GET', '/reports', { query: { windowDays } });
    },
    listOrders({ page = 1, pageSize = 24 } = {}) {
      return apiRequest('GET', '/orders', { query: { page, pageSize } });
    },
  };
}

/**
 * Applies `inventory.changed` data in `asOf` order per (sku, locationId). Deliveries can
 * arrive out of order (retries, parallel workers); an older or equal `asOf` than the one
 * already applied is stale and must not overwrite the newer balance.
 */
export function createInventoryMirror() {
  const highWater = new Map();
  const keyOf = (sku, locationId) => `${sku}\u0000${locationId}`;
  return {
    apply(data) {
      const key = keyOf(data.sku, data.locationId);
      const asOf = Date.parse(data.asOf);
      if (!Number.isFinite(asOf)) return 'invalid';
      const current = highWater.get(key);
      if (current && asOf <= current.asOf) return 'stale';
      highWater.set(key, { asOf, balance: data.balance, available: data.available });
      return 'applied';
    },
    get(sku, locationId) {
      return highWater.get(keyOf(sku, locationId));
    },
  };
}

/**
 * In-memory gateway simulator for offline verification (`--self-test` and `node --test`).
 * Follows contract 1.4.0 for the routes this app uses. Extras on the returned fetch:
 * `createPreviewOrder()` stands in for `tot app test-order create`, `events` holds the
 * `inventory.changed` data each committed nonzero change emitted.
 */
export function createSimulatedHelloGateway({ signingJwk, tenantId = 'acme' } = {}) {
  const catalog = new Set([FIXTURE.catalogSku, FIXTURE.secondSku]);
  const locations = new Map([
    ['unspecified', { locationId: 'unspecified', name: 'Default Location', kind: 'warehouse', isFulfillable: true, status: 'active', updatedAt: '2026-11-13T12:00:00.000Z' }],
  ]);
  const balances = new Map(Object.entries(FIXTURE.openingBalances).map(([sku, qty]) => [`${sku}\u0000${FIXTURE.location.locationId}`, qty]));
  const idempotencyStore = new Map();
  const previewOrders = [];
  const events = [];
  let clockMs = Date.parse('2026-11-13T12:00:00.000Z');
  let receiptSeq = 0;
  const tick = () => new Date((clockMs += 1000)).toISOString();
  const keyOf = (sku, locationId) => `${sku}\u0000${locationId}`;
  const REASONS = new Set(['received', 'picked', 'restock', 'cycle_count', 'damaged', 'transfer', 'adjustment']);

  const json = (status, payload) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'tot-request-id': `req_sim_${++receiptSeq}` },
    });
  const refuse = (status, code, extra = {}) => json(status, { code, error: code, ...extra });

  /** Sum of on-hand over active fulfillable locations: what shoppers can buy. */
  function availableOf(sku) {
    let total = 0;
    for (const loc of locations.values()) {
      if (loc.status !== 'active' || !loc.isFulfillable) continue;
      total += Math.max(0, balances.get(keyOf(sku, loc.locationId)) ?? 0);
    }
    return total;
  }

  function emit(sku, locationId, asOf) {
    events.push({ sku, locationId, balance: balances.get(keyOf(sku, locationId)) ?? 0, available: availableOf(sku), asOf });
  }

  /** Validate a batch's items atomically; resolves the refusal Response or null. */
  function checkItems(items, kind) {
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH) return refuse(400, 'malformed', { field: 'items' });
    const seen = new Set();
    for (const [index, item] of items.entries()) {
      const locationId = item.locationId ?? 'unspecified';
      if (typeof item.sku !== 'string' || item.sku === '') return refuse(400, 'malformed', { field: 'sku', index });
      if (kind === 'movements') {
        if (!Number.isSafeInteger(item.quantityDelta) || item.quantityDelta === 0) return refuse(400, 'malformed', { field: 'quantityDelta', index });
        if (!REASONS.has(item.reason)) return refuse(400, 'malformed', { field: 'reason', index });
      } else {
        if (!Number.isSafeInteger(item.onHand) || item.onHand < 0) return refuse(400, 'malformed', { field: 'onHand', index });
        const observed = Date.parse(item.observedAt);
        if (!Number.isFinite(observed) || observed > Date.now() + 5 * 60 * 1000) return refuse(400, 'malformed', { field: 'observedAt', index });
        if (seen.has(keyOf(item.sku, locationId))) return refuse(400, 'malformed', { field: 'items', index });
        seen.add(keyOf(item.sku, locationId));
      }
      if (!catalog.has(item.sku)) return refuse(422, 'unknown-sku', { field: 'sku', index });
      if (locations.get(locationId)?.status !== 'active') return refuse(422, 'unknown-location', { field: 'locationId', index });
    }
    return null;
  }

  /** Same key + same body replays; same key + other body is 409. */
  function idempotent(operation, headers, body, commit) {
    const key = headers['idempotency-key'];
    if (!key || key.length < 8 || key.length > 128) return refuse(400, 'malformed', { field: 'Idempotency-Key' });
    const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const existing = idempotencyStore.get(`${operation}:${key}`);
    if (existing) return existing.bodyHash === bodyHash ? json(existing.status, existing.payload) : refuse(409, 'idempotency-conflict');
    const result = commit();
    if (result instanceof Response) return result;
    idempotencyStore.set(`${operation}:${key}`, { bodyHash, status: result.status, payload: result.payload });
    return json(result.status, result.payload);
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

    if (method === 'GET' && url.pathname === METADATA_PATH) {
      return json(200, {
        token_endpoint: `${url.origin}${TOKEN_PATH}`,
        token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt'],
        webhook_signing_keys: { keys: signingJwk ? [signingJwk] : [] },
      });
    }

    // Shared-host routing: /<tenant>/api/apps/... (connector-kit `tenant` option).
    const prefix = `/${tenantId}`;
    if (!url.pathname.startsWith(`${prefix}/api/apps/`)) return refuse(404, 'not_found');
    const route = url.pathname.slice(prefix.length);

    if (method === 'POST' && route === TOKEN_PATH) {
      return json(200, {
        access_token: 'sim-preview-jwt-token',
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'catalog:read inventory:read inventory:write orders:read:minimal reports:read',
      });
    }

    const path = route.replace(/^\/api\/apps\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;

    const locMatch = /^\/inventory\/locations\/([^/]+)$/.exec(path);
    if (method === 'PUT' && locMatch) {
      const locationId = decodeURIComponent(locMatch[1]);
      if (locationId === 'unspecified' && body.status === 'archived') return refuse(409, 'location-protected');
      const record = { locationId, name: body.name, kind: body.kind, isFulfillable: body.isFulfillable ?? true, status: body.status ?? 'active', updatedAt: tick() };
      locations.set(locationId, record);
      return json(200, record);
    }

    if (method === 'GET' && path === '/inventory/locations') return json(200, { items: Array.from(locations.values()) });

    if (method === 'GET' && path === '/inventory') {
      const locationId = url.searchParams.get('locationId') ?? 'unspecified';
      const skus = url.searchParams.get('sku') ? [url.searchParams.get('sku')] : [...catalog].sort();
      const items = skus.map((sku) => {
        const balance = balances.get(keyOf(sku, locationId)) ?? 0;
        const quantity = availableOf(sku);
        return { sku, available: quantity > 0, quantity, policy: 'deny', mirror: { locationId, balance, asOf: new Date(clockMs).toISOString() } };
      });
      return json(200, { items, pageSize: 50, total: items.length, nextCursor: null });
    }

    if (method === 'POST' && path === '/inventory/movements') {
      if (!body || !Array.isArray(body.items)) return refuse(400, 'malformed', { field: 'items' });
      return idempotent('movements', headers, body, () => {
        const refused = checkItems(body.items, 'movements');
        if (refused) return refused;
        const next = new Map(balances);
        for (const [index, item] of body.items.entries()) {
          const key = keyOf(item.sku, item.locationId ?? 'unspecified');
          const value = (next.get(key) ?? 0) + item.quantityDelta;
          if (value < 0) return refuse(409, 'balance-out-of-range', { index });
          next.set(key, value);
        }
        for (const [k, v] of next) balances.set(k, v);
        const asOf = tick();
        const items = body.items.map((item) => {
          const locationId = item.locationId ?? 'unspecified';
          emit(item.sku, locationId, asOf);
          return { sku: item.sku, locationId, quantityDelta: item.quantityDelta, reason: item.reason, balance: balances.get(keyOf(item.sku, locationId)) };
        });
        return { status: 201, payload: { receiptId: `rcpt_sim_${receiptSeq}`, asOf, items } };
      });
    }

    if (method === 'PUT' && path === '/inventory/levels') {
      if (!body || !Array.isArray(body.items)) return refuse(400, 'malformed', { field: 'items' });
      return idempotent('levels', headers, body, () => {
        const refused = checkItems(body.items, 'levels');
        if (refused) return refused;
        const asOf = tick();
        const items = body.items.map((item) => {
          const locationId = item.locationId ?? 'unspecified';
          const key = keyOf(item.sku, locationId);
          const quantityDelta = item.onHand - (balances.get(key) ?? 0);
          balances.set(key, item.onHand);
          if (quantityDelta !== 0) emit(item.sku, locationId, asOf);
          return { sku: item.sku, locationId, onHand: item.onHand, observedAt: item.observedAt, quantityDelta, balance: item.onHand };
        });
        return { status: 200, payload: { receiptId: `rcpt_sim_${receiptSeq}`, asOf, items } };
      });
    }

    if (method === 'GET' && path === '/reports') {
      const windowDays = Number(url.searchParams.get('windowDays') ?? 30);
      if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) return refuse(400, 'malformed', { field: 'windowDays' });
      const to = new Date(clockMs).toISOString();
      const from = new Date(clockMs - windowDays * 86_400_000).toISOString();
      const skus = [...catalog].sort().map((sku) => {
        const soldUnits = previewOrders.flatMap((o) => o.lineItems).filter((l) => l.sku === sku).reduce((n, l) => n + l.quantity, 0);
        const unsoldUnits = availableOf(sku);
        const velocityPerDay = soldUnits / windowDays;
        return { sku, soldUnits, unsoldUnits, velocityPerDay, daysOfCover: soldUnits === 0 ? null : unsoldUnits / velocityPerDay };
      });
      return json(200, { reports: [{ id: 'sales-velocity', title: 'Sales velocity', generatedAt: to, format: 'json', window: { days: windowDays, from, to }, skus }] });
    }

    if (method === 'GET' && path === '/orders') {
      return json(200, { orders: previewOrders, page: 1, pageSize: 24, total: previewOrders.length });
    }

    return refuse(404, 'not_found');
  }

  fetchImpl.events = events;
  /** Stand-in for `tot app test-order create --tenant <tenant> --location <id> --line <sku>:<qty>`. */
  fetchImpl.createPreviewOrder = ({ sku = FIXTURE.catalogSku, quantity = 1 } = {}) => {
    const id = `ord_preview_${previewOrders.length + 1}`;
    previewOrders.push({
      id,
      status: 'paid',
      currency: 'USD',
      customerHash: createHash('sha256').update(`preview-cust-${id}`).digest('hex'),
      subtotal: 35 * quantity,
      total: 38.5 * quantity,
      lineItems: [{ sku, handle: 'classic-tee', quantity, lineTotal: 35 * quantity }],
      createdAt: tick(),
    });
    return { orderId: id, stage: 'preview' };
  };
  return fetchImpl;
}

/** Wrap inventory.changed data in the CloudEvents envelope the gateway sends. */
export function inventoryChangedEvent(data, { id, tenantId = 'acme', installId = 'inst_sim_hello_inventory' }) {
  return {
    specversion: '1.0',
    id,
    source: `/tenants/${tenantId}/storefront`,
    type: 'com.tokenoftrust.storefront.inventory.changed',
    time: data.asOf,
    datacontenttype: 'application/json',
    dataschemaversion: '1',
    tenantid: tenantId,
    appinstallid: installId,
    retrycount: 0,
    data,
  };
}

export async function runSelfTest() {
  const baseUrl = 'https://storefront.tokenoftrust.store';
  const tenantId = 'acme';
  // The gateway signs real deliveries; offline, a test-only signer stands in for it.
  const { createTestWebhookSigner } = await import('./test/webhook-signer.mjs');
  const signer = createTestWebhookSigner({ endpoint: FIXTURE.webhookEndpoint });
  const gateway = createSimulatedHelloGateway({ signingJwk: signer.jwk, tenantId });
  const client = createHelloInventoryClient({ baseUrl, tenantId, clientId: 'sim-client', clientSecret: 'sim-secret', fetchImpl: gateway });
  const loc = FIXTURE.location.locationId;

  // 1. Quarantine location: writable, auditable, never in shopper availability.
  const upserted = await client.upsertLocation(loc, FIXTURE.location);
  assert.equal(upserted.status, 200);
  assert.equal(upserted.body.isFulfillable, false);
  const locList = await client.listLocations();
  assert.ok(locList.body.items.some((l) => l.locationId === loc && l.isFulfillable === false));

  // 2. Atomic WMS batch with discrete reasons, then a replay under the same key.
  const batch = await client.postMovements(FIXTURE.movementBatch.items);
  assert.equal(batch.status, 201, JSON.stringify(batch.body));
  assert.deepEqual(batch.body.items.map((i) => i.reason), ['received', 'damaged', 'cycle_count', 'adjustment']);
  const balanceAfterBatch = Object.fromEntries(batch.body.items.map((i) => [i.sku, i.balance]));
  assert.deepEqual(balanceAfterBatch, { [FIXTURE.catalogSku]: 30, [FIXTURE.secondSku]: 10 });
  const replay = await client.postMovements(FIXTURE.movementBatch.items, batch.idempotencyKey);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.receiptId, batch.body.receiptId);

  // 3. Absolute reconciliation: drift written once, then converged (0) on the next observation.
  const observe = (observedAt) => FIXTURE.levelsObservation.items.map((i) => ({ ...i, observedAt }));
  const firstLevels = await client.putLevels(observe('2026-11-13T12:10:00.000Z'));
  assert.equal(firstLevels.status, 200, JSON.stringify(firstLevels.body));
  const drift = Object.fromEntries(firstLevels.body.items.map((i) => [i.sku, i.quantityDelta]));
  assert.deepEqual(drift, { [FIXTURE.catalogSku]: -3, [FIXTURE.secondSku]: 0 });
  const secondLevels = await client.putLevels(observe('2026-11-13T12:15:00.000Z'));
  assert.equal(secondLevels.status, 200);
  assert.ok(secondLevels.body.items.every((i) => i.quantityDelta === 0));

  // 4. Ledger keeps quarantined stock; shopper availability does not count it.
  const inv = await client.getInventory({ sku: FIXTURE.catalogSku, locationId: loc });
  assert.equal(inv.body.items[0].mirror.balance, 27);
  assert.equal(inv.body.items[0].available, false);

  // 5. Synthetic preview order (CLI: tot app test-order create) read back via /orders, then the velocity report.
  const order = gateway.createPreviewOrder({ sku: FIXTURE.catalogSku, quantity: 2 });
  const orders = await client.listOrders();
  assert.equal(orders.body.orders[0].id, order.orderId);
  const reports = await client.getReports({ windowDays: FIXTURE.reportWindowDays });
  assert.equal(reports.status, 200);
  const velocity = reports.body.reports.find((r) => r.id === 'sales-velocity');
  const row = velocity.skus.find((s) => s.sku === FIXTURE.catalogSku);
  assert.equal(row.soldUnits, 2);
  assert.equal(row.unsoldUnits, 0, 'quarantined stock is not unsold availability');

  // 6. Signed inventory.changed deliveries, verified against published keys and applied in asOf order.
  const receiver = new WebhookReceiver({ endpoint: FIXTURE.webhookEndpoint, keys: new AuthorizationMetadata({ origin: baseUrl, fetch: gateway }) });
  const mirror = createInventoryMirror();
  const forSku = gateway.events.filter((e) => e.sku === FIXTURE.catalogSku && e.locationId === loc);
  const newest = forSku.at(-1);
  const older = forSku[0];
  const outcomes = [];
  const deliver = async (data, id) => {
    const res = await receiver.receive(signer.sign(inventoryChangedEvent(data, { id, tenantId })), (event) => {
      outcomes.push(mirror.apply(event.data));
    });
    return res.status;
  };
  assert.equal(await deliver(newest, 'evt_newest'), 202);
  assert.equal(await deliver(older, 'evt_older_late'), 202);
  const redelivered = await receiver.receive(signer.sign(inventoryChangedEvent(newest, { id: 'evt_newest', tenantId })), () => outcomes.push('reprocessed'));
  assert.deepEqual([redelivered.status, redelivered.body], [200, { accepted: true, duplicate: true }], 'a redelivered event id is acknowledged, not reprocessed');
  const tampered = signer.sign(inventoryChangedEvent(newest, { id: 'evt_tampered', tenantId }));
  tampered.body = tampered.body.replace(`"balance":${newest.balance}`, `"balance":${newest.balance + 100}`);
  assert.equal((await receiver.receive(tampered, () => outcomes.push('tampered'))).status, 400);
  assert.deepEqual(outcomes, ['applied', 'stale']);
  assert.equal(mirror.get(FIXTURE.catalogSku, loc).balance, 27);

  return {
    ok: true,
    locationId: loc,
    batchReceiptId: batch.body.receiptId,
    balances: balanceAfterBatch,
    reconcileDrift: drift,
    previewOrderId: order.orderId,
    daysOfCover: row.daysOfCover,
    webhookOutcomes: outcomes,
  };
}

/** Live preview run against your own test install. Never prints a credential. */
export async function runLive({ cleanup = false, env = process.env, log = (o) => console.log(JSON.stringify(o)) } = {}) {
  const baseUrl = env.TOT_STOREFRONT_ORIGIN || DEFAULT_ORIGIN;
  const missing = ['TOT_TENANT', 'TOT_CLIENT_ID', 'TOT_CLIENT_SECRET'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`--live needs ${missing.join(', ')}`);
  const client = createHelloInventoryClient({ baseUrl, tenantId: env.TOT_TENANT, clientId: env.TOT_CLIENT_ID, clientSecret: env.TOT_CLIENT_SECRET });
  const loc = env.TOT_LOCATION_ID || FIXTURE.location.locationId;
  const runId = new Date().toISOString();
  const step = (name, res, extra = {}) => {
    log({ event: `hello-inventory:live:${name}`, status: res.status, ok: res.ok, ...(res.ok ? {} : { refusal: res.body }), ...(res.requestId ? { requestId: res.requestId } : {}), ...extra });
    return res;
  };
  const must = (res) => {
    if (!res.ok) throw new Error(`live step refused: ${res.status} ${res.body?.code}`);
    return res;
  };

  // Preview test locations default to isFulfillable: false so shopper availability on a shared preview store is untouched.
  must(step('location', await client.upsertLocation(loc, { ...FIXTURE.location, isFulfillable: false, status: 'active' })));

  let sku = env.TOT_SKU;
  if (!sku) {
    const first = must(step('inventory:first-sku', await client.getInventory({ limit: 1 })));
    sku = first.body.items?.[0]?.sku;
    if (!sku) throw new Error('no catalog SKU on this store preview; set TOT_SKU');
  }

  const items = [
    { sku, locationId: loc, quantityDelta: 5, reason: 'received' },
    { sku, locationId: loc, quantityDelta: -1, reason: 'damaged' },
    { sku, locationId: loc, quantityDelta: -1, reason: 'cycle_count' },
    { sku, locationId: loc, quantityDelta: 1, reason: 'adjustment' },
  ];
  const batch = must(step('movements', await client.postMovements(items, await deriveIdempotencyKey('hello-inv-mv', runId, { items })), {}));
  const balance = batch.body.items.at(-1).balance;
  log({ event: 'hello-inventory:live:movements:receipt', receiptId: batch.body.receiptId, sku, balance });

  const first = must(step('levels:first', await client.putLevels([{ sku, locationId: loc, onHand: Math.max(0, balance - 1), observedAt: new Date().toISOString() }])));
  const second = must(step('levels:repeat', await client.putLevels([{ sku, locationId: loc, onHand: Math.max(0, balance - 1), observedAt: new Date(Date.now() + 1000).toISOString() }])));
  log({ event: 'hello-inventory:live:levels:drift', first: first.body.items[0].quantityDelta, repeat: second.body.items[0].quantityDelta });

  const inv = step('inventory', await client.getInventory({ sku, locationId: loc }));
  if (inv.ok) log({ event: 'hello-inventory:live:inventory:item', sku, mirrorBalance: inv.body.items?.[0]?.mirror?.balance, available: inv.body.items?.[0]?.available });

  const reports = step('reports', await client.getReports({ windowDays: 30 }));
  if (reports.ok) {
    const row = reports.body.reports?.find((r) => r.id === 'sales-velocity')?.skus?.find((s) => s.sku === sku);
    log({ event: 'hello-inventory:live:reports:row', sku, row: row ?? null });
  }
  step('orders', await client.listOrders());

  if (cleanup) {
    must(step('cleanup:zero', await client.putLevels([{ sku, locationId: loc, onHand: 0, observedAt: new Date(Date.now() + 2000).toISOString() }])));
    must(step('cleanup:archive', await client.upsertLocation(loc, { ...FIXTURE.location, isFulfillable: false, status: 'archived' })));
  }
  return { ok: true, sku, locationId: loc, cleanedUp: cleanup };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (process.argv.includes('--live')) {
    const summary = await runLive({ cleanup: process.argv.includes('--cleanup') });
    console.log(JSON.stringify({ event: 'hello-inventory:live:done', ...summary }));
  } else {
    const summary = await runSelfTest();
    console.log(JSON.stringify({ event: 'hello-inventory:self-test:passed', ...summary }));
  }
}
