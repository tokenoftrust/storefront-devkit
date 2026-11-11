import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigRefused, loadConfig, parseSimulationFlags, readConfig } from '../src/config.js';
import { previewCapabilityFor } from '../sim/local-gateway.js';

const CAPABILITY = previewCapabilityFor({ tenantId: 'acme', env: 'test', exp: 4_102_444_800 });
const ENV = {
  TOT_APP_CLIENT_ID: 'placeholder-client-id',
  TOT_APP_CLIENT_SECRET: 'placeholder-client-secret',
  TOT_STOREFRONT_BASE_URL: `https://acme.tokenoftrust.store/?__preview=${CAPABILITY}`,
  WEBHOOK_PUBLIC_URL: 'https://fulfillment.example.com/webhooks/tot',
};

const refusedFor = (variable) => (err) => err instanceof ConfigRefused && err.code === 'config_invalid' && err.variable === variable;

test('configuration comes from the environment and fails closed', () => {
  const config = readConfig(ENV);
  assert.equal(config.baseUrl, 'https://acme.tokenoftrust.store');
  assert.equal(config.webhookUrl, ENV.WEBHOOK_PUBLIC_URL);
  assert.equal(config.port, 8787);
  assert.equal(readConfig({ ...ENV, WEBHOOK_PUBLIC_URL: 'https://Fulfillment.example.com' }).webhookUrl, 'https://Fulfillment.example.com');
  assert.throws(() => readConfig({ ...ENV, TOT_APP_CLIENT_SECRET: '' }), refusedFor('TOT_APP_CLIENT_SECRET'));
  assert.throws(() => readConfig({ ...ENV, WEBHOOK_PUBLIC_URL: 'http://fulfillment.example.com/hook' }), refusedFor('WEBHOOK_PUBLIC_URL'));
  assert.throws(() => readConfig({ ...ENV, WEBHOOK_PUBLIC_URL: 'not a url' }), refusedFor('WEBHOOK_PUBLIC_URL'));
});

test('the returned configuration carries neither the client secret nor the preview capability', () => {
  const config = readConfig(ENV);
  assert.equal('clientSecret' in config, false);
  const serialized = JSON.stringify(config);
  assert.ok(!serialized.includes(ENV.TOT_APP_CLIENT_SECRET));
  assert.ok(!serialized.includes(CAPABILITY));
  assert.ok(!serialized.includes('__preview'));
  const loaded = loadConfig(ENV);
  assert.equal(loaded.preview.capability, CAPABILITY);
  assert.equal(loaded.preview.expiresAtMs, 4_102_444_800 * 1000);
  assert.equal(loaded.clientSecret, ENV.TOT_APP_CLIENT_SECRET);
});

const SENTINEL = 'SENTINELzq9';
const sentinelCapability = previewCapabilityFor({ tenantId: SENTINEL, env: 'test', exp: 4_102_444_800 }, `${SENTINEL}sig`);
const host = `https://acme.tokenoftrust.store`;
const tokenOf = (claims) => previewCapabilityFor(claims, `${SENTINEL}sig`);

for (const [label, value] of [
  ['missing', undefined],
  ['empty', ''],
  ['no __preview', `${host}/`],
  ['an empty __preview', `${host}/?__preview=`],
  ['a duplicate __preview', `${host}/?__preview=${sentinelCapability}&__preview=${sentinelCapability}`],
  ['one segment', `${host}/?__preview=${SENTINEL}`],
  ['three segments', `${host}/?__preview=${sentinelCapability}.${SENTINEL}`],
  ['a non-base64url segment', `${host}/?__preview=${SENTINEL}+x.${SENTINEL}`],
  ['a percent-escaped capability', `${host}/?__preview=${sentinelCapability.replace('.', '%2E')}`],
  ['a claims segment that is not JSON', `${host}/?__preview=${SENTINEL}.${SENTINEL}`],
  ['a path-based URL', `${host}/stores/acme/?__preview=${sentinelCapability}`],
  ['an extra query parameter', `${host}/?__preview=${sentinelCapability}&next=${SENTINEL}`],
  ['an extra query parameter first', `${host}/?${SENTINEL}=1&__preview=${sentinelCapability}`],
  ['userinfo', `https://${SENTINEL}:pw@acme.tokenoftrust.store/?__preview=${sentinelCapability}`],
  ['a fragment', `${host}/?__preview=${sentinelCapability}#${SENTINEL}`],
  ['an empty fragment', `${host}/?__preview=${sentinelCapability}#`],
  ['plain http', `http://acme.tokenoftrust.store/?__preview=${sentinelCapability}`],
  ['an unparseable URL', `https://${SENTINEL} acme/?__preview=${sentinelCapability}`],
  ['an env claim of live', `${host}/?__preview=${tokenOf({ tenantId: SENTINEL, env: 'live', exp: 4_102_444_800 })}`],
  ['an env claim of production', `${host}/?__preview=${tokenOf({ tenantId: SENTINEL, env: 'production', exp: 4_102_444_800 })}`],
  ['no env claim', `${host}/?__preview=${tokenOf({ tenantId: SENTINEL, exp: 4_102_444_800 })}`],
  ['no exp claim', `${host}/?__preview=${tokenOf({ tenantId: SENTINEL, env: 'test' })}`],
  ['a string exp claim', `${host}/?__preview=${tokenOf({ tenantId: SENTINEL, env: 'test', exp: '4102444800' })}`],
]) {
  test(`TOT_STOREFRONT_BASE_URL with ${label} refuses initialization without echoing the input`, () => {
    const env = { ...ENV, TOT_STOREFRONT_BASE_URL: value };
    let caught;
    try {
      loadConfig(env);
    } catch (err) {
      caught = err;
    }
    assert.ok(refusedFor('TOT_STOREFRONT_BASE_URL')(caught), `expected a fixed refusal, got ${caught?.name}`);
    assert.equal(caught.message, 'configuration refused: TOT_STOREFRONT_BASE_URL');
    const surfaced = `${caught.message}\n${caught.stack}\n${JSON.stringify(caught)}`;
    assert.ok(!surfaced.includes(SENTINEL), 'the refusal echoed the input');
    assert.equal(caught.cause, undefined);
  });
}

test('simulation flags are explicit and unknown flags are refused', () => {
  assert.deepEqual(parseSimulationFlags([]), { unknownLabelOutcome: false, forceRetry: false, conflictingKeyReuse: false });
  assert.deepEqual(parseSimulationFlags(['--label-outcome=unknown', '--force-retry', '--conflicting-key-reuse']), {
    unknownLabelOutcome: true,
    forceRetry: true,
    conflictingKeyReuse: true,
  });
  assert.throws(() => parseSimulationFlags(['--label-outcome=lost']), /unknown flag/);
});

test('the sample manifest requests exactly the fulfillment scopes and topics', () => {
  const manifest = JSON.parse(readFileSync(new URL('../tot-app.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.scopes, ['fulfillment:process', 'orders:read:recipient']);
  assert.deepEqual(manifest.webhooks.topics, ['fulfillment.assignment.created', 'fulfillment.assignment.updated']);
});
