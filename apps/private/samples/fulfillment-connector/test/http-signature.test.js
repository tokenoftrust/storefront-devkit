import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { contentDigestFor, verifyContentDigest, verifyMessageSignature } from '../src/http-signature.js';
import { parseDictionary } from '../src/structured-fields.js';
import { signDelivery, SIM_WEBHOOK_URL } from '../sim/local-gateway.js';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherRsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = new Map([['k1', { key: rsa.publicKey, alg: 'rsa-v1_5-sha256' }]]);
const resolveKey = async (kid) => keys.get(kid) ?? null;
const body = Buffer.from('{"id":"evt_test","data":{}}');

function lower(headers) {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}

async function verify(headers, { rawBody = body, targetUri = SIM_WEBHOOK_URL, now } = {}) {
  const digest = verifyContentDigest(headers['content-digest'], rawBody);
  if (!digest.ok) return digest;
  return verifyMessageSignature({ method: 'POST', targetUri, headers: lower(headers), resolveKey, now });
}

test('accepts a correctly signed delivery', async () => {
  const headers = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'k1' });
  const result = await verify(headers);
  assert.equal(result.ok, true);
  assert.equal(result.keyid, 'k1');
  assert.equal(result.label, 'sig1');
});

test('rejects a tampered body by Content-Digest', async () => {
  const headers = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'k1' });
  const result = await verify(headers, { rawBody: Buffer.from('{"id":"evt_test","data":{"x":1}}') });
  assert.deepEqual([result.ok, result.code], [false, 'digest_mismatch']);
});

test('rejects a tampered body whose digest was recomputed, by the signature', async () => {
  const headers = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'k1' });
  const tampered = Buffer.from('{"id":"evt_other","data":{}}');
  const result = await verify({ ...headers, 'content-digest': contentDigestFor(tampered) }, { rawBody: tampered });
  assert.deepEqual([result.ok, result.code], [false, 'signature_invalid']);
});

test('rejects a signature made with a key other than the published one', async () => {
  const headers = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: otherRsa.privateKey, keyid: 'k1' });
  const result = await verify(headers);
  assert.deepEqual([result.ok, result.code], [false, 'signature_invalid']);
});

test('rejects a corrupted signature value', async () => {
  const headers = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'k1' });
  const sig = Buffer.from(headers.signature.slice(6, -1), 'base64');
  sig[10] ^= 0xff;
  const result = await verify({ ...headers, signature: `sig1=:${sig.toString('base64')}:` });
  assert.deepEqual([result.ok, result.code], [false, 'signature_invalid']);
});

test('rejects a delivery signed for another endpoint', async () => {
  const headers = signDelivery({ rawBody: body, targetUri: 'https://elsewhere.example.com/hook', privateKey: rsa.privateKey, keyid: 'k1' });
  const result = await verify(headers);
  assert.deepEqual([result.ok, result.code], [false, 'signature_invalid']);
});

test('rejects an unknown key, a mismatched or unsupported alg, and a malformed header', async () => {
  const unknown = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'nope' });
  assert.equal((await verify(unknown)).code, 'unknown_key');
  const mismatched = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'k1', alg: 'hmac-sha256' });
  assert.equal((await verify(mismatched)).code, 'alg_mismatch');
  keys.set('k-noalg', { key: rsa.publicKey });
  const unsupported = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'k-noalg', alg: 'hmac-sha256' });
  assert.equal((await verify(unsupported)).code, 'unsupported_alg');
  const good = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'k1' });
  assert.equal((await verify({ ...good, signature: 'sig1=not-bytes' })).code, 'signature_malformed');
  assert.equal((await verify({ ...good, 'signature-input': 'sig1=(' })).code, 'signature_malformed');
});

test('rejects a stale or future-dated signature', async () => {
  const created = Math.floor(Date.now() / 1000) - 3600;
  const stale = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'k1', created });
  assert.equal((await verify(stale)).code, 'signature_expired');
  const future = signDelivery({ rawBody: body, targetUri: SIM_WEBHOOK_URL, privateKey: rsa.privateKey, keyid: 'k1', created: created + 7200 });
  assert.equal((await verify(future)).code, 'signature_expired');
});

test('rejects a signature that does not cover the body digest', async () => {
  const created = Math.floor(Date.now() / 1000);
  const params = `("@method" "@target-uri");created=${created};keyid="k1";alg="rsa-v1_5-sha256"`;
  const base = `"@method": POST\n"@target-uri": ${SIM_WEBHOOK_URL}\n"@signature-params": ${params}`;
  const sig = cryptoSign('sha256', Buffer.from(base), rsa.privateKey).toString('base64');
  const result = await verify({ 'content-digest': contentDigestFor(body), 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` });
  assert.equal(result.code, 'signature_coverage');
});

test('verifies ed25519 and ecdsa-p256-sha256 signatures over the same base', async () => {
  for (const [alg, pair, signFn] of [
    ['ed25519', generateKeyPairSync('ed25519'), (k, d) => cryptoSign(null, d, k)],
    ['ecdsa-p256-sha256', generateKeyPairSync('ec', { namedCurve: 'P-256' }), (k, d) => cryptoSign('sha256', d, { key: k, dsaEncoding: 'ieee-p1363' })],
  ]) {
    keys.set(alg, { key: pair.publicKey, alg });
    const created = Math.floor(Date.now() / 1000);
    const digest = contentDigestFor(body, 'sha-512');
    const params = `("@method" "@target-uri" "content-digest" "content-type");created=${created};keyid="${alg}"`;
    const base = [`"@method": POST`, `"@target-uri": ${SIM_WEBHOOK_URL}`, `"content-digest": ${digest}`, `"content-type": application/cloudevents+json`, `"@signature-params": ${params}`].join('\n');
    const sig = signFn(pair.privateKey, Buffer.from(base)).toString('base64');
    const result = await verify({ 'content-digest': digest, 'content-type': 'application/cloudevents+json', 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` });
    assert.equal(result.ok, true, alg);
    assert.equal(result.alg, alg);
  }
});

test('Content-Digest: missing and unsupported algorithms are rejected', () => {
  assert.equal(verifyContentDigest(undefined, body).code, 'digest_missing');
  assert.equal(verifyContentDigest('md5=:AAAA:', body).code, 'digest_unsupported');
  assert.equal(verifyContentDigest('sha-256=abc', body).code, 'digest_malformed');
});

test('structured-field dictionaries keep the raw member text for @signature-params', () => {
  const dict = parseDictionary('sig1=("@method" "content-digest");created=1;keyid="a, b", sig2=:AQID:');
  assert.equal(dict.get('sig1').raw, '("@method" "content-digest");created=1;keyid="a, b"');
  assert.deepEqual(dict.get('sig1').value.map((i) => i.value), ['@method', 'content-digest']);
  assert.equal(dict.get('sig1').params.get('keyid'), 'a, b');
  assert.deepEqual([...dict.get('sig2').value.bytes], [1, 2, 3]);
});
