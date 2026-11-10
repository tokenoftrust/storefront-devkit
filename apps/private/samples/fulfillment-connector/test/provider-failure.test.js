// A label provider is handed the ship-to, so its exception message can carry
// contact. Only the error class and a fixed code may reach the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorApp } from '../src/app.js';
import { createLogger } from '../src/log.js';
import { createLocalGateway, example, SIM_BASE_URL, SIM_PREVIEW_BASE_URL, SIM_CLIENT_ID, SIM_CLIENT_SECRET, SIM_WEBHOOK_URL } from '../sim/local-gateway.js';
import { createWorker } from '../worker.js';

const { orderId: _orderId, ...contact } = example('fulfillment.recipient.response.json');
const contactValues = Object.values(contact).filter((v) => typeof v === 'string' && v.length > 2);

class ProviderRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderRejected';
  }
}

function throwingProvider() {
  return {
    async lookup() {
      return null;
    },
    async purchase({ shipTo }) {
      throw new ProviderRejected(`address rejected: ${shipTo.name}, ${shipTo.line1}, ${shipTo.city} ${shipTo.postalCode}`);
    },
    async handoff() {
      return { accepted: false };
    },
  };
}

function assertNoContact(lines) {
  const logged = lines.join('\n');
  for (const value of contactValues) assert.ok(!logged.includes(value), 'a recipient value reached the log');
}

test('a provider exception carrying contact logs only its class and label_provider_failed (webhook path)', async () => {
  const gateway = createLocalGateway();
  const lines = [];
  const app = createConnectorApp({
    baseUrl: SIM_BASE_URL,
    clientId: SIM_CLIENT_ID,
    clientSecret: SIM_CLIENT_SECRET,
    webhookUrl: SIM_WEBHOOK_URL,
    fetchImpl: gateway.fetch,
    labelProvider: throwingProvider(),
    logger: createLogger((l) => lines.push(l)),
    sleep: async () => {},
  });
  const delivery = await app.handleDelivery(gateway.deliver(example('fulfillment.assignment.created.cloudevent.json')));
  assert.deepEqual(await delivery.work, { status: 'error' });
  const logs = lines.map((l) => JSON.parse(l));
  const providerLine = logs.find((l) => l.msg === 'label provider call failed');
  assert.deepEqual([providerLine.code, providerLine.errorClass, providerLine.op], ['label_provider_failed', 'ProviderRejected', 'purchase']);
  const processing = logs.find((l) => l.msg.startsWith('processing failed'));
  assert.deepEqual([processing.errorClass, processing.errorCode], ['ConnectorError', 'label_provider_failed']);
  assertNoContact(lines);
});

test('a provider exception carrying contact stays out of the Worker cron log', async () => {
  const gateway = createLocalGateway();
  const lines = [];
  const worker = createWorker({ fetchImpl: gateway.fetch, labelProvider: throwingProvider(), logger: createLogger((l) => lines.push(l)), sleep: async () => {} });
  const pending = [];
  const env = { TOT_APP_CLIENT_ID: SIM_CLIENT_ID, TOT_APP_CLIENT_SECRET: SIM_CLIENT_SECRET, TOT_STOREFRONT_BASE_URL: SIM_PREVIEW_BASE_URL, WEBHOOK_PUBLIC_URL: SIM_WEBHOOK_URL };
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const failed = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'reconciliation pass failed');
  assert.deepEqual([failed.errorClass, failed.errorCode], ['ConnectorError', 'label_provider_failed']);
  assertNoContact(lines);
});
