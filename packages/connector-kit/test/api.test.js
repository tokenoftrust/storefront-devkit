import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { ApiClient, ApiError, AuthError, deriveIdempotencyKey } from '../src/index.js';

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

test('a failed write carries the key it was sent under, so a scheduled retry resends under it', async () => {
  const gw = gateway({ status: 429, headers: { 'retry-after': '3600' }, body: { code: 'quota' } });
  const err = await client(gw).api.post('/inventory/movements', { sku: 'SKU-1' }).catch((e) => e);
  const sent = gw.requests[0].headers['idempotency-key'];
  assert.match(sent, /^ck-/);
  assert.equal(err.idempotencyKey, sent);
  assert.equal(err.toJSON().idempotencyKey, sent);

  let calls = 0;
  const down = async () => {
    calls++;
    throw new TypeError('fetch failed');
  };
  const netErr = await client({ fetch: down }, { retry: { maxAttempts: 2 } }).api.put('/inventory/levels', {}, { idempotencyKey: 'lvl-00000001' }).catch((e) => e);
  assert.equal(netErr.code, 'network');
  assert.equal(netErr.idempotencyKey, 'lvl-00000001');
  assert.equal(calls, 2);
});

test('a token failure is not retried again by the API client', async () => {
  let tokenCalls = 0;
  const auth = {
    getAccessToken: async () => {
      tokenCalls++;
      throw new AuthError({ code: 'temporarily_unavailable', status: 503, retryable: true });
    },
  };
  const gw = gateway({ body: {} });
  const { api, sleeps } = client(gw, { auth });
  assert.equal((await api.get('/app').catch((e) => e)).code, 'temporarily_unavailable');
  assert.equal(tokenCalls, 1);
  assert.deepEqual(sleeps, []);
  assert.equal(gw.requests.length, 0);
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

test('the retry timer removes its abort listener after each wait', async () => {
  const { signal } = new AbortController();
  const listener = () => {};
  signal.addEventListener('abort', listener);
  const retry = { status: 503, headers: { 'retry-after': '0' } };
  const gw = gateway(retry, retry, { body: { ok: true } });
  const api = new ApiClient({ origin: ORIGIN, auth: staticAuth(), fetch: gw.fetch });
  assert.deepEqual((await api.get('/app', { signal })).body, { ok: true });
  assert.equal(gw.requests.length, 3);
  assert.deepEqual(getEventListeners(signal, 'abort'), [listener]);
});

test('aborting a retry wait removes its listener and prevents another request', async () => {
  const controller = new AbortController();
  const { signal } = controller;
  const gw = gateway({ status: 503, headers: { 'retry-after': '1' } }, { body: { ok: true } });
  let startedRetry;
  const retrying = new Promise((resolve) => { startedRetry = resolve; });
  const api = new ApiClient({ origin: ORIGIN, auth: staticAuth(), fetch: gw.fetch, onRetry: startedRetry });
  const pending = api.get('/app', { signal });
  await Promise.race([retrying, pending]);
  assert.equal(getEventListeners(signal, 'abort').length, 1);
  const reason = new Error('test abort');
  const aborted = assert.rejects(pending, (err) => err === reason);
  controller.abort(reason);
  await aborted;
  assert.deepEqual(getEventListeners(signal, 'abort'), []);
  assert.equal(gw.requests.length, 1);
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

test('page limits must be integers from 1 through 100 before any fetch', async (t) => {
  const gw = gateway({ body: { items: [] } });
  const { api } = client(gw);
  for (const limit of [-1, 0, 101, 1.5, '5', null, NaN, Infinity]) {
    await t.test(String(limit), async () => {
      const before = gw.requests.length;
      await assert.rejects(api.pages('/inventory', { limit }).next(), { name: 'TypeError', message: /limit/ });
      assert.equal(gw.requests.length, before);
    });
  }
  const before = gw.requests.length;
  for (const limit of [1, 100]) await api.collect('/inventory', { limit });
  assert.deepEqual(gw.requests.slice(before).map(({ url }) => url.searchParams.get('limit')), ['1', '100']);
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

  const cycle = { '': 'A', A: 'B', B: 'A' };
  const cyclic = gateway((req) => ({ body: { items: [1], nextCursor: cycle[req.url.searchParams.get('cursor') ?? ''] } }));
  // maxPages only bounds this test if the guard is broken; the guard must fire first.
  assert.equal((await client(cyclic).api.collect('/inventory', { maxPages: 10 }).catch((e) => e)).code, 'pagination_stalled');
  assert.equal(cyclic.requests.length, 3, 'A→B→A is caught on the first repeat');

  const ambiguous = gateway({ body: { a: [], b: [] } });
  await assert.rejects(client(ambiguous).api.collect('/x'), /pass itemsKey/);
  assert.deepEqual((await client(ambiguous).api.collect('/x', { itemsKey: 'a' })).items, []);
});

test('the error model: body code, holds, request id; a shapeless code becomes unexpected', async () => {
  const held = gateway({ status: 409, headers: { 'tot-request-id': 'req_123' }, body: { code: 'assignment-held', holds: ['label', 'Not A Code'] } });
  const err = await client(held).api.post('/fulfillment/orders/o1/shipment-evidence', {}, { idempotencyKey: 'ev-00000001' }).catch((e) => e);
  assert.deepEqual(err.toJSON(), { kind: 'api', code: 'assignment-held', status: 409, requestId: 'req_123', retryable: false, holds: ['label', 'unexpected'], idempotencyKey: 'ev-00000001' });
  assert.equal(err.message, 'api:assignment-held (409)');

  const weird = gateway({ status: 400, body: { code: 'Some <script> text' } });
  assert.equal((await client(weird).api.get('/app').catch((e) => e)).code, 'unexpected');
  const empty = gateway({ status: 404 });
  assert.equal((await client(empty).api.get('/app').catch((e) => e)).code, 'http_404');
});

test('inventory batch refusals expose only the documented field and index details', async () => {
  const gw = gateway(
    { status: 400, body: { code: 'malformed', field: 'items[0].quantityDelta', index: 0, message: 'fixture-message', error_description: 'fixture-description' } },
    { status: 422, body: { code: 'unknown-location', field: 'Idempotency-Key', index: 249 } },
    { status: 409, body: { code: 'balance-out-of-range', index: 1 } },
    { status: 400, body: { code: 'malformed', field: 'invalid field <fixture>', index: -1, reasons: ['unavailable'] } },
    { status: 422, body: { code: 'unknown-location', field: 'x'.repeat(129), index: '2' } },
    { status: 422, body: { code: 'unknown-location', index: Number.MAX_SAFE_INTEGER + 1 } },
  );
  const { api } = client(gw);
  const idempotencyKey = 'fixture-write';
  const submit = () => api.post('/inventory/movements', { items: [{}] }, { idempotencyKey }).catch((err) => err);
  const malformed = await submit();
  assert.ok(malformed instanceof ApiError);
  assert.equal(malformed.field, 'items[0].quantityDelta');
  assert.equal(malformed.index, 0);
  assert.deepEqual(malformed.toJSON(), {
    kind: 'api', code: 'malformed', status: 400, retryable: false, field: 'items[0].quantityDelta', index: 0, idempotencyKey,
  });
  assert.doesNotMatch(`${malformed.message} ${JSON.stringify(malformed)}`, /fixture-message|fixture-description/);
  const unknownLocation = await submit();
  assert.equal(unknownLocation.field, 'Idempotency-Key');
  assert.equal(unknownLocation.index, 249);
  const outOfRange = await submit();
  assert.equal(outOfRange.code, 'balance-out-of-range');
  assert.equal(outOfRange.status, 409);
  assert.equal(outOfRange.index, 1);
  for (const invalid of [await submit(), await submit(), await submit()]) {
    for (const detail of ['field', 'index', 'reasons']) assert.equal(Object.hasOwn(invalid.toJSON(), detail), false);
  }
});

test('conflict refusals expose machine-readable reasons and omit misplaced batch indices', async () => {
  const gw = gateway(
    { status: 409, body: { code: 'conflict', reasons: ['version_conflict', 'Invalid reason text', null, 'label'], index: 2 } },
    { status: 400, body: { code: 'malformed', index: 0 } },
  );
  const { api } = client(gw);
  const err = await api.get('/inventory/levels').catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.deepEqual(err.reasons, ['version_conflict', 'label']);
  assert.deepEqual(err.toJSON(), {
    kind: 'api', code: 'conflict', status: 409, retryable: false, reasons: ['version_conflict', 'label'],
  });
  const other = await api.get('/app').catch((e) => e);
  assert.equal(Object.hasOwn(other.toJSON(), 'index'), false);
});

test('redirects are refused and paths cannot leave /api/apps/v1', async () => {
  const redirect = gateway({ status: 302, headers: { location: 'https://elsewhere.example/' } });
  assert.equal((await client(redirect).api.get('/app').catch((e) => e)).code, 'redirect_refused');
  const { api } = client(gateway({ body: {} }));
  for (const bad of ['/../admin/install', '/%2e%2e/admin', 'inventory', '/inventory?x=1', 'https://elsewhere.example/x']) {
    await assert.rejects(api.get(bad), /path must be/, bad);
  }
});

test('tenant API requests refuse encoded path separators before fetch', async (t) => {
  const gw = gateway({ body: {} });
  const { api } = client(gw, { tenant: 'sample-store' });
  for (const path of ['/inventory/a%2Fb', '/inventory/a%5Cb']) {
    await t.test(path, async () => {
      const before = gw.requests.length;
      await assert.rejects(api.get(path), /path must be/);
      assert.equal(gw.requests.length, before);
    });
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
