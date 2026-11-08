import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { contentDigestFor } from '../src/http-signature.js';
import { nodeRequestListener } from '../src/webhook.js';
import { example, signDelivery, SIM_WEBHOOK_URL } from '../sim/local-gateway.js';
import { setup } from './helpers.js';

const createdEvent = () => example('fulfillment.assignment.created.cloudevent.json');

test('a verified delivery is accepted and processed once; a redelivery of the same id is deduplicated', async () => {
  const { gateway, app } = setup();
  const first = await app.handleDelivery(gateway.deliver(createdEvent()));
  assert.equal(first.status, 202);
  assert.deepEqual(await first.work, { status: 'fulfilled', version: 9 });
  const evidenceAfterFirst = gateway.calls.evidence.length;

  const retried = { ...createdEvent(), retrycount: 1 };
  const second = await app.handleDelivery(gateway.deliver(retried));
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.work, null);
  assert.equal(gateway.calls.evidence.length, evidenceAfterFirst);
  assert.equal(gateway.calls.recipientReads, 1);
});

test('a tampered body is rejected before parsing and nothing runs', async () => {
  const { gateway, app } = setup();
  const delivery = gateway.deliver(createdEvent());
  const tampered = Buffer.from(delivery.rawBody.toString().replace('ord_10482', 'ord_99999'));
  const result = await app.handleDelivery({ ...delivery, rawBody: tampered });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'digest_mismatch');
  assert.equal(result.work, null);
  assert.equal(gateway.calls.recipientReads, 0);
});

test('a bad signature is rejected, and the event id is not consumed', async () => {
  const { gateway, app } = setup();
  const event = createdEvent();
  const rawBody = Buffer.from(JSON.stringify(event));
  const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const headers = signDelivery({ rawBody, targetUri: SIM_WEBHOOK_URL, privateKey: forger.privateKey, keyid: gateway.keyid });
  const forged = await app.handleDelivery({ method: 'POST', headers, rawBody });
  assert.equal(forged.status, 401);
  assert.equal(forged.body.code, 'signature_invalid');
  assert.equal(gateway.calls.recipientReads, 0);

  const genuine = await app.handleDelivery(gateway.deliver(event));
  assert.equal(genuine.status, 202);
  await genuine.work;
});

test('a signed but contract-invalid envelope is rejected', async () => {
  const { gateway, app } = setup();
  const event = createdEvent();
  event.data.recipientName = 'should never be here';
  const result = await app.handleDelivery(gateway.deliver(event));
  assert.equal(result.status, 400);
  assert.match(result.body.code, /^envelope_invalid/);
});

test('non-POST requests and missing signature headers are refused', async () => {
  const { app } = setup();
  assert.equal((await app.handleDelivery({ method: 'GET', headers: {}, rawBody: Buffer.alloc(0) })).status, 405);
  const rawBody = Buffer.from('{}');
  const unsigned = await app.handleDelivery({ method: 'POST', headers: { 'content-digest': contentDigestFor(rawBody) }, rawBody });
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.body.code, 'signature_missing');
});

test('held and cancelled updates are recorded without reading the recipient', async () => {
  const { gateway, app } = setup();
  for (const [id, state] of [['evt_held', 'held'], ['evt_cancelled', 'cancelled']]) {
    const event = { ...createdEvent(), id, type: 'com.tokenoftrust.storefront.fulfillment.assignment.updated' };
    event.data = { ...event.data, state };
    const result = await app.handleDelivery(gateway.deliver(event));
    assert.equal(result.status, 202);
    assert.equal((await result.work).status, state);
  }
  assert.equal(gateway.calls.recipientReads, 0);
  assert.equal(app.connector.assignmentState('asg_01J9Z4A8M1K2V3B4N5X6Y7Z8C9').state, 'cancelled');
});

test('the node:http adapter passes the raw bytes and answers before processing', async () => {
  const { gateway, app, logs } = setup();
  const delivery = gateway.deliver(createdEvent());
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = Object.fromEntries(Object.entries(delivery.headers).map(([k, v]) => [k.replace(/^./, (c) => c.toUpperCase()), v]));
  const res = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    writeHead(status) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    end(text) {
      this.body = text;
      this.writableEnded = true;
      return this;
    },
  };
  const done = new Promise((resolve) => {
    const listener = nodeRequestListener(app.handleDelivery, app.logger);
    listener(req, res);
    req.emit('data', delivery.rawBody.subarray(0, 10));
    req.emit('data', delivery.rawBody.subarray(10));
    req.emit('end');
    const wait = () => (logs().some((l) => l.kind === 'handoff') ? resolve() : setImmediate(wait));
    wait();
  });
  await done;
  assert.equal(res.statusCode, 202);
  assert.equal(JSON.parse(res.body).accepted, true);
});
