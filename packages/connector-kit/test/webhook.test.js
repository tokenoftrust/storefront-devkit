// The fixture is a fixed delivery produced once by the Storefront platform
// signer (rsa-v1_5-sha256, label sig1, components "@method" "@target-uri"
// "content-digest", sha-256 Content-Digest) with a throwaway key. Only the
// public key is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AuthorizationMetadata,
  MemorySeenEventStore,
  StaticSigningKeys,
  WebhookReceiver,
  contentDigestFor,
  verifyMessageSignature,
  importWebhookSigningKey,
} from '../src/index.js';

const VECTOR = JSON.parse(readFileSync(new URL('./fixtures/storefront-signed-delivery.json', import.meta.url), 'utf8'));
const AT_CREATED = VECTOR.created * 1000;

function receiver(overrides = {}) {
  return new WebhookReceiver({
    endpoint: VECTOR.targetUri,
    keys: new StaticSigningKeys({ keys: [VECTOR.jwk] }),
    now: () => AT_CREATED,
    ...overrides,
  });
}

const delivery = (overrides = {}) => ({ method: 'POST', headers: VECTOR.headers, body: new TextEncoder().encode(VECTOR.body), ...overrides });

test('the Storefront-signed vector verifies and yields the event', async () => {
  const result = await receiver().verify(delivery());
  assert.equal(result.ok, true);
  assert.equal(result.keyid, 'kit-vector-key-1');
  assert.equal(result.created, VECTOR.created);
  assert.equal(result.event.id, 'evt_KITVECTOR0001');
  assert.equal(result.replayKey, 'acme/evt_KITVECTOR0001');
});

test('the vector verifies from a string body, a Headers object and mixed-case header names', async () => {
  const headers = new Headers({ 'Content-Digest': VECTOR.headers['content-digest'], 'Signature-Input': VECTOR.headers['signature-input'], Signature: VECTOR.headers.signature });
  assert.equal((await receiver().verify(delivery({ body: VECTOR.body, headers }))).ok, true);
});

test('the digest the kit computes equals the one the signer sent', async () => {
  assert.equal(await contentDigestFor(VECTOR.body), VECTOR.headers['content-digest']);
});

test('the reference sample vector also verifies through the kit verifier', async () => {
  const sample = {
    jwk: {
      kty: 'RSA',
      kid: 'vector-key-1',
      alg: 'RS256',
      use: 'sig',
      e: 'AQAB',
      n: 'vj57MdfTKKfeHWsTo0xibmtKYMCURBGHmqfBk9TnNYnJrPXsSwCIeWfpHdzUI3wBydCymaG__WCPG9OEeL9bH7SwhzyAU1MoJ-Kg9gP7qMqCQ0nOsNyZVfsSjGuF49qNJFNnajYdiNUdg_gowAOzDiYT5SESPMcdeP69MsqHfF5I5_QbXilnAAwHikOcwWrm1aJqOLRdhCU3U3I9vx4aRk7PPyIMDrpsrXQJK-D-o53r_tv2Lq6hzKwoKZNwy2QUrRPV8jh95IeBa1ott1_Y_Vc1F2K2pMfII0JvICWCDsNKMqlPAHm8lfbtHvChBAK0gFMjtAojIH4glYSUFQw7ww',
    },
    headers: {
      'content-digest': 'sha-256=:OyQsblFmbRO7oM0EdpcZdD404XG/HrFQj2nM4i7e7Hg=:',
      'signature-input': 'sig1=("@method" "@target-uri" "content-digest");created=1784660741;keyid="vector-key-1";alg="rsa-v1_5-sha256"',
      signature:
        'sig1=:R5G2T90m1FLPyl9p7mL0ikNFyRIPPfdi4MzLRtVXGjlijS5wN7j5HUooQvALpBeUnfyk6YGBpYtJCNaezlFj38g9sjUO8CfsQteDeOMkR7UKYk8JIt0e/cnUoQFc0e93hKQIl2nv7SqYPhIzsEI3lm7zv6Wa86d4ViKlNpQYGZ4tecJqAEPKQ/uUP7bPgPyXIGVDQhb+3kpCCnEkftO+pBn391nwin9IVpRW2TuZwj0F5CEWBRtD9gkfmkMyMJ5/yjRWlHrN6KWLfKfWz203ihI2yAsnseqAWmwfdSSJeJYUH/iwsYuVYn7t1auSn1SpH8uEl9tyaZl5vcJFWQN29w==:',
    },
  };
  const { key } = await importWebhookSigningKey(sample.jwk);
  const result = await verifyMessageSignature({
    method: 'POST',
    targetUri: 'https://fulfillment.example.com/webhooks/tot',
    headers: sample.headers,
    resolveKey: async (kid) => (kid === 'vector-key-1' ? key : null),
    now: 1784660741 * 1000,
  });
  assert.deepEqual(result, { ok: true, label: 'sig1', keyid: 'vector-key-1', created: 1784660741, alg: 'rsa-v1_5-sha256' });
});

test('a tampered body is rejected', async () => {
  const tampered = VECTOR.body.replace('"balance":12', '"balance":99');
  assert.notEqual(tampered, VECTOR.body);
  assert.deepEqual(await receiver().verify(delivery({ body: tampered })), { ok: false, status: 400, code: 'digest_mismatch' });
  // A forger who also recomputes Content-Digest breaks the signature, which covers it.
  const headers = { ...VECTOR.headers, 'content-digest': await contentDigestFor(tampered) };
  assert.deepEqual(await receiver().verify(delivery({ body: tampered, headers })), { ok: false, status: 401, code: 'signature_invalid' });
});

test('a delivery outside the created window is rejected', async () => {
  const at = (seconds) => receiver({ now: () => (VECTOR.created + seconds) * 1000 }).verify(delivery());
  assert.equal((await at(300)).ok, true, 'five minutes old is still inside the window');
  assert.deepEqual(await at(301), { ok: false, status: 401, code: 'signature_expired' });
  assert.equal((await at(-60)).ok, true, 'one minute of clock skew is tolerated');
  assert.deepEqual(await at(-61), { ok: false, status: 401, code: 'signature_expired' });
});

test('an unknown keyid is rejected', async () => {
  const otherKey = { ...VECTOR.jwk, kid: 'some-other-key' };
  const result = await receiver({ keys: new StaticSigningKeys({ keys: [otherKey] }) }).verify(delivery());
  assert.deepEqual(result, { ok: false, status: 401, code: 'unknown_key' });
});

test('an unknown keyid refetches the published metadata once, rate-limited, before rejecting', async () => {
  let metadataClock = 0;
  const calls = [];
  let published = [];
  const fetch = async (url, init) => {
    calls.push([url, init.method]);
    return new Response(JSON.stringify({ token_endpoint: 'https://acme.example.com/api/apps/oauth/token', webhook_signing_keys: { keys: published } }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    });
  };
  const keys = new AuthorizationMetadata({ origin: 'https://acme.example.com', fetch, now: () => metadataClock });
  const r = receiver({ keys });

  assert.equal((await r.verify(delivery())).code, 'unknown_key');
  assert.equal(calls.length, 1, 'the refetch is suppressed inside the minimum interval');
  assert.deepEqual(calls[0], ['https://acme.example.com/.well-known/tot-app-authorization-metadata', 'GET']);

  published = [VECTOR.jwk]; // the key rotates in
  metadataClock += 31_000;
  assert.equal((await r.verify(delivery())).ok, true);
  assert.equal(calls.length, 2, 'one refetch on the unknown keyid');
});

test('a replayed event id is rejected and never reaches the handler', async () => {
  const r = receiver();
  assert.equal((await r.verify(delivery())).ok, true);
  assert.deepEqual(await r.verify(delivery()), { ok: false, status: 200, code: 'replayed_event' });

  const seen = [];
  const r2 = receiver();
  assert.equal((await r2.receive(delivery(), async (event) => seen.push(event.id))).status, 202);
  const replay = await r2.receive(delivery(), async (event) => seen.push(event.id));
  assert.deepEqual(replay, { status: 200, body: { accepted: true, duplicate: true } });
  assert.deepEqual(seen, ['evt_KITVECTOR0001']);
});

test('a handler failure releases the event id so the retry is processed', async () => {
  const r = receiver();
  const failed = await r.receive(delivery(), async () => {
    throw new Error('downstream unavailable');
  });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { accepted: false, code: 'handler_failed' });
  let handled = 0;
  assert.equal((await r.receive(delivery(), async () => handled++)).status, 202);
  assert.equal(handled, 1);
});

test('the seen-event store forgets an id after its TTL', async () => {
  let clock = 0;
  const store = new MemorySeenEventStore({ now: () => clock });
  assert.equal(await store.claim('t/e1', 10), true);
  assert.equal(await store.claim('t/e1', 10), false);
  clock = 10_001;
  assert.equal(await store.claim('t/e1', 10), true);
});

test('the signed @target-uri is the registered endpoint, never the request', async () => {
  const result = await receiver({ endpoint: `${VECTOR.targetUri}/` }).verify(delivery());
  assert.deepEqual(result, { ok: false, status: 401, code: 'signature_invalid' });
});

test('method, size, missing headers, alg and envelope refusals', async () => {
  const r = receiver();
  assert.equal((await r.verify(delivery({ method: 'PUT' }))).code, 'method_not_allowed');
  assert.equal((await receiver({ maxBodyBytes: 10 }).verify(delivery())).code, 'body_too_large');
  assert.equal((await r.verify(delivery({ headers: { ...VECTOR.headers, 'content-digest': undefined } }))).code, 'digest_missing');
  assert.equal((await r.verify(delivery({ headers: { 'content-digest': VECTOR.headers['content-digest'] } }))).code, 'signature_missing');
  const hmac = VECTOR.headers['signature-input'].replace('rsa-v1_5-sha256', 'hmac-sha256');
  assert.equal((await r.verify(delivery({ headers: { ...VECTOR.headers, 'signature-input': hmac } }))).code, 'unsupported_alg');
  const narrow = VECTOR.headers['signature-input'].replace(' "content-digest"', '');
  assert.equal((await r.verify(delivery({ headers: { ...VECTOR.headers, 'signature-input': narrow } }))).code, 'signature_coverage');
});

test('malformed base64 in Content-Digest or Signature is a refusal, never a throw', async () => {
  const r = receiver();
  const badDigest = await r.verify(delivery({ headers: { ...VECTOR.headers, 'content-digest': 'sha-256=:a:' } }));
  assert.deepEqual([badDigest.ok, badDigest.status], [false, 400]);
  const badSignature = await r.verify(delivery({ headers: { ...VECTOR.headers, signature: 'sig1=:abcde:' } }));
  assert.deepEqual([badSignature.ok, badSignature.status, badSignature.code], [false, 401, 'signature_malformed']);
});

test('an unrelated label or member carrying a decimal is ignored and the delivery accepted', async () => {
  const headers = {
    ...VECTOR.headers,
    'signature-input': `${VECTOR.headers['signature-input']}, sig2=("@method");created=1;q=1.5`,
    signature: `${VECTOR.headers.signature}, sig2=:AAAA:`,
  };
  assert.equal((await receiver().verify(delivery({ headers }))).ok, true);
});

test('handleRequest refuses an oversize streamed body with no Content-Length before buffering it', async () => {
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (++pulled > 20) return controller.close();
      controller.enqueue(new Uint8Array(64));
    },
  });
  const request = new Request(VECTOR.targetUri, { method: 'POST', headers: VECTOR.headers, body: stream, duplex: 'half' });
  assert.equal(request.headers.get('content-length'), null);
  const res = await receiver({ maxBodyBytes: 256 }).handleRequest(request, async () => assert.fail('handler must not run'));
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { accepted: false, code: 'body_too_large' });
  assert.ok(pulled <= 6, `stopped reading once past the cap (pulled ${pulled} chunks)`);
});

test('handleRequest answers a fetch Request', async () => {
  const request = new Request(VECTOR.targetUri, { method: 'POST', headers: VECTOR.headers, body: VECTOR.body });
  const seen = [];
  const res = await receiver().handleRequest(request, async (event) => seen.push(event.type));
  assert.equal(res.status, 202);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { accepted: true });
  assert.deepEqual(seen, ['com.tokenoftrust.storefront.inventory.changed']);
});
