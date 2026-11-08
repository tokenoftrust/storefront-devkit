import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createGatewayMetadata, METADATA_PATH } from '../src/gateway-metadata.js';

const BASE = 'https://acme.tokenoftrust.store';
const jwkFor = (kid) => ({ ...generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const k1 = jwkFor('k1');
const k2 = jwkFor('k2');

function harness(initialKeys) {
  const state = { keys: initialKeys, fetches: 0, t: 1_000_000 };
  const fetchImpl = async (url) => {
    assert.equal(url, `${BASE}${METADATA_PATH}`);
    state.fetches++;
    return new Response(JSON.stringify({ token_endpoint: `${BASE}/api/apps/oauth/token`, webhook_signing_keys: { keys: state.keys } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    });
  };
  const metadata = createGatewayMetadata({ baseUrl: BASE, fetchImpl, now: () => state.t });
  return { state, metadata };
}

test('a cached document is reused until max-age, then refetched', async () => {
  const { state, metadata } = harness([k1]);
  assert.ok(await metadata.resolveSigningKey('k1'));
  state.t += 299_000;
  assert.ok(await metadata.resolveSigningKey('k1'));
  assert.equal(await metadata.tokenEndpoint(), `${BASE}/api/apps/oauth/token`);
  assert.equal(state.fetches, 1);
  state.t += 2_000;
  assert.ok(await metadata.resolveSigningKey('k1'));
  assert.equal(state.fetches, 2);
});

test('an unknown kid forces at most one refetch per 30 seconds', async () => {
  const { state, metadata } = harness([k1]);
  await metadata.resolveSigningKey('k1');
  state.t += 10_000;
  assert.equal(await metadata.resolveSigningKey('nope'), null);
  assert.equal(state.fetches, 1, 'no refetch inside 30s of the last fetch');
  state.t += 21_000;
  assert.equal(await metadata.resolveSigningKey('nope'), null);
  assert.equal(state.fetches, 2, 'exactly one refetch once 30s have passed');
  assert.equal(await metadata.resolveSigningKey('nope'), null);
  state.t += 5_000;
  assert.equal(await metadata.resolveSigningKey('nope'), null);
  assert.equal(state.fetches, 2, 'the refetch is rate limited');
});

test('a rotated key is found by the refetch an unknown kid triggers', async () => {
  const { state, metadata } = harness([k1]);
  await metadata.resolveSigningKey('k1');
  state.keys = [k2];
  state.t += 31_000;
  const rotated = await metadata.resolveSigningKey('k2');
  assert.ok(rotated?.key);
  assert.equal(state.fetches, 2);
  assert.equal(await metadata.resolveSigningKey('k1'), null);
});
