import { test } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { ApiClient, AuthError, CLIENT_ASSERTION_TYPE, ConnectorAuthClient } from '../src/index.js';

const ORIGIN = 'https://acme.example.com';
const TOKEN_ENDPOINT = `${ORIGIN}/api/apps/oauth/token`;

/** A token endpoint double that records each request and answers from a queue (last answer repeats). */
function tokenEndpoint(...answers) {
  const requests = [];
  let n = 0;
  const fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, form: new URLSearchParams(init.body), redirect: init.redirect });
    const answer = answers[Math.min(n++, answers.length - 1)];
    const { status = 200, body = { access_token: `tok-${n}`, token_type: 'Bearer', expires_in: 600, scope: 'inventory:read inventory:write' }, headers = {} } = answer ?? {};
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { fetch, requests };
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

test('client_secret_basic sends form-urlencoded credentials in HTTP Basic and none in the body', async () => {
  const endpoint = tokenEndpoint();
  const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'app client', clientSecret: 's3cr+t/=:x', fetch: endpoint.fetch });
  assert.equal(auth.method, 'client_secret_basic');
  assert.equal(await auth.getAccessToken(), 'tok-1');

  const [req] = endpoint.requests;
  assert.equal(req.url, TOKEN_ENDPOINT);
  assert.equal(req.redirect, 'manual');
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
  const decoded = Buffer.from(req.headers.authorization.replace(/^Basic /, ''), 'base64').toString('utf8');
  assert.equal(decoded, 'app+client:s3cr%2Bt%2F%3D%3Ax', 'each half is form-urlencoded before Base64 (RFC 6749 2.3.1)');
  assert.deepEqual([...req.form.keys()], ['grant_type']);
  assert.equal(req.form.get('grant_type'), 'client_credentials');
});

test('client_secret_post sends client_id and client_secret in the body and no Authorization header', async () => {
  const endpoint = tokenEndpoint();
  const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 'secret', method: 'client_secret_post', fetch: endpoint.fetch });
  await auth.getAccessToken();
  const [req] = endpoint.requests;
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.form.get('client_id'), 'cid');
  assert.equal(req.form.get('client_secret'), 'secret');
  assert.equal(req.form.get('client_assertion'), null);
});

for (const [alg, generate, verifyParams] of [
  ['RS256', { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, { name: 'RSASSA-PKCS1-v1_5' }],
  ['ES256', { name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }],
]) {
  test(`private_key_jwt signs an RFC 7523 assertion with ${alg}, fresh per request`, async () => {
    const pair = await crypto.subtle.generateKey(generate, true, ['sign', 'verify']);
    const privateJwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: `${alg.toLowerCase()}-key-1` };
    const endpoint = tokenEndpoint();
    let clock = 1_794_830_400_000;
    const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid-jwt', privateKey: privateJwk, fetch: endpoint.fetch, now: () => clock });
    assert.equal(auth.method, 'private_key_jwt');
    await auth.getAccessToken();
    clock += 600_000;
    await auth.getAccessToken();

    assert.equal(endpoint.requests.length, 2);
    const jtis = [];
    for (const req of endpoint.requests) {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.form.get('client_secret'), null);
      assert.equal(req.form.get('client_id'), 'cid-jwt');
      assert.equal(req.form.get('client_assertion_type'), CLIENT_ASSERTION_TYPE);
      const [h, p, s] = req.form.get('client_assertion').split('.');
      assert.deepEqual(decodeSegment(h), { alg, typ: 'JWT', kid: `${alg.toLowerCase()}-key-1` });
      const claims = decodeSegment(p);
      assert.equal(claims.iss, 'cid-jwt');
      assert.equal(claims.sub, 'cid-jwt');
      assert.equal(claims.aud, TOKEN_ENDPOINT);
      assert.equal(claims.exp - claims.iat, 60);
      assert.match(claims.jti, /^[\x21-\x7e]{1,128}$/);
      jtis.push(claims.jti);
      const valid = await crypto.subtle.verify(verifyParams, pair.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${p}`));
      assert.equal(valid, true, 'the assertion verifies against the registered public key');
    }
    assert.notEqual(jtis[0], jtis[1], 'jti is single-use, so each request gets a fresh one');
  });
}

test('private_key_jwt accepts a non-extractable CryptoKey with an explicit keyId', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const endpoint = tokenEndpoint();
  const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', privateKey: pair.privateKey, keyId: 'kid-x', fetch: endpoint.fetch });
  await auth.getAccessToken();
  const header = decodeSegment(endpoint.requests[0].form.get('client_assertion').split('.')[0]);
  assert.deepEqual(header, { alg: 'ES256', typ: 'JWT', kid: 'kid-x' });
});

test('the token is cached and refreshed early, before it expires', async () => {
  const endpoint = tokenEndpoint();
  let clock = 0;
  const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 's', refreshSkewSeconds: 60, fetch: endpoint.fetch, now: () => clock });
  assert.equal(await auth.getAccessToken(), 'tok-1'); // expires_in 600
  clock = 539_000;
  assert.equal(await auth.getAccessToken(), 'tok-1', 'more than 60 s left: cached');
  clock = 540_000;
  assert.equal(await auth.getAccessToken(), 'tok-2', '60 s before expiry: refreshed early');
  assert.equal(endpoint.requests.length, 2);
  assert.deepEqual((await auth.getToken()).scope, ['inventory:read', 'inventory:write']);
});

test('early refresh is capped at half the lifetime of a short-lived token', async () => {
  const endpoint = tokenEndpoint({ body: { access_token: 'short', token_type: 'Bearer', expires_in: 60, scope: '' } });
  let clock = 0;
  const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 's', refreshSkewSeconds: 120, fetch: endpoint.fetch, now: () => clock });
  await auth.getAccessToken();
  clock = 29_000;
  await auth.getAccessToken();
  assert.equal(endpoint.requests.length, 1);
  clock = 30_000;
  await auth.getAccessToken();
  assert.equal(endpoint.requests.length, 2);
});

test('concurrent callers share one token request; invalidate drops only the stale token', async () => {
  const endpoint = tokenEndpoint();
  const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 's', fetch: endpoint.fetch });
  const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
  assert.deepEqual(tokens, ['tok-1', 'tok-1', 'tok-1']);
  assert.equal(endpoint.requests.length, 1);
  auth.invalidate('not-the-cached-token');
  assert.equal(await auth.getAccessToken(), 'tok-1');
  auth.invalidate('tok-1');
  assert.equal(await auth.getAccessToken(), 'tok-2');
});

test('logging, inspecting or serializing either client never prints a token or a credential', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: 'k1' };
  const secret = 'client-secret-value-123';
  const token = 'live-bearer-token-xyz';
  const fetch = async () => new Response(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 600, scope: '' }));
  const secretClient = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: secret, fetch });
  const jwtClient = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', privateKey: privateJwk, fetch });
  const api = new ApiClient({ origin: ORIGIN, auth: secretClient, fetch });
  const dump = () =>
    [secretClient, jwtClient, api]
      .flatMap((o) => [util.inspect(o, { depth: Infinity, showHidden: true }), JSON.stringify(o), String(o), Object.values(o).map(String).join(' ')])
      .join('\n');
  const pending = secretClient.getAccessToken();
  assert.ok(!dump().includes(secret), 'no secret, even while a token request is in flight');
  assert.equal(await pending, token);
  await jwtClient.getAccessToken();
  const after = dump();
  for (const leaked of [token, secret, privateJwk.d]) assert.ok(!after.includes(leaked), 'no token, secret or private key material');
  assert.equal(await secretClient.getAccessToken(), token, 'the cached token still works');
});

test('a refusal throws AuthError with the OAuth code and no remote text', async () => {
  const endpoint = tokenEndpoint({ status: 401, body: { error: 'invalid_client', error_description: 'client cid secret mismatch' } });
  const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 'hunter2', fetch: endpoint.fetch });
  const err = await auth.getAccessToken().catch((e) => e);
  assert.ok(err instanceof AuthError);
  assert.equal(err.code, 'invalid_client');
  assert.equal(err.status, 401);
  assert.equal(err.retryable, false);
  assert.equal(endpoint.requests.length, 1, 'a credential refusal is not retried');
  const logged = `${err.message} ${JSON.stringify(err)}`;
  assert.ok(!logged.includes('mismatch') && !logged.includes('hunter2'));
});

test('temporarily_unavailable is retried with a bounded backoff', async () => {
  const endpoint = tokenEndpoint({ status: 503, body: { error: 'temporarily_unavailable' }, headers: { 'retry-after': '2' } }, {});
  const sleeps = [];
  const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 's', fetch: endpoint.fetch, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(await auth.getAccessToken(), 'tok-2');
  assert.deepEqual(sleeps, [2000]);
});

test('a response without a usable token is refused', async () => {
  const endpoint = tokenEndpoint({ body: { token_type: 'Bearer' } });
  const auth = new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 's', fetch: endpoint.fetch });
  assert.equal((await auth.getAccessToken().catch((e) => e)).code, 'invalid_token_response');
});

test('misconfiguration is refused at construction', () => {
  assert.throws(() => new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid' }), /requires clientSecret/);
  assert.throws(() => new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 's', privateKey: {} }), /private_key_jwt takes no clientSecret/);
  assert.throws(() => new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 's', privateKey: {}, method: 'client_secret_post' }), /takes no privateKey/);
  assert.throws(() => new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', method: 'private_key_jwt' }), /requires privateKey/);
  assert.throws(() => new ConnectorAuthClient({ origin: `${ORIGIN}/api/apps/v1`, clientId: 'cid', clientSecret: 's' }), /no path/);
  assert.throws(() => new ConnectorAuthClient({ origin: 'http://acme.example.com', clientId: 'cid', clientSecret: 's' }), /https/);
  assert.throws(() => new ConnectorAuthClient({ origin: ORIGIN, clientId: 'cid', clientSecret: 's', method: 'client_secret_jwt' }), /method must be/);
});
