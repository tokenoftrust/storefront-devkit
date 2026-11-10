// The Workers entry, driven directly: no socket, no wrangler. `fetch` and
// `scheduled` get a real Request and a ctx whose waitUntil promises are
// collected, against the local gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLogger } from '../src/log.js';
import {
  createLocalGateway,
  example,
  SIM_CLIENT_ID,
  SIM_CLIENT_SECRET,
  SIM_PREVIEW_BASE_URL,
  SIM_PREVIEW_CAPABILITY,
  SIM_WEBHOOK_URL,
} from '../sim/local-gateway.js';
import { createWorker } from '../worker.js';

const env = {
  TOT_APP_CLIENT_ID: SIM_CLIENT_ID,
  TOT_APP_CLIENT_SECRET: SIM_CLIENT_SECRET,
  TOT_STOREFRONT_BASE_URL: SIM_PREVIEW_BASE_URL,
  WEBHOOK_PUBLIC_URL: SIM_WEBHOOK_URL,
  LABEL_PROVIDER: 'simulated',
};

function setupWorker() {
  const gateway = createLocalGateway({ previewCapability: SIM_PREVIEW_CAPABILITY });
  const lines = [];
  const worker = createWorker({ fetchImpl: gateway.fetch, logger: createLogger((l) => lines.push(l)), sleep: async () => {} });
  return { gateway, worker, lines };
}

function context() {
  const pending = [];
  return { pending, ctx: { waitUntil: (p) => pending.push(p), passThroughOnException() {} } };
}

const request = ({ method, headers, rawBody }, url = SIM_WEBHOOK_URL) => new Request(url, { method, headers, body: rawBody });
const event = () => example('fulfillment.assignment.created.cloudevent.json');

test('fetch: a signed delivery is accepted with 202 and fulfilled through waitUntil', async () => {
  const { gateway, worker } = setupWorker();
  const { pending, ctx } = context();
  const res = await worker.fetch(request(gateway.deliver(event())), env, ctx);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { accepted: true });
  assert.equal(pending.length, 1);
  assert.deepEqual(await pending[0], { status: 'fulfilled', version: 9 });
  assert.deepEqual(gateway.calls.evidence.map((e) => e.body.kind), ['label-outcome', 'handoff']);
});

test('fetch: a tampered body is refused by Content-Digest, and nothing runs', async () => {
  const { gateway, worker } = setupWorker();
  const { pending, ctx } = context();
  const delivery = gateway.deliver(event());
  delivery.rawBody = Buffer.from(delivery.rawBody.toString().replace('ord_10482', 'ord_99999'));
  const res = await worker.fetch(request(delivery), env, ctx);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'digest_mismatch');
  assert.equal(pending.length, 0);
  assert.equal(gateway.calls.recipientReads, 0);
});

test('fetch: a redelivery of the same event id is a 200 duplicate in the same isolate', async () => {
  const { gateway, worker } = setupWorker();
  const { pending, ctx } = context();
  await worker.fetch(request(gateway.deliver(event())), env, ctx);
  await Promise.all(pending);
  const again = await worker.fetch(request(gateway.deliver({ ...event(), retrycount: 1 })), env, ctx);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { accepted: true, duplicate: true });
  assert.equal(pending.length, 1);
});

test('fetch: other paths are 404, and a delivery signed for another endpoint is 401', async () => {
  const { gateway, worker } = setupWorker();
  const { ctx } = context();
  const elsewhere = await worker.fetch(request(gateway.deliver(event()), 'https://fulfillment.example.com/other'), env, ctx);
  assert.equal(elsewhere.status, 404);
  const wrongTarget = gateway.deliver(event(), { targetUri: 'https://elsewhere.example.com/webhooks/tot' });
  const res = await worker.fetch(request(wrongTarget), env, ctx);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'signature_invalid');
});

test('scheduled: the cron reconciliation fulfills an assignment whose delivery was lost', async () => {
  const { gateway, worker } = setupWorker();
  const { pending, ctx } = context();
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, ctx);
  assert.equal(pending.length, 1);
  assert.deepEqual(await pending[0], [{ status: 'fulfilled', version: 9 }]);
  assert.equal(gateway.order.handoff, 'handed_off');
  await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, ctx);
  assert.deepEqual(await pending[1], []);
  assert.equal(gateway.calls.recipientReads, 1);
});

test('scheduled and fetch log no contact', async () => {
  const { gateway, worker, lines } = setupWorker();
  const { pending, ctx } = context();
  await worker.scheduled({}, env, ctx);
  await Promise.all(pending);
  const { orderId, ...contact } = example('fulfillment.recipient.response.json');
  assert.ok(orderId);
  const values = Object.values(contact).filter((v) => typeof v === 'string' && v.length > 2);
  const logged = lines.join('\n');
  assert.ok(lines.length > 0);
  for (const value of values) assert.ok(!logged.includes(value), 'a recipient value reached the log');
});

test('missing configuration is a fixed 503 and nothing runs', async () => {
  const { gateway, worker, lines } = setupWorker();
  const { pending, ctx } = context();
  const res = await worker.fetch(new Request(SIM_WEBHOOK_URL, { method: 'POST', body: '{}' }), {}, ctx);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { code: 'config_invalid' });
  assert.equal(pending.length, 0);
  assert.equal(gateway.calls.requests.length, 0);
  assert.equal(JSON.parse(lines.at(-1)).variable, 'TOT_APP_CLIENT_ID');
});

test('wrangler.toml names its own worker, uses a cron trigger, and carries no account id or secret', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /^name = "tot-fulfillment-connector-sample"$/m);
  assert.match(toml, /^main = "worker\.js"$/m);
  assert.match(toml, /^crons = \["\*\/5 \* \* \* \*"\]$/m);
  assert.doesNotMatch(toml, /account_id|routes?\s*=|TOT_APP_CLIENT|\[vars\]/);
});
