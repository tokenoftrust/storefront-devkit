// The scoped preview transport, alone and as the deployed app composes it.
// Every test here counts what reaches the inner fetch: a refusal must happen
// before any network I/O, and a refusal the storefront answers must not be
// followed by a new token request or a retry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeployedApp } from '../src/app.js';
import { createGatewayClient } from '../src/gateway-client.js';
import { createLogger } from '../src/log.js';
import { createPreviewFetch, PREVIEW_CONTEXT_REFUSED, TransportRefusal } from '../src/preview-transport.js';
import {
  createLocalGateway,
  example,
  PREVIEW_CONTEXT_REFUSED as SIM_PREVIEW_CONTEXT_REFUSED,
  previewCapabilityFor,
  SIM_BASE_URL,
  SIM_CLIENT_ID,
  SIM_CLIENT_SECRET,
  SIM_PREVIEW_BASE_URL,
  SIM_PREVIEW_CAPABILITY,
  SIM_WEBHOOK_URL,
} from '../sim/local-gateway.js';
import { createWorker } from '../worker.js';

const ORIGIN = SIM_BASE_URL;
const CAPABILITY = SIM_PREVIEW_CAPABILITY;
const FAR = 4_102_444_800_000;
const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

function recorder(respond = ok) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init, calls.length);
  };
  return { calls, fetchImpl };
}

const scoped = (fetchImpl, { now = () => 0, expiresAtMs = FAR } = {}) =>
  createPreviewFetch({ origin: ORIGIN, capability: CAPABILITY, expiresAtMs, fetchImpl, now });

const refusedWith = (code) => (err) => err instanceof TransportRefusal && err.code === code && err.message === code;

test('contract: the storefront refusal code is exactly preview_context_refused', () => {
  assert.equal(PREVIEW_CONTEXT_REFUSED, 'preview_context_refused');
  assert.equal(SIM_PREVIEW_CONTEXT_REFUSED, 'preview_context_refused');
});

// ---- Table: every allowed pair passes; everything else refuses with zero I/O.

const ALLOWED = [
  ['GET', `${ORIGIN}/.well-known/tot-app-authorization-metadata`],
  ['POST', `${ORIGIN}/api/apps/oauth/token`],
  ['GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments`],
  ['GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments?limit=100`],
  ['GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments?limit=100&cursor=abc%2B%2F%3D`],
  ['GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_10482/recipient`],
  ['POST', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_10482/shipment-evidence`],
];

for (const [method, url] of ALLOWED) {
  test(`allowed: ${method} ${url.slice(ORIGIN.length)}`, async () => {
    const { calls, fetchImpl } = recorder();
    const body = method === 'POST' ? '{"kind":"handoff"}' : undefined;
    const headers = { Authorization: 'Bearer t-1', 'content-type': 'application/json', 'idempotency-key': 'fc-k-00000001', traceparent: '00-a-b-01' };
    await scoped(fetchImpl)(url, { method, headers, body });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, new URL(url).toString());
    assert.equal(calls[0].init.method, method);
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[0].init.body, body, 'body bytes are passed through unchanged');
    assert.deepEqual(calls[0].init.headers, {
      authorization: 'Bearer t-1',
      'content-type': 'application/json',
      'idempotency-key': 'fc-k-00000001',
      traceparent: '00-a-b-01',
      cookie: `tot_preview=${CAPABILITY}`,
    });
    assert.ok(!calls[0].url.includes(CAPABILITY), 'the capability never enters a URL');
  });
}

const DISALLOWED = [
  // origin
  ['destination_refused', 'POST', 'https://evil.example/api/apps/oauth/token'],
  ['destination_refused', 'GET', 'https://acme.tokenoftrust.store.evil.example/api/apps/v1/fulfillment/assignments'],
  ['destination_refused', 'GET', 'https://sub.acme.tokenoftrust.store/api/apps/v1/fulfillment/assignments'],
  ['destination_refused', 'GET', 'http://acme.tokenoftrust.store/api/apps/v1/fulfillment/assignments'],
  ['destination_refused', 'GET', 'https://acme.tokenoftrust.store:8443/api/apps/v1/fulfillment/assignments'],
  ['destination_refused', 'GET', 'https://user:pw@acme.tokenoftrust.store/api/apps/v1/fulfillment/assignments'],
  ['destination_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments#frag`],
  ['destination_refused', 'GET', 'not a url'],
  // method
  ['route_refused', 'POST', `${ORIGIN}/.well-known/tot-app-authorization-metadata`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/oauth/token`],
  ['route_refused', 'PUT', `${ORIGIN}/api/apps/oauth/token`],
  ['route_refused', 'POST', `${ORIGIN}/api/apps/v1/fulfillment/assignments`],
  ['route_refused', 'POST', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_1/recipient`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_1/shipment-evidence`],
  ['route_refused', 'DELETE', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_1/shipment-evidence`],
  ['route_refused', 'PATCH', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_1/shipment-evidence`],
  // path
  ['route_refused', 'GET', `${ORIGIN}/`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/app`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/orders`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments/`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments/extra`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_1/label`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_1/recipient/extra`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders//recipient`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/a/b/recipient`],
  ['route_refused', 'POST', `${ORIGIN}/api/apps/oauth/token/`],
  ['route_refused', 'GET', `${ORIGIN}/.well-known/jwks.json`],
  ['route_refused', 'POST', `${ORIGIN}/api/publish`],
  ['route_refused', 'GET', `${ORIGIN}/API/apps/v1/fulfillment/assignments`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/%61ssignments`],
  // percent-escaped or dot order id segments
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord%2F1/recipient`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord%201/recipient`],
  ['route_refused', 'POST', `${ORIGIN}/api/apps/v1/fulfillment/orders/%6Frd_1/shipment-evidence`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/.hidden/recipient`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord 1/recipient`],
  // query
  ['route_refused', 'GET', `${ORIGIN}/.well-known/tot-app-authorization-metadata?x=1`],
  ['route_refused', 'POST', `${ORIGIN}/api/apps/oauth/token?client_secret=x`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_1/recipient?limit=1`],
  ['route_refused', 'POST', `${ORIGIN}/api/apps/v1/fulfillment/orders/ord_1/shipment-evidence?cursor=1`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments?tenant=other`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments?limit=1&stage=publication`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments?__preview=x`],
  ['route_refused', 'GET', `${ORIGIN}/api/apps/v1/fulfillment/assignments?limit=1&limit=2`],
];

for (const [code, method, url] of DISALLOWED) {
  test(`refused (${code}): ${method} ${url}`, async () => {
    const { calls, fetchImpl } = recorder();
    await assert.rejects(scoped(fetchImpl)(url, { method }), refusedWith(code));
    assert.equal(calls.length, 0, 'a refused request made network I/O');
  });
}

test('a Request object input is refused before any request', async () => {
  const { calls, fetchImpl } = recorder();
  await assert.rejects(scoped(fetchImpl)(new Request(`${ORIGIN}/api/apps/v1/fulfillment/assignments`)), refusedWith('destination_refused'));
  assert.equal(calls.length, 0);
});

test('a caller-supplied Cookie is refused, not overwritten, in every header shape', async () => {
  for (const headers of [{ Cookie: 'tot_preview=other' }, { cookie: 'a=b' }, new Headers({ cookie: 'a=b' }), [['COOKIE', 'a=b']]]) {
    const { calls, fetchImpl } = recorder();
    await assert.rejects(scoped(fetchImpl)(`${ORIGIN}/api/apps/v1/fulfillment/assignments`, { headers }), refusedWith('cookie_refused'));
    assert.equal(calls.length, 0);
  }
});

for (const status of [301, 302, 303, 307, 308]) {
  test(`a ${status} redirect is refused and never followed`, async () => {
    const { calls, fetchImpl } = recorder(() => new Response(null, { status, headers: { location: 'https://evil.example/' } }));
    await assert.rejects(scoped(fetchImpl)(`${ORIGIN}/api/apps/v1/fulfillment/assignments`), refusedWith('redirect_refused'));
    assert.equal(calls.length, 1, 'no follow-up request');
    assert.equal(calls[0].init.redirect, 'manual');
  });
}

test('an opaqueredirect response is refused and never followed', async () => {
  const { calls, fetchImpl } = recorder(() => ({ type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() }));
  await assert.rejects(scoped(fetchImpl)(`${ORIGIN}/.well-known/tot-app-authorization-metadata`), refusedWith('redirect_refused'));
  assert.equal(calls.length, 1);
});

test('expiry precheck: at and after the capability exp, zero requests; just before, one', async () => {
  const exp = 1_900_000_000;
  for (const [t, expected] of [[exp * 1000 - 1, 1], [exp * 1000, 0], [exp * 1000 + 1, 0]]) {
    const { calls, fetchImpl } = recorder();
    const run = scoped(fetchImpl, { now: () => t, expiresAtMs: exp * 1000 })(`${ORIGIN}/api/apps/v1/fulfillment/assignments`);
    if (expected) await run;
    else await assert.rejects(run, refusedWith('preview_context_expired'));
    assert.equal(calls.length, expected, `at ${t}`);
  }
});

for (const status of [401, 403, 503]) {
  test(`a ${status} ${PREVIEW_CONTEXT_REFUSED} answer is recognised before the body is normalized`, async () => {
    const { calls, fetchImpl } = recorder(() => new Response(JSON.stringify({ code: 'preview_context_refused', error: 'x' }), { status }));
    await assert.rejects(scoped(fetchImpl)(`${ORIGIN}/api/apps/v1/fulfillment/assignments`), refusedWith('preview_context_refused'));
    assert.equal(calls.length, 1);
  });
}

test('other non-2xx answers pass through to the client unchanged', async () => {
  const { fetchImpl } = recorder(() => new Response(JSON.stringify({ code: 'not-assigned' }), { status: 404 }));
  const res = await scoped(fetchImpl)(`${ORIGIN}/api/apps/v1/fulfillment/orders/ord_1/recipient`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, 'not-assigned');
});

// ---- The gateway client over the scoped fetch: no new token, no retry.

function clientOver(respondApi) {
  const counts = { token: 0, api: 0 };
  const inner = async (url, init) => {
    if (url.endsWith('/api/apps/oauth/token')) {
      counts.token++;
      return new Response(JSON.stringify({ access_token: `t-${counts.token}`, expires_in: 300 }), { status: 200 });
    }
    counts.api++;
    return respondApi(counts.api);
  };
  const lines = [];
  const client = createGatewayClient({
    baseUrl: ORIGIN,
    clientId: SIM_CLIENT_ID,
    clientSecret: SIM_CLIENT_SECRET,
    metadata: { tokenEndpoint: async () => `${ORIGIN}/api/apps/oauth/token` },
    fetchImpl: scoped(inner),
    logger: createLogger((l) => lines.push(l)),
    sleep: async () => {},
  });
  return { counts, client, lines };
}

for (const status of [401, 503]) {
  test(`${PREVIEW_CONTEXT_REFUSED} at ${status} triggers no new token request and no retry`, async () => {
    const refused = () => new Response(JSON.stringify({ code: 'preview_context_refused', error: 'preview_context_refused' }), { status });
    const { counts, client, lines } = clientOver(refused);
    await assert.rejects(client.postShipmentEvidence('ord_1', { kind: 'handoff' }, 'fc-handoff-0001'), refusedWith('preview_context_refused'));
    assert.deepEqual(counts, { token: 1, api: 1 });
    assert.equal(lines.length, 0, 'no retry was logged');
  });
}

test('an ordinary 401 still refreshes the token once (unchanged behavior)', async () => {
  const { counts, client } = clientOver((n) => (n === 1 ? new Response(JSON.stringify({ code: 'invalid_token' }), { status: 401 }) : ok()));
  const result = await client.listAssignments().catch((e) => e);
  assert.equal(counts.token, 2);
  assert.ok(result);
});

test('assignment pages send only limit and cursor', async () => {
  const pages = [{ assignments: [], nextCursor: 'c+/=1' }, { assignments: [] }];
  const seen = [];
  const inner = async (url) => {
    if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 300 }));
    seen.push(new URL(url));
    return new Response(JSON.stringify(pages.shift()));
  };
  const client = createGatewayClient({
    baseUrl: ORIGIN,
    clientId: 'c',
    clientSecret: 's',
    metadata: { tokenEndpoint: async () => `${ORIGIN}/api/apps/oauth/token` },
    fetchImpl: scoped(inner),
    logger: createLogger(() => {}),
    sleep: async () => {},
  });
  assert.equal((await client.listAssignments()).ok, true);
  assert.deepEqual(seen.map((u) => [...u.searchParams.keys()]), [['limit'], ['limit', 'cursor']]);
  assert.equal(seen[1].searchParams.get('cursor'), 'c+/=1');
});

test('an order id that needs percent-encoding is refused before any request', async () => {
  const { counts, client } = clientOver(() => ok());
  await assert.rejects(client.readRecipient('ord/../x'), refusedWith('route_refused'));
  await assert.rejects(client.readRecipient('ord 1'), refusedWith('route_refused'));
  assert.equal(counts.api, 0);
});

// ---- The deployed app and Worker, preview-bound by default.

const SENTINEL = 'SENTINELq7x';
const ENV = {
  TOT_APP_CLIENT_ID: SIM_CLIENT_ID,
  TOT_APP_CLIENT_SECRET: SIM_CLIENT_SECRET,
  TOT_STOREFRONT_BASE_URL: SIM_PREVIEW_BASE_URL,
  WEBHOOK_PUBLIC_URL: SIM_WEBHOOK_URL,
  LABEL_PROVIDER: 'simulated',
};

function deployedWorker({ gateway = createLocalGateway({ previewCapability: CAPABILITY }), wrap = (f) => f, now } = {}) {
  const lines = [];
  const inner = wrap(gateway.fetch);
  const worker = createWorker({ fetchImpl: inner, logger: createLogger((l) => lines.push(l)), sleep: async () => {}, ...(now ? { now } : {}) });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  return { gateway, worker, lines, pending, ctx };
}

const delivery = (gateway) => {
  const { method, headers, rawBody } = gateway.deliver(example('fulfillment.assignment.created.cloudevent.json'));
  return new Request(SIM_WEBHOOK_URL, { method, headers, body: rawBody });
};

test('default Worker: delivery, metadata, token, assignments, recipient and evidence all carry only the preview cookie', async () => {
  const { gateway, worker, pending, ctx } = deployedWorker();
  const res = await worker.fetch(delivery(gateway), ENV, ctx);
  assert.equal(res.status, 202);
  assert.deepEqual(await pending[0], { status: 'fulfilled', version: 9 });
  await worker.scheduled({}, ENV, ctx);
  await Promise.all(pending);
  const routes = gateway.calls.requests.map((r) => `${r.method} ${r.path}`);
  for (const route of [
    'GET /.well-known/tot-app-authorization-metadata',
    'POST /api/apps/oauth/token',
    'GET /api/apps/v1/fulfillment/assignments',
    'GET /api/apps/v1/fulfillment/orders/ord_10482/recipient',
    'POST /api/apps/v1/fulfillment/orders/ord_10482/shipment-evidence',
  ]) assert.ok(routes.includes(route), `missing ${route}`);
  for (const r of gateway.calls.requests) {
    assert.equal(r.cookie, `tot_preview=${CAPABILITY}`);
    assert.equal(r.redirect, 'manual');
    assert.ok(!`${r.path}${r.search}`.includes(CAPABILITY) && !r.search.includes('__preview'));
  }
});

test('signing-key refresh goes only through GET metadata', async () => {
  let t = Date.now();
  const { gateway, worker, ctx, pending } = deployedWorker({ now: () => t });
  await worker.fetch(delivery(gateway), ENV, ctx);
  await Promise.all(pending);
  const before = gateway.calls.requests.length;
  t += 31_000;
  const unknown = gateway.deliver(example('fulfillment.assignment.created.cloudevent.json'), { keyid: 'rotated-key' });
  const res = await worker.fetch(new Request(SIM_WEBHOOK_URL, { method: 'POST', headers: unknown.headers, body: unknown.rawBody }), ENV, ctx);
  assert.equal(res.status, 401);
  const refresh = gateway.calls.requests.slice(before);
  assert.equal(refresh.length, 1, 'exactly one bounded refresh');
  assert.deepEqual([refresh[0].method, refresh[0].path, refresh[0].cookie], ['GET', '/.well-known/tot-app-authorization-metadata', `tot_preview=${CAPABILITY}`]);
});

test('a wrong capability: the storefront refusal is surfaced, with no new token request and no retry', async () => {
  const gateway = createLocalGateway({ previewCapability: previewCapabilityFor({ tenantId: 'other', env: 'test', exp: 4_102_444_800 }) });
  const { worker, lines, pending, ctx } = deployedWorker({ gateway });
  await worker.scheduled({}, ENV, ctx);
  await Promise.all(pending);
  assert.deepEqual(gateway.calls.requests.map((r) => `${r.method} ${r.path}`), ['GET /.well-known/tot-app-authorization-metadata'], 'exactly one request: the refused one');
  assert.equal(gateway.calls.requests.filter((r) => r.path === '/api/apps/oauth/token').length, 0);
  const failure = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'reconciliation pass failed');
  assert.deepEqual([failure.errorClass, failure.errorCode], ['TransportRefusal', 'preview_context_refused']);
  assert.ok(!lines.some((l) => /retrying/.test(l)));
});

test('a refusal after metadata and token are cached: one request, no new token, no retry (401 and 503)', async () => {
  for (const status of [401, 503]) {
    let refuse = false;
    const wrap = (inner) => async (url, init) =>
      refuse && new URL(url).pathname.startsWith('/api/apps/v1/')
        ? new Response(JSON.stringify({ code: 'preview_context_refused', error: 'preview_context_refused' }), { status })
        : inner(url, init);
    const gateway = createLocalGateway({ previewCapability: CAPABILITY, assignment: { ...example('fulfillment.assignments.response.json').assignments[0] } });
    const counted = [];
    const { worker, lines, pending, ctx } = deployedWorker({
      gateway,
      wrap: (inner) => {
        const w = wrap(inner);
        return async (url, init) => {
          counted.push(`${init.method} ${new URL(url).pathname}`);
          return w(url, init);
        };
      },
    });
    await worker.scheduled({}, ENV, ctx);
    await Promise.all(pending);
    const warm = counted.length;
    refuse = true;
    await worker.scheduled({}, ENV, ctx);
    await Promise.all(pending);
    assert.deepEqual(counted.slice(warm), ['GET /api/apps/v1/fulfillment/assignments'], `status ${status}`);
    assert.ok(!lines.slice(-3).some((l) => /retrying/.test(l)));
  }
});

function nearExpiryEnv(expSeconds, tenantId = 'sim-tenant', env = 'test') {
  const capability = previewCapabilityFor({ tenantId, env, exp: expSeconds });
  return { capability, env: { ...ENV, TOT_STOREFRONT_BASE_URL: `${SIM_BASE_URL}/?__preview=${capability}` } };
}

test('expiry at the boundary with cached metadata and token: zero outbound effects from fetch and scheduled', async () => {
  const exp = Math.floor(Date.now() / 1000) + 120;
  const { capability, env } = nearExpiryEnv(exp);
  let t = Date.now();
  const gateway = createLocalGateway({ previewCapability: capability });
  const { worker, lines, pending, ctx } = deployedWorker({ gateway, now: () => t });
  await worker.scheduled({}, env, ctx); // warms metadata and token, fulfills the order
  await Promise.all(pending);
  const warm = gateway.calls.requests.length;
  assert.ok(warm >= 4);
  t = exp * 1000;
  const res = await worker.fetch(delivery(gateway), env, ctx);
  assert.equal(res.status, 202, 'the delivery verifies from the cached signing key');
  await Promise.all(pending);
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  assert.equal(gateway.calls.requests.length, warm, 'an expired capability caused outbound requests');
  const codes = lines.map((l) => JSON.parse(l)).filter((l) => l.errorCode).map((l) => l.errorCode);
  assert.ok(codes.length >= 2 && codes.every((c) => c === 'preview_context_expired'));
});

test('a non-test env claim with cached metadata and token: fixed 503 and zero outbound effects', async () => {
  const { worker, gateway, lines, pending, ctx } = deployedWorker();
  await worker.scheduled({}, ENV, ctx);
  await Promise.all(pending);
  const warm = gateway.calls.requests.length;
  const { env } = nearExpiryEnv(4_102_444_800, SENTINEL, 'live');
  const res = await worker.fetch(delivery(gateway), env, ctx);
  assert.equal(res.status, 503);
  assert.equal(await res.text(), '{"code":"config_invalid"}');
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  assert.equal(gateway.calls.requests.length, warm);
  assert.ok(!lines.join('\n').includes(SENTINEL));
});

test('Worker config refusal: fixed 503 from fetch, scheduled makes zero outbound requests, no input echoed', async () => {
  const bad = { ...ENV, TOT_STOREFRONT_BASE_URL: `${SIM_BASE_URL}/?__preview=${SENTINEL}` };
  const { worker, gateway, lines, pending, ctx } = deployedWorker();
  const res = await worker.fetch(delivery(gateway), bad, ctx);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(await res.text(), '{"code":"config_invalid"}');
  await worker.scheduled({}, bad, ctx);
  assert.equal(pending.length, 0);
  assert.equal(gateway.calls.requests.length, 0);
  assert.ok(lines.length >= 2);
  assert.ok(!lines.join('\n').includes(SENTINEL));
});

test('a foreign or off-path token endpoint in metadata: zero calls to the foreign sink', async () => {
  for (const endpoint of ['https://evil.example/api/apps/oauth/token', `${SIM_BASE_URL}/api/apps/oauth/token2`, `http://acme.tokenoftrust.store/api/apps/oauth/token`]) {
    const gateway = createLocalGateway({ previewCapability: CAPABILITY });
    const foreign = [];
    const wrap = (inner) => async (url, init) => {
      if (new URL(url).origin !== SIM_BASE_URL) {
        foreign.push(url);
        return ok();
      }
      const res = await inner(url, init);
      if (new URL(url).pathname !== '/.well-known/tot-app-authorization-metadata') return res;
      const doc = await res.json();
      return new Response(JSON.stringify({ ...doc, token_endpoint: endpoint }), { status: 200 });
    };
    const { worker, lines, pending, ctx } = deployedWorker({ gateway, wrap });
    await worker.scheduled({}, ENV, ctx);
    await Promise.all(pending);
    assert.deepEqual(foreign, []);
    assert.equal(gateway.calls.requests.filter((r) => r.path.includes('oauth')).length, 0);
    assert.ok(lines.some((l) => JSON.parse(l).errorCode === 'token_endpoint_refused'));
  }
});

test('secret sentinel: absent from every log line, thrown error and returned config', async () => {
  const secret = `${SENTINEL}-client-secret`;
  const capability = previewCapabilityFor({ tenantId: SENTINEL, env: 'test', exp: 4_102_444_800 }, `${SENTINEL}sig`);
  const env = { ...ENV, TOT_APP_CLIENT_SECRET: secret, TOT_STOREFRONT_BASE_URL: `${SIM_BASE_URL}/?__preview=${capability}` };
  const scenarios = [
    // token refused with remote text
    (url) => (url.endsWith('/oauth/token') ? new Response(JSON.stringify({ error: `${SENTINEL} bad ${secret}`, code: SENTINEL }), { status: 400 }) : null),
    // API refusal with remote text in error and code
    (url) => (new URL(url).pathname.startsWith('/api/apps/v1/') ? new Response(JSON.stringify({ code: `${SENTINEL}`, error: `${SENTINEL} ${capability}`, holds: [SENTINEL] }), { status: 409, headers: { 'tot-request-id': `${SENTINEL} x` } }) : null),
    // 503 refusals, retried, with remote text
    (url) => (new URL(url).pathname.startsWith('/api/apps/v1/') ? new Response(JSON.stringify({ code: 'unavailable', error: SENTINEL }), { status: 503 }) : null),
  ];
  for (const scenario of scenarios) {
    const sim = createLocalGateway({ previewCapability: capability });
    const thrown = [];
    const lines = [];
    const fetchImpl = async (url, init) => scenario(url) ?? sim.fetch(url, init);
    const app = createDeployedApp({ env, logger: createLogger((l) => lines.push(l)), fetchImpl, sleep: async () => {} });
    assert.ok(!JSON.stringify(app.config).includes(SENTINEL), 'returned config');
    assert.equal('clientSecret' in app.config, false);
    await app.connector.reconcileAll().catch((err) => thrown.push(`${err.name} ${err.message} ${err.code} ${err.stack}`));
    await app.connector.onAssignmentEvent(example('fulfillment.assignment.created.cloudevent.json')).catch((err) => thrown.push(`${err.message} ${err.stack}`));
    const surfaced = `${lines.join('\n')}\n${thrown.join('\n')}`;
    assert.ok(!surfaced.includes(SENTINEL), `sentinel surfaced: ${surfaced.slice(0, 400)}`);
    assert.ok(!surfaced.includes(capability));
  }
});

test('createDeployedApp has no opt-out: a base URL without a preview capability refuses', () => {
  const env = { ...ENV, TOT_STOREFRONT_BASE_URL: SIM_BASE_URL };
  assert.throws(() => createDeployedApp({ env, logger: createLogger(() => {}), fetchImpl: ok }), (err) => err.code === 'config_invalid');
  assert.throws(() => createDeployedApp({ env: { ...env, NODE_ENV: 'development', LOCAL: '1' }, logger: createLogger(() => {}), fetchImpl: ok }), (err) => err.code === 'config_invalid');
});
