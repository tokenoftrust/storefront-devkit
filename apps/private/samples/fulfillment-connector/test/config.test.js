import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSimulationFlags, readConfig } from '../src/config.js';

const ENV = {
  TOT_APP_CLIENT_ID: 'placeholder-client-id',
  TOT_APP_CLIENT_SECRET: 'placeholder-client-secret',
  TOT_STOREFRONT_BASE_URL: 'https://acme.tokenoftrust.store/',
  WEBHOOK_PUBLIC_URL: 'https://fulfillment.example.com/webhooks/tot',
};

test('configuration comes from the environment and fails closed', () => {
  const config = readConfig(ENV);
  assert.equal(config.baseUrl, 'https://acme.tokenoftrust.store');
  assert.equal(config.webhookUrl, ENV.WEBHOOK_PUBLIC_URL);
  assert.equal(config.port, 8787);
  assert.throws(() => readConfig({ ...ENV, TOT_APP_CLIENT_SECRET: '' }), /TOT_APP_CLIENT_SECRET/);
  assert.throws(() => readConfig({ ...ENV, WEBHOOK_PUBLIC_URL: 'http://fulfillment.example.com/hook' }), /https/);
});

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
