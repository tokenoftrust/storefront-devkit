// The deployed entry points never fall back to the simulated label provider:
// without a wired provider they refuse, and the simulator runs only on the
// explicit LABEL_PROVIDER=simulated, which then marks every log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConnectorApp } from '../src/app.js';
import { createCarrierLabelProvider, selectLabelProvider, SIMULATED_LABELS_FIELDS } from '../src/label-provider.js';
import { createLogger } from '../src/log.js';
import { createLocalGateway, example, SIM_BASE_URL, SIM_CLIENT_ID, SIM_CLIENT_SECRET, SIM_WEBHOOK_URL } from '../sim/local-gateway.js';
import { createWorker } from '../worker.js';

const CONFIG = {
  TOT_APP_CLIENT_ID: SIM_CLIENT_ID,
  TOT_APP_CLIENT_SECRET: SIM_CLIENT_SECRET,
  TOT_STOREFRONT_BASE_URL: SIM_BASE_URL,
  WEBHOOK_PUBLIC_URL: SIM_WEBHOOK_URL,
};
const event = () => example('fulfillment.assignment.created.cloudevent.json');

function setupWorker() {
  const gateway = createLocalGateway();
  let gatewayCalls = 0;
  const fetchImpl = (...args) => {
    gatewayCalls += 1;
    return gateway.fetch(...args);
  };
  const lines = [];
  const worker = createWorker({ fetchImpl, logger: createLogger((l) => lines.push(l)), sleep: async () => {} });
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  return { gateway, worker, lines, logs: () => lines.map((l) => JSON.parse(l)), pending, ctx, gatewayCalls: () => gatewayCalls };
}

const deliveryRequest = (gateway) => {
  const { method, headers, rawBody } = gateway.deliver(event());
  return new Request(SIM_WEBHOOK_URL, { method, headers, body: rawBody });
};

test('createConnectorApp without a labelProvider is a construction error naming what to inject', () => {
  assert.throws(
    () => createConnectorApp({ baseUrl: SIM_BASE_URL, clientId: SIM_CLIENT_ID, clientSecret: SIM_CLIENT_SECRET, webhookUrl: SIM_WEBHOOK_URL }),
    (err) => err instanceof TypeError && /needs a labelProvider/.test(err.message) && /createCarrierLabelProvider/.test(err.message),
  );
});

test('the carrier stub throws not implemented', () => {
  assert.throws(() => createCarrierLabelProvider({}), /not implemented/);
});

test('selectLabelProvider refuses unset and unknown values, and marks the simulator', () => {
  assert.throws(() => selectLabelProvider({}), (err) => err.reason === 'unset');
  assert.throws(() => selectLabelProvider({ LABEL_PROVIDER: 'ups' }), (err) => err.reason === 'unknown-value');
  assert.throws(() => selectLabelProvider({ LABEL_PROVIDER: 'carrier' }), (err) => err.reason === 'not-implemented');
  assert.equal(selectLabelProvider({ LABEL_PROVIDER: 'simulated' }).simulated, true);
});

for (const [label, value, reason] of [
  ['unset', undefined, 'unset'],
  ['an unknown value', 'ups', 'unknown-value'],
  ['carrier with the stub unimplemented', 'carrier', 'not-implemented'],
]) {
  test(`Worker with LABEL_PROVIDER ${label}: fetch is 503 and nothing runs`, async () => {
    const { gateway, worker, logs, pending, ctx, gatewayCalls } = setupWorker();
    const env = value === undefined ? CONFIG : { ...CONFIG, LABEL_PROVIDER: value };
    const res = await worker.fetch(deliveryRequest(gateway), env, ctx);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { code: 'label_provider_not_configured' });
    assert.equal(pending.length, 0);
    assert.equal(gatewayCalls(), 0);
    const refusal = logs().find((l) => l.code === 'label_provider_not_configured');
    assert.equal(refusal.reason, reason);
    assert.match(refusal.hint, /LABEL_PROVIDER=simulated/);
  });

  test(`Worker with LABEL_PROVIDER ${label}: scheduled logs the refusal and does no work`, async () => {
    const { gateway, worker, logs, pending, ctx, gatewayCalls } = setupWorker();
    const env = value === undefined ? CONFIG : { ...CONFIG, LABEL_PROVIDER: value };
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, ctx);
    assert.equal(pending.length, 0);
    assert.equal(gatewayCalls(), 0);
    assert.equal(gateway.calls.recipientReads, 0);
    assert.equal(logs().find((l) => l.code === 'label_provider_not_configured').reason, reason);
  });
}

test('Worker with LABEL_PROVIDER=simulated fulfills, and every log line says the labels are simulated', async () => {
  const { gateway, worker, logs, pending, ctx } = setupWorker();
  const env = { ...CONFIG, LABEL_PROVIDER: 'simulated' };
  const res = await worker.fetch(deliveryRequest(gateway), env, ctx);
  assert.equal(res.status, 202);
  assert.deepEqual(await pending[0], { status: 'fulfilled', version: 9 });
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  const all = logs();
  assert.ok(all.length > 2);
  assert.ok(all.some((l) => l.level === 'warn' && /simulated label provider in use/.test(l.msg)));
  for (const line of all) assert.equal(line.simulatedLabels, SIMULATED_LABELS_FIELDS.simulatedLabels, `unmarked log line: ${line.msg}`);
  assert.match(SIMULATED_LABELS_FIELDS.simulatedLabels, /nothing ships/);
});

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const runServer = (extraEnv) =>
  spawnSync(process.execPath, [serverPath], { env: { PATH: process.env.PATH, ...CONFIG, ...extraEnv }, encoding: 'utf8', timeout: 15000 });

for (const [label, extraEnv, reason] of [
  ['unset', {}, 'unset'],
  ['carrier with the stub unimplemented', { LABEL_PROVIDER: 'carrier' }, 'not-implemented'],
]) {
  test(`server.js with LABEL_PROVIDER ${label} exits non-zero before listening`, () => {
    const run = runServer(extraEnv);
    assert.equal(run.signal, null, 'server.js kept running instead of refusing');
    assert.equal(run.status, 1);
    const refusal = JSON.parse(run.stderr.trim().split('\n').pop());
    assert.deepEqual([refusal.code, refusal.reason], ['label_provider_not_configured', reason]);
    assert.doesNotMatch(run.stdout, /listening/);
  });
}
