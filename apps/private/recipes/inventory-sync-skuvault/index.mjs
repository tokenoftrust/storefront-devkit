#!/usr/bin/env node
// Multi-Location WMS Connector Recipe (SkuVault / Finale Inventory / ERP stock masters):
// 1. Declares and inspects warehouse/3PL locations (GET/PUT /api/apps/v1/inventory/locations/{locationId}).
// 2. Reconciles absolute on-hand levels (PUT /api/apps/v1/inventory/levels) with expectedVersion CAS,
//    automatically recovering from 409 version_conflict by re-reading GET /api/apps/v1/inventory.
// 3. Posts atomic batch WMS stock movements (POST /api/apps/v1/inventory/movements, up to 250 items)
//    covering WMS reason codes: receive, pick, cycle_count, damage, transfer_in, transfer_out, return_restock.
// 4. Evaluates inbound inventory.changed CloudEvents for threshold transitions
//    (low_stock, out_of_stock, back_in_stock) with CloudEvents id deduplication.
//
// Run offline self-test:
//   node index.mjs --self-test
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SAMPLE_EVENT = JSON.parse(
  readFileSync(new URL('./fixtures/inventory.changed.cloudevent.json', import.meta.url), 'utf8'),
);

/**
 * Maps WMS/SkuVault reason vocabularies (`receive`, `pick`, `cycle_count`, `damage`,
 * `transfer_in`, `transfer_out`, `return_restock`) to the OpenAPI InventoryMovementReason wire enum.
 */
export const WMS_REASON_TO_CONTRACT = Object.freeze({
  receive: 'received',
  received: 'received',
  pick: 'picked',
  picked: 'picked',
  cycle_count: 'cycle_count',
  damage: 'damaged',
  damaged: 'damaged',
  transfer_in: 'transfer',
  transfer_out: 'transfer',
  transfer: 'transfer',
  return_restock: 'restock',
  restock: 'restock',
  adjustment: 'adjustment',
});

export function normalizeWmsMovementItem(item) {
  const contractReason = WMS_REASON_TO_CONTRACT[item.reason];
  if (!contractReason) {
    throw new Error(`Unsupported WMS movement reason: ${item.reason}`);
  }
  return {
    sku: item.sku,
    locationId: item.locationId ?? 'unspecified',
    quantityDelta: item.quantityDelta,
    reason: contractReason,
  };
}

export function deriveIdempotencyKey(prefix, payload) {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 36);
  return `${prefix}-${digest}`;
}

/**
 * Classifies an `inventory.changed` CloudEvent against previous availability and a low-stock threshold
 * into `out_of_stock`, `low_stock`, `back_in_stock`, or `steady`.
 */
export function classifyThresholdTransition({ previousAvailable, currentAvailable, lowStockThreshold = 5 }) {
  if (currentAvailable <= 0 && (previousAvailable === undefined || previousAvailable > 0)) {
    return 'out_of_stock';
  }
  if (previousAvailable !== undefined && previousAvailable <= 0 && currentAvailable > 0) {
    return 'back_in_stock';
  }
  if (currentAvailable > 0 && currentAvailable <= lowStockThreshold && (previousAvailable === undefined || previousAvailable > lowStockThreshold)) {
    return 'low_stock';
  }
  return 'steady';
}

export function createSkuVaultWmsConnector({ baseUrl, accessToken, fetchImpl = fetch, lowStockThreshold = 5 }) {
  const seenEvents = new Set();
  const lastAvailableBySkuLocation = new Map();

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
    upsertLocation(locationId, locationWrite) {
      return request('PUT', `/inventory/locations/${encodeURIComponent(locationId)}`, { body: locationWrite });
    },

    listLocations() {
      return request('GET', '/inventory/locations');
    },

    getInventory({ sku, locationId = 'unspecified' } = {}) {
      const q = new URLSearchParams({ locationId, ...(sku ? { sku } : {}) });
      return request('GET', `/inventory?${q}`);
    },

    /**
     * Reconciles absolute on-hand stock (`PUT /inventory/levels`) with `expectedVersion` CAS.
     * On `409 version_conflict`, re-reads `GET /inventory` for the latest ledger version and retries once.
     */
    async reconcileLevelsWithCas(items, { idempotencyKeyPrefix = 'wms-lvl' } = {}) {
      if (!Array.isArray(items) || items.length === 0 || items.length > 250) {
        throw new Error('PUT /inventory/levels requires 1..250 items per request');
      }
      const payload = { items };
      const firstKey = deriveIdempotencyKey(idempotencyKeyPrefix, payload);
      const firstAttempt = await request('PUT', '/inventory/levels', {
        body: payload,
        idempotencyKey: firstKey,
      });
      if (firstAttempt.ok || firstAttempt.body?.code !== 'version_conflict') {
        return { ...firstAttempt, retriedAfterConflict: false };
      }

      // Refresh current version from GET /inventory and retry with updated expectedVersion
      const refreshedItems = [];
      for (const item of items) {
        const current = await this.getInventory({ sku: item.sku, locationId: item.locationId });
        const latestVersion = current.body?.items?.[0]?.mirror?.version ?? 1;
        refreshedItems.push({ ...item, expectedVersion: latestVersion });
      }
      const retryPayload = { items: refreshedItems };
      const retryKey = deriveIdempotencyKey(`${idempotencyKeyPrefix}-retry`, retryPayload);
      const retryAttempt = await request('PUT', '/inventory/levels', {
        body: retryPayload,
        idempotencyKey: retryKey,
      });
      return { ...retryAttempt, retriedAfterConflict: true };
    },

    /**
     * Posts a batch of 1..250 WMS movements (`POST /inventory/movements`) in a single atomic transaction.
     */
    async postMovementBatch(rawItems, { idempotencyKey } = {}) {
      if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 250) {
        throw new Error('POST /inventory/movements batch requires 1..250 items');
      }
      const normalized = rawItems.map(normalizeWmsMovementItem);
      const payload = { items: normalized };
      const key = idempotencyKey ?? deriveIdempotencyKey('wms-batch', payload);
      return request('POST', '/inventory/movements', { body: payload, idempotencyKey: key });
    },

    /**
     * Processes a verified `inventory.changed` CloudEvent, deduplicating by `event.id` and
     * emitting threshold transition alerts (`low_stock`, `out_of_stock`, `back_in_stock`).
     */
    handleInventoryChangedWebhook(event) {
      if (seenEvents.has(event.id)) {
        return { duplicate: true, transition: null };
      }
      seenEvents.add(event.id);
      const { sku, locationId, balance, available, asOf } = event.data;
      const key = `${sku}:${locationId}`;
      const previousAvailable = lastAvailableBySkuLocation.get(key);
      const transition = classifyThresholdTransition({
        previousAvailable,
        currentAvailable: available,
        lowStockThreshold,
      });
      lastAvailableBySkuLocation.set(key, available);
      return {
        duplicate: false,
        sku,
        locationId,
        balance,
        available,
        asOf,
        transition,
      };
    },
  };
}

/** In-memory gateway simulator supporting locations, levels with expectedVersion CAS, and batch movements. */
export function createSimulatedWmsGateway() {
  const locations = new Map();
  const ledger = new Map(); // `${sku}:${locationId}` -> { balance, version, asOf }
  const idempotency = new Map();

  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

  return {
    seedSkuVersion(sku, locationId, { balance, version }) {
      ledger.set(`${sku}:${locationId}`, { balance, version, asOf: '2026-11-13T14:00:00.000Z' });
    },
    async fetchImpl(input, init = {}) {
      const url = new URL(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const path = url.pathname.replace(/^\/api\/apps\/v1/, '');

      const locMatch = /^\/inventory\/locations\/([^/]+)$/.exec(path);
      if (method === 'PUT' && locMatch) {
        const locationId = decodeURIComponent(locMatch[1]);
        const body = JSON.parse(init.body);
        const loc = {
          locationId,
          name: body.name,
          kind: body.kind,
          isFulfillable: body.isFulfillable ?? true,
          status: body.status ?? 'active',
          updatedAt: '2026-11-13T14:01:00.000Z',
        };
        locations.set(locationId, loc);
        return json(200, loc);
      }

      if (method === 'GET' && path === '/inventory/locations') {
        return json(200, { items: Array.from(locations.values()) });
      }

      if (method === 'GET' && path === '/inventory') {
        const sku = url.searchParams.get('sku');
        const locationId = url.searchParams.get('locationId') ?? 'unspecified';
        const state = ledger.get(`${sku}:${locationId}`) ?? { balance: 0, version: 1, asOf: '2026-11-13T14:00:00.000Z' };
        return json(200, {
          items: [
            {
              sku,
              available: state.balance > 0,
              quantity: state.balance,
              policy: 'deny',
              mirror: {
                locationId,
                balance: state.balance,
                version: state.version,
                asOf: state.asOf,
              },
            },
          ],
          pageSize: 50,
          total: 1,
          nextCursor: null,
        });
      }

      if (method === 'PUT' && path === '/inventory/levels') {
        const key = headers['idempotency-key'];
        if (!key) return json(400, { code: 'malformed', error: 'malformed' });
        const body = JSON.parse(init.body);
        const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const cached = idempotency.get(key);
        if (cached) {
          if (cached.bodyHash !== bodyHash) return json(409, { code: 'idempotency-conflict', error: 'idempotency-conflict' });
          return json(200, cached.response);
        }
        for (let index = 0; index < body.items.length; index++) {
          const item = body.items[index];
          const k = `${item.sku}:${item.locationId ?? 'unspecified'}`;
          const current = ledger.get(k) ?? { balance: 0, version: 1 };
          if (item.expectedVersion !== undefined && item.expectedVersion !== current.version) {
            return json(409, { code: 'version_conflict', error: 'version_conflict', index });
          }
        }
        const receiptItems = body.items.map((item) => {
          const locationId = item.locationId ?? 'unspecified';
          const k = `${item.sku}:${locationId}`;
          const current = ledger.get(k) ?? { balance: 0, version: 1 };
          const quantityDelta = item.onHand - current.balance;
          const next = { balance: item.onHand, version: current.version + 1, asOf: '2026-11-13T14:05:00.000Z' };
          ledger.set(k, next);
          return {
            sku: item.sku,
            locationId,
            onHand: item.onHand,
            observedAt: item.observedAt,
            quantityDelta,
            balance: next.balance,
          };
        });
        const response = {
          receiptId: `rcpt_lvl_${randomUUID().slice(0, 12)}`,
          asOf: '2026-11-13T14:05:00.000Z',
          items: receiptItems,
        };
        idempotency.set(key, { bodyHash, response });
        return json(200, response);
      }

      if (method === 'POST' && path === '/inventory/movements') {
        const key = headers['idempotency-key'];
        if (!key) return json(400, { code: 'malformed', error: 'malformed' });
        const body = JSON.parse(init.body);
        const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const cached = idempotency.get(key);
        if (cached) {
          if (cached.bodyHash !== bodyHash) return json(409, { code: 'idempotency-conflict', error: 'idempotency-conflict' });
          return json(201, cached.response);
        }
        const items = body.items ?? [body];
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const locationId = item.locationId ?? 'unspecified';
          if (locationId !== 'unspecified' && !locations.has(locationId)) {
            return json(422, { code: 'unknown-location', error: 'unknown-location', index });
          }
        }
        const receiptItems = items.map((item) => {
          const locationId = item.locationId ?? 'unspecified';
          const k = `${item.sku}:${locationId}`;
          const current = ledger.get(k) ?? { balance: 0, version: 1 };
          const nextBalance = current.balance + item.quantityDelta;
          ledger.set(k, { balance: nextBalance, version: current.version + 1, asOf: '2026-11-13T14:06:00.000Z' });
          return {
            sku: item.sku,
            locationId,
            quantityDelta: item.quantityDelta,
            reason: item.reason,
            balance: nextBalance,
          };
        });
        const response = {
          receiptId: `rcpt_batch_${randomUUID().slice(0, 12)}`,
          asOf: '2026-11-13T14:06:00.000Z',
          items: receiptItems,
        };
        idempotency.set(key, { bodyHash, response });
        return json(201, response);
      }

      return json(404, { code: 'not_found', error: 'not_found' });
    },
  };
}

export async function runSelfTest() {
  const sim = createSimulatedWmsGateway();
  const connector = createSkuVaultWmsConnector({
    baseUrl: 'https://tot-preview.tokenoftrust.store',
    accessToken: 'sim-wms-token',
    fetchImpl: sim.fetchImpl,
    lowStockThreshold: 5,
  });

  // 1. Declare two WMS locations (East Warehouse & West 3PL)
  await connector.upsertLocation('wh-east-nj', { name: 'East Coast Warehouse (NJ)', kind: 'warehouse', isFulfillable: true, status: 'active' });
  await connector.upsertLocation('3pl-west-nv', { name: 'West Coast 3PL (NV)', kind: '3pl', isFulfillable: true, status: 'active' });
  const locs = await connector.listLocations();
  assert.equal(locs.body.items.length, 2);

  // 2. Seed version 3 on wh-east-nj, send stale expectedVersion=1 -> verify automatic 409 version_conflict CAS recovery
  sim.seedSkuVersion('VAPE-MOD-PRO-200', 'wh-east-nj', { balance: 40, version: 3 });
  const casResult = await connector.reconcileLevelsWithCas([
    {
      sku: 'VAPE-MOD-PRO-200',
      locationId: 'wh-east-nj',
      onHand: 50,
      observedAt: '2026-11-13T14:04:00.000Z',
      expectedVersion: 1,
    },
  ]);
  assert.equal(casResult.status, 200);
  assert.equal(casResult.retriedAfterConflict, true);
  assert.equal(casResult.body.items[0].balance, 50);

  // 3. Post batch WMS movements across all 7 WMS reason codes
  const batchResult = await connector.postMovementBatch([
    { sku: 'VAPE-MOD-PRO-200', locationId: 'wh-east-nj', quantityDelta: 20, reason: 'receive' },
    { sku: 'VAPE-MOD-PRO-200', locationId: 'wh-east-nj', quantityDelta: -5, reason: 'pick' },
    { sku: 'VAPE-MOD-PRO-200', locationId: 'wh-east-nj', quantityDelta: -2, reason: 'cycle_count' },
    { sku: 'VAPE-MOD-PRO-200', locationId: 'wh-east-nj', quantityDelta: -1, reason: 'damage' },
    { sku: 'VAPE-MOD-PRO-200', locationId: 'wh-east-nj', quantityDelta: -10, reason: 'transfer_out' },
    { sku: 'VAPE-MOD-PRO-200', locationId: '3pl-west-nv', quantityDelta: 10, reason: 'transfer_in' },
    { sku: 'VAPE-MOD-PRO-200', locationId: '3pl-west-nv', quantityDelta: 2, reason: 'return_restock' },
  ]);
  assert.equal(batchResult.status, 201);
  assert.equal(batchResult.body.items.length, 7);

  // 4. Verify inventory.changed threshold transitions: steady -> low_stock -> out_of_stock -> back_in_stock
  const t1 = connector.handleInventoryChangedWebhook({
    ...SAMPLE_EVENT,
    id: 'evt_wms_1',
    data: { ...SAMPLE_EVENT.data, balance: 15, available: 15 },
  });
  assert.equal(t1.transition, 'steady');

  const t2 = connector.handleInventoryChangedWebhook(SAMPLE_EVENT); // available: 4 <= threshold 5
  assert.equal(t2.transition, 'low_stock');

  const t3 = connector.handleInventoryChangedWebhook({
    ...SAMPLE_EVENT,
    id: 'evt_wms_3',
    data: { ...SAMPLE_EVENT.data, balance: 0, available: 0 },
  });
  assert.equal(t3.transition, 'out_of_stock');

  const t4 = connector.handleInventoryChangedWebhook({
    ...SAMPLE_EVENT,
    id: 'evt_wms_4',
    data: { ...SAMPLE_EVENT.data, balance: 25, available: 25 },
  });
  assert.equal(t4.transition, 'back_in_stock');

  return {
    ok: true,
    locationsDeclared: locs.body.items.length,
    casRetriedAfterConflict: casResult.retriedAfterConflict,
    batchItemsCommitted: batchResult.body.items.length,
    transitions: [t1.transition, t2.transition, t3.transition, t4.transition],
  };
}

if (process.argv.includes('--self-test') || import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runSelfTest();
  console.log(JSON.stringify({ event: 'inventory-sync-skuvault:self-test:passed', ...summary }));
}
