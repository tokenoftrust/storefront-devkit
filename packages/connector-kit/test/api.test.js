import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError, deriveIdempotencyKey } from '../src/index.js';

const ORIGIN = 'https://acme.example.com';

function staticAuth() {
  let n = 1;
  const invalidated = [];
  return {
    invalidated,
    getAccessToken: async () => `tok-${n}`,
    invalidate(token) {
      invalidated.push(token);
      n++;
    },
  };
}

/** A gateway double answering from a queue (last answer repeats) and recording every request. */
function gateway(...answers) {
  const requests = [];
  let n = 0;
  const fetch = async (url, init) => {
    requests.push({ url: new URL(url), method: init.method, headers: init.headers, body: init.body, redirect: init.redirect });
    const answer = answers[Math.min(n++, answers.length - 1)];
    const a = typeof answer === 'function' ? answer(requests.at(-1)) : answer;
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json', ...a.headers } });
  };
  return { fetch, requests };
}

function client(gw, overrides = {}) {
  const sleeps = [];
  const api = new ApiClient({ origin: ORIGIN, auth: staticAuth(), fetch: gw.fetch, sleep: async (ms) => sleeps.push(ms), random: () => 0.5, ...overrides });
  return { api, sleeps };
}

test('a write carries an Idempotency-Key that is reused, with the same bytes, across retries', async () => {
  const gw = gateway({ status: 503, body: { code: 'unavailable' } }, { status: 502 }, { status: 201, body: { receiptId: 'r1' } });
  const { api } = client(gw);
  const res = await api.post('/inventory/movements', { sku: 'SKU-1', quantityDelta: -2 }, { idempotencyKey: 'inv-0001-abcdef' });
  assert.equal(res.status, 201);
  assert.equal(res.idempotencyKey, 'inv-0001-abcdef');
  assert.equal(gw.requests.length, 3);
  for (const req of gw.requests) {
    assert.equal(req.headers['idempotency-key'], 'inv-0001-abcdef');
    assert.equal(req.body, '{"sku":"SKU-1","quantityDelta":-2}');
    assert.equal(req.url.pathname, '/api/apps/v1/inventory/movements');
    assert.equal(req.redirect, 'manual');
  }
});

test('a write without a key gets one generated once and reused on retry; a read carries none', async () => {
  const gw = gateway({ status: 429, headers: { 'retry-after': '1' } }, { status: 200, body: {} });
  const { api } = client(gw);
  const res = await api.put('/inventory/locations/loc-1', { name: 'Main' });
  const [first, second] = gw.requests;
  assert.match(first.headers['idempotency-key'], /^ck-[0-9a-f-]{36}$/);
  assert.equal(second.headers['idempotency-key'], first.headers['idempotency-key']);
  assert.equal(res.idempotencyKey, first.headers['idempotency-key']);

  const reads = gateway({ body: {} });
  await client(reads).api.get('/app');
  assert.equal(reads.requests[0].headers['idempotency-key'], undefined);
  await assert.rejects(client(reads).api.get('/app', { idempotencyKey: 'abcdefgh' }), /takes no idempotencyKey/);
});

test('Retry-After is honored exactly, in seconds or as an HTTP-date', async () => {
  const gw = gateway({ status: 429, headers: { 'retry-after': '7' }, body: { code: 'rate_limited' } }, { body: { ok: true } });
  const { api, sleeps } = client(gw);
  await api.get('/inventory');
  assert.deepEqual(sleeps, [7000]);

  const now = Date.parse('2026-11-16T12:00:00Z');
  const dated = gateway({ status: 503, headers: { 'retry-after': 'Mon, 16 Nov 2026 12:00:03 GMT' } }, { body: {} });
  const second = client(dated, { now: () => now });
  await second.api.get('/inventory');
  assert.deepEqual(second.sleeps, [3000]);
});

test('a Retry-After longer than the in-process cap is returned to the caller, not waited', async () => {
  const gw = gateway({ status: 429, headers: { 'retry-after': '3600' }, body: { code: 'quota' } });
  const { api, sleeps } = client(gw);
  const err = await api.get('/fulfillment/orders/o1/recipient').catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.code, 'quota');
  assert.equal(err.retryAfterMs, 3_600_000);
  assert.deepEqual(sleeps, []);
  assert.equal(gw.requests.length, 1);
});

test('retries are bounded, with full-jitter exponential backoff under the cap', async () => {
  const gw = gateway({ status: 503, body: { code: 'unavailable' } });
  const { api, sleeps } = client(gw, { retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 300 }, random: () => 0.999 });
  const err = await api.get('/inventory').catch((e) => e);
  assert.equal(err.code, 'unavailable');
  assert.equal(err.retryable, true);
  assert.equal(gw.requests.length, 4);
  assert.deepEqual(sleeps, [99, 199, 299]);
});

test('a network failure is retried; a non-retryable refusal is not', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response('{}', { status: 200 });
  };
  const { api } = client({ fetch: flaky });
  assert.equal((await api.get('/app')).status, 200);
  assert.equal(calls, 2);

  const conflict = gateway({ status: 409, body: { code: 'idempotency-conflict', error: 'key reused for cid with another body' } });
  const err = await client(conflict).api.post('/inventory/movements', {}, { idempotencyKey: 'key-00000001' }).catch((e) => e);
  assert.equal(err.code, 'idempotency-conflict');
  assert.equal(conflict.requests.length, 1);
  assert.ok(!err.message.includes('reused'), 'remote text never enters the error');
});

test('one 401 invalidates the token and repeats the call with a fresh one', async () => {
  const gw = gateway({ status: 401, body: { code: 'invalid_token' } }, { body: { ok: true } });
  const auth = staticAuth();
  const { api } = client(gw, { auth });
  await api.get('/app');
  assert.deepEqual(auth.invalidated, ['tok-1']);
  assert.equal(gw.requests[0].headers.authorization, 'Bearer tok-1');
  assert.equal(gw.requests[1].headers.authorization, 'Bearer tok-2');

  const always401 = gateway({ status: 401, body: { code: 'invalid_token' } });
  assert.equal((await client(always401).api.get('/app').catch((e) => e)).code, 'invalid_token');
  assert.equal(always401.requests.length, 2, 'the refresh is tried once, not looped');
});

test('pagination drains every page, carrying limit and updatedSince on each', async () => {
  const pages = {
    '': { products: [{ handle: 'a' }, { handle: 'b' }], nextCursor: 'c1' },
    c1: { products: [{ handle: 'c' }], nextCursor: 'c2' },
    c2: { products: [{ handle: 'd' }] },
  };
  const gw = gateway((req) => ({ body: pages[req.url.searchParams.get('cursor') ?? ''] }));
  const { api } = client(gw);
  const since = new Date('2026-11-01T00:00:00Z');
  const result = await api.collect('/catalog/products', { limit: 2, updatedSince: since });
  assert.deepEqual(result.items.map((p) => p.handle), ['a', 'b', 'c', 'd']);
  assert.equal(result.pages, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(gw.requests.map((r) => r.url.searchParams.get('cursor')), [null, 'c1', 'c2']);
  for (const req of gw.requests) {
    assert.equal(req.url.searchParams.get('limit'), '2');
    assert.equal(req.url.searchParams.get('updatedSince'), '2026-11-01T00:00:00.000Z');
  }

  const handles = [];
  for await (const item of api.items('/catalog/products', { limit: 2 })) handles.push(item.handle);
  assert.deepEqual(handles, ['a', 'b', 'c', 'd']);
});

test('pagination reports truncation, resumes from a cursor, and refuses a stalled cursor', async () => {
  const truncated = gateway({ body: { orders: [{ id: 1 }], truncated: true } });
  assert.equal((await client(truncated).api.collect('/orders', { updatedSince: '2026-11-01T00:00:00Z' })).truncated, true);

  const resumed = gateway({ body: { items: [] } });
  await client(resumed).api.collect('/inventory', { cursor: 'saved' });
  assert.equal(resumed.requests[0].url.searchParams.get('cursor'), 'saved');

  const stalled = gateway({ body: { items: [1], nextCursor: 'same' } });
  const err = await client(stalled).api.collect('/inventory', { cursor: 'same' }).catch((e) => e);
  assert.equal(err.code, 'pagination_stalled');

  const ambiguous = gateway({ body: { a: [], b: [] } });
  await assert.rejects(client(ambiguous).api.collect('/x'), /pass itemsKey/);
  assert.deepEqual((await client(ambiguous).api.collect('/x', { itemsKey: 'a' })).items, []);
});

test('the error model: body code, holds, request id; a shapeless code becomes unexpected', async () => {
  const held = gateway({ status: 409, headers: { 'tot-request-id': 'req_123' }, body: { code: 'assignment-held', holds: ['label', 'Not A Code'] } });
  const err = await client(held).api.post('/fulfillment/orders/o1/shipment-evidence', {}, { idempotencyKey: 'ev-00000001' }).catch((e) => e);
  assert.deepEqual(err.toJSON(), { kind: 'api', code: 'assignment-held', status: 409, requestId: 'req_123', retryable: false, holds: ['label', 'unexpected'] });
  assert.equal(err.message, 'api:assignment-held (409)');

  const weird = gateway({ status: 400, body: { code: 'Some <script> text' } });
  assert.equal((await client(weird).api.get('/app').catch((e) => e)).code, 'unexpected');
  const empty = gateway({ status: 404 });
  assert.equal((await client(empty).api.get('/app').catch((e) => e)).code, 'http_404');
});

test('redirects are refused and paths cannot leave /api/apps/v1', async () => {
  const redirect = gateway({ status: 302, headers: { location: 'https://elsewhere.example/' } });
  assert.equal((await client(redirect).api.get('/app').catch((e) => e)).code, 'redirect_refused');
  const { api } = client(gateway({ body: {} }));
  for (const bad of ['/../admin/install', '/%2e%2e/admin', 'inventory', '/inventory?x=1', 'https://elsewhere.example/x']) {
    await assert.rejects(api.get(bad), /path must be/, bad);
  }
});

test('deriveIdempotencyKey is stable for the same fact regardless of key order', async () => {
  const a = await deriveIdempotencyKey('ev', 'o1', { kind: 'handoff', carrier: 'X' });
  const b = await deriveIdempotencyKey('ev', 'o1', { carrier: 'X', kind: 'handoff' });
  const c = await deriveIdempotencyKey('ev', 'o2', { carrier: 'X', kind: 'handoff' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^ev-[0-9a-f]{48}$/);
});
