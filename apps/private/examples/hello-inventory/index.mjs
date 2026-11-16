#!/usr/bin/env node
// Starter reference app for Storefront Private Apps v1.3:
// 1. Declares an active stock location (PUT /api/apps/v1/inventory/locations/{locationId})
//    and lists declared locations (GET /api/apps/v1/inventory/locations).
// 2. Reads current stock availability and mirror-ledger balance (GET /api/apps/v1/inventory).
// 3. Posts an idempotent stock adjustment/movement (POST /api/apps/v1/inventory/movements)
//    and replays the identical Idempotency-Key to prove receipt stability.
// 4. Verifies a synthetic preview order created via POST /api/apps/admin/test-orders
//    by reading GET /api/apps/v1/orders.
//
// Run offline self-test:
//   node index.mjs --self-test
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/sample-workflow.json', import.meta.url), 'utf8'));

/** Derive a deterministic Idempotency-Key (8..128 chars) bound to the canonical payload. */
export function buildIdempotencyKey(prefix, payload) {
  const canonical = JSON.stringify(Object.keys(payload).sort().map((k) => [k, payload[k]]));
  const digest = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `${prefix}-${digest}`;
}

export function createHelloInventoryClient({ baseUrl, clientId, clientSecret, adminBearer, tenantId, fetchImpl = fetch }) {
  let cachedToken = null;

  async function getAccessToken() {
    if (cachedToken) return cachedToken;
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetchImpl(`${baseUrl}/api/apps/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    const body = await res.json();
    if (!res.ok || !body.access_token) {
      throw new Error(`OAuth token exchange failed: ${res.status} ${body.error ?? 'unknown'}`);
    }
    cachedToken = body.access_token;
    return cachedToken;
  }

  async function apiRequest(method, path, { body, idempotencyKey } = {}) {
    const token = await getAccessToken();
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
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
    upsertLocation(locationId, { name, kind = 'warehouse', isFulfillable = true, status = 'active' }) {
      return apiRequest('PUT', `/inventory/locations/${encodeURIComponent(locationId)}`, {
        body: { name, kind, isFulfillable, status },
      });
    },
    listLocations() {
      return apiRequest('GET', '/inventory/locations');
    },
    getInventory({ sku, locationId = 'unspecified', limit = 50 } = {}) {
      const query = new URLSearchParams({ locationId, limit: String(limit), ...(sku ? { sku } : {}) });
      return apiRequest('GET', `/inventory?${query}`);
    },
    postMovement(movement, idempotencyKey = buildIdempotencyKey('hello-inv', movement)) {
      return apiRequest('POST', '/inventory/movements', { body: movement, idempotencyKey });
    },
    listOrders({ page = 1, pageSize = 24 } = {}) {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      return apiRequest('GET', `/orders?${query}`);
    },
    async createSyntheticPreviewOrder() {
      const headers = {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${adminBearer}`,
        'x-tot-tenant': tenantId,
        'x-tot-caller-capability': 'preview-access',
      };
      const res = await fetchImpl(`${baseUrl}/api/apps/admin/test-orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'create' }),
      });
      return { status: res.status, ok: res.ok, body: await res.json() };
    },
  };
}

/** In-memory gateway simulator for offline verification (`--self-test` and `node --test`). */
export function createSimulatedHelloGateway() {
  const locations = new Map([
    [
      'unspecified',
      {
        locationId: 'unspecified',
        name: 'Default Location',
        kind: 'warehouse',
        isFulfillable: true,
        status: 'active',
        updatedAt: '2026-11-13T12:00:00.000Z',
      },
    ],
  ]);
  const balances = new Map([[`${FIXTURE.catalogSku}:loc-main-warehouse`, 20]]);
  const idempotencyStore = new Map();
  const previewOrders = [];

  const json = (status, payload) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

  return async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

    if (method === 'POST' && url.pathname === '/api/apps/oauth/token') {
      return json(200, {
        access_token: 'sim-preview-jwt-token',
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'catalog:read inventory:read inventory:write orders:read:minimal',
      });
    }

    if (method === 'POST' && url.pathname === '/api/apps/admin/test-orders') {
      const body = JSON.parse(init.body);
      if (body.action === 'create') {
        const orderId = `ord_preview_${previewOrders.length + 1}`;
        previewOrders.push({
          id: orderId,
          status: 'created',
          currency: 'USD',
          customerHash: createHash('sha256').update(`preview-cust-${orderId}`).digest('hex'),
          subtotal: 35,
          total: 38.5,
          lineItems: [{ sku: FIXTURE.catalogSku, handle: 'classic-tee', quantity: 1, lineTotal: 35 }],
          createdAt: '2026-11-13T12:05:00.000Z',
        });
        return json(201, { order: { orderId, stage: 'preview' } });
      }
      return json(400, { error: 'invalid_action', code: 'invalid_action' });
    }

    const path = url.pathname.replace(/^\/api\/apps\/v1/, '');

    const locMatch = /^\/inventory\/locations\/([^/]+)$/.exec(path);
    if (method === 'PUT' && locMatch) {
      const locationId = decodeURIComponent(locMatch[1]);
      const body = JSON.parse(init.body);
      const record = {
        locationId,
        name: body.name,
        kind: body.kind,
        isFulfillable: body.isFulfillable ?? true,
        status: body.status ?? 'active',
        updatedAt: '2026-11-13T12:01:00.000Z',
      };
      locations.set(locationId, record);
      return json(200, record);
    }

    if (method === 'GET' && path === '/inventory/locations') {
      return json(200, { items: Array.from(locations.values()) });
    }

    if (method === 'GET' && path === '/inventory') {
      const sku = url.searchParams.get('sku') ?? FIXTURE.catalogSku;
      const locationId = url.searchParams.get('locationId') ?? 'unspecified';
      const balance = balances.get(`${sku}:${locationId}`) ?? 0;
      return json(200, {
        items: [
          {
            sku,
            available: balance > 0,
            quantity: balance,
            policy: 'deny',
            mirror: { locationId, balance, asOf: '2026-11-13T12:02:00.000Z' },
          },
        ],
        pageSize: 50,
        total: 1,
        nextCursor: null,
      });
    }

    if (method === 'POST' && (path === '/inventory/movements' || path === '/inventory/adjustments')) {
      const key = headers['idempotency-key'];
      if (!key || key.length < 8) return json(400, { code: 'malformed', error: 'malformed' });
      const body = JSON.parse(init.body);
      const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const existing = idempotencyStore.get(key);
      if (existing) {
        if (existing.bodyHash !== bodyHash) {
          return json(409, { code: 'idempotency-conflict', error: 'idempotency-conflict' });
        }
        return json(201, existing.receipt);
      }
      const locationId = body.locationId ?? 'unspecified';
      if (!locations.has(locationId)) {
        return json(422, { code: 'unknown-location', error: 'unknown-location' });
      }
      const mapKey = `${body.sku}:${locationId}`;
      const nextBalance = (balances.get(mapKey) ?? 0) + body.quantityDelta;
      if (nextBalance < 0) {
        return json(409, { code: 'balance-out-of-range', error: 'balance-out-of-range' });
      }
      balances.set(mapKey, nextBalance);
      const receipt = {
        receiptId: `rcpt_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
        sku: body.sku,
        locationId,
        quantityDelta: body.quantityDelta,
        asOf: '2026-11-13T12:03:00.000Z',
        balance: nextBalance,
      };
      idempotencyStore.set(key, { bodyHash, receipt });
      return json(201, receipt);
    }

    if (method === 'GET' && path === '/orders') {
      return json(200, {
        orders: previewOrders,
        page: 1,
        pageSize: 24,
        total: previewOrders.length,
      });
    }

    return json(404, { code: 'not_found', message: 'Not found' });
  };
}

export async function runSelfTest() {
  const client = createHelloInventoryClient({
    baseUrl: 'https://tot-preview.tokenoftrust.store',
    clientId: 'sim-client',
    clientSecret: 'sim-secret',
    adminBearer: 'sim-admin-secret',
    tenantId: 'acme',
    fetchImpl: createSimulatedHelloGateway(),
  });

  // 1. Upsert stock location and verify GET /inventory/locations
  const upserted = await client.upsertLocation(FIXTURE.location.locationId, FIXTURE.location);
  assert.equal(upserted.status, 200);
  assert.equal(upserted.body.locationId, 'loc-main-warehouse');

  const locList = await client.listLocations();
  assert.equal(locList.status, 200);
  assert.ok(locList.body.items.some((l) => l.locationId === 'loc-main-warehouse'));

  // 2. Read initial inventory at loc-main-warehouse
  const initialInv = await client.getInventory({ sku: FIXTURE.catalogSku, locationId: 'loc-main-warehouse' });
  assert.equal(initialInv.status, 200);
  assert.equal(initialInv.body.items[0].mirror.balance, 20);

  // 3. Post stock movement (+5 adjustment) and replay with identical Idempotency-Key
  const idemKey = buildIdempotencyKey('hello-inv', FIXTURE.movementWrite);
  const firstMove = await client.postMovement(FIXTURE.movementWrite, idemKey);
  assert.equal(firstMove.status, 201);
  assert.equal(firstMove.body.balance, 25);

  const replayMove = await client.postMovement(FIXTURE.movementWrite, idemKey);
  assert.equal(replayMove.status, 201);
  assert.equal(replayMove.body.receiptId, firstMove.body.receiptId);
  assert.equal(replayMove.body.balance, 25);

  // 4. Create synthetic preview order via POST /api/apps/admin/test-orders and read via GET /orders
  const createdOrder = await client.createSyntheticPreviewOrder();
  assert.equal(createdOrder.status, 201);
  assert.equal(createdOrder.body.order.stage, 'preview');

  const orders = await client.listOrders();
  assert.equal(orders.status, 200);
  assert.equal(orders.body.orders.length, 1);
  assert.equal(orders.body.orders[0].id, createdOrder.body.order.orderId);

  return {
    ok: true,
    locationId: upserted.body.locationId,
    receiptId: firstMove.body.receiptId,
    balance: firstMove.body.balance,
    previewOrderId: createdOrder.body.order.orderId,
  };
}

if (process.argv.includes('--self-test') || import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runSelfTest();
  console.log(JSON.stringify({ event: 'hello-inventory:self-test:passed', ...summary }));
}
