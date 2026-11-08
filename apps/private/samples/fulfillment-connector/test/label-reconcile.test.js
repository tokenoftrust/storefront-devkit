// The label decision across passes and restarts. The provider, not in-memory
// state, says whether a label was already attempted, so a lost isolate never
// reads the recipient again or buys a second label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorApp } from '../src/app.js';
import { createSimulatedLabelProvider } from '../src/label-provider.js';
import { createLogger } from '../src/log.js';
import { createLocalGateway, example, SIM_BASE_URL, SIM_CLIENT_ID, SIM_CLIENT_SECRET, SIM_WEBHOOK_URL } from '../sim/local-gateway.js';

const PURCHASED = { outcome: 'purchased', carrier: 'UPS', service: 'GROUND', trackingNumber: 'SIM00000000000000001', trackingUrl: 'https://www.ups.com/track?tracknum=SIM00000000000000001', adultSignature: 'accepted' };

/** A provider whose purchase answers unknown and whose later lookups answer `answers` in turn. */
function unresolvedProvider(answers) {
  const calls = { purchases: 0, lookups: 0 };
  let attempted = false;
  return {
    calls,
    async purchase() {
      calls.purchases++;
      attempted = true;
      return { outcome: 'unknown' };
    },
    async lookup() {
      calls.lookups++;
      if (!attempted) return null;
      const next = answers.length > 1 ? answers.shift() : answers[0];
      return next === 'purchased' ? { ...PURCHASED } : { outcome: next };
    },
    async handoff() {
      return { accepted: true, carrier: 'UPS' };
    },
  };
}

function appFor(gateway, labelProvider, lines = []) {
  return createConnectorApp({
    baseUrl: SIM_BASE_URL,
    clientId: SIM_CLIENT_ID,
    clientSecret: SIM_CLIENT_SECRET,
    webhookUrl: SIM_WEBHOOK_URL,
    fetchImpl: gateway.fetch,
    labelProvider,
    logger: createLogger((l) => lines.push(l)),
    sleep: async () => {},
  });
}

const posted = (gateway) => gateway.calls.evidence.map((e) => `${e.body.kind}:${e.body.outcome ?? ''}`);

test('an unknown label that stays unresolved: one recipient read, one unknown post, then purchased', async () => {
  const gateway = createLocalGateway();
  const provider = unresolvedProvider(['unknown', 'purchased']);
  const app = appFor(gateway, provider);
  assert.deepEqual(await app.connector.reconcileAll(), [{ status: 'pending', label: 'unknown' }]);
  assert.deepEqual(posted(gateway), ['label-outcome:unknown']);
  assert.deepEqual(await app.connector.reconcileAll(), [{ status: 'fulfilled', version: 10 }]);
  assert.deepEqual(posted(gateway), ['label-outcome:unknown', 'label-outcome:purchased', 'handoff:']);
  assert.equal(gateway.calls.recipientReads, 1);
  assert.equal(provider.calls.purchases, 1);
});

test('after a restart (fresh app, lost state) an unknown label is looked up, never bought or re-read', async () => {
  const gateway = createLocalGateway();
  const provider = unresolvedProvider(['unknown', 'unknown', 'unknown', 'purchased']);
  assert.deepEqual(await appFor(gateway, provider).connector.reconcileAll(), [{ status: 'pending', label: 'unknown' }]);

  const restarted = appFor(gateway, provider);
  assert.deepEqual(await restarted.connector.reconcileAll(), [{ status: 'pending', label: 'unknown' }]);
  assert.equal(restarted.connector.assignmentState('asg_01J9Z4A8M1K2V3B4N5X6Y7Z8C9').state, 'active');
  const regress = gateway.calls.evidence[1];
  assert.equal(regress.body.outcome, 'unknown');

  const again = appFor(gateway, provider);
  assert.deepEqual(await again.connector.reconcileAll(), [{ status: 'fulfilled', version: 10 }]);
  assert.equal(gateway.calls.recipientReads, 1);
  assert.equal(provider.calls.purchases, 1);
  assert.deepEqual(posted(gateway).filter((k) => k !== 'label-outcome:unknown'), ['label-outcome:purchased', 'handoff:']);
});

test('after a refused label-outcome post the next pass does not read the contact again, in the same app or a fresh one', async () => {
  for (const fresh of [false, true]) {
    const gateway = createLocalGateway();
    const realFetch = gateway.fetch;
    let refusals = 4;
    gateway.fetch = async (url, init = {}) => {
      if (String(url).endsWith('/shipment-evidence') && refusals > 0) {
        refusals--;
        return new Response(JSON.stringify({ code: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(url, init);
    };
    const provider = createSimulatedLabelProvider();
    const app = appFor(gateway, provider);
    assert.deepEqual(await app.connector.reconcileAll(), [{ status: 'stopped', code: 'unavailable' }]);
    assert.equal(gateway.calls.recipientReads, 1);
    const next = fresh ? appFor(gateway, provider) : app;
    assert.deepEqual(await next.connector.reconcileAll(), [{ status: 'fulfilled', version: 9 }]);
    assert.equal(gateway.calls.recipientReads, 1, fresh ? 'fresh app' : 'same app');
  }
});

test('a voided label outcome stops before handoff and the assignment is not processed again', async () => {
  const { line1: _dropped, ...incomplete } = example('fulfillment.recipient.response.json');
  const gateway = createLocalGateway({ recipient: incomplete });
  const app = appFor(gateway, createSimulatedLabelProvider());
  assert.deepEqual(await app.connector.reconcileAll(), [{ status: 'stopped', label: 'voided' }]);
  assert.deepEqual(posted(gateway), ['label-outcome:voided']);
  assert.equal(gateway.order.handoff, 'none');
  assert.equal(app.connector.assignmentState('asg_01J9Z4A8M1K2V3B4N5X6Y7Z8C9').state, 'voided');
  assert.deepEqual(await app.connector.reconcileAll(), [{ status: 'skipped', state: 'voided' }]);
  assert.equal(gateway.calls.recipientReads, 1);
});

test('an assignment-held refusal records held, and a held assignment is not processed', async () => {
  const gateway = createLocalGateway();
  const realFetch = gateway.fetch;
  gateway.fetch = async (url, init = {}) =>
    String(url).endsWith('/shipment-evidence')
      ? new Response(JSON.stringify({ code: 'assignment-held' }), { status: 409, headers: { 'content-type': 'application/json' } })
      : realFetch(url, init);
  const app = appFor(gateway, createSimulatedLabelProvider());
  const created = example('fulfillment.assignment.created.cloudevent.json');
  const first = await app.handleDelivery(gateway.deliver(created));
  assert.deepEqual(await first.work, { status: 'stopped', code: 'assignment-held' });
  assert.equal(app.connector.assignmentState(created.data.assignmentId).state, 'held');

  const reads = gateway.calls.recipientReads;
  const evidence = gateway.calls.evidence.length;
  const held = { ...created, id: 'evt_held_0001', type: 'com.tokenoftrust.storefront.fulfillment.assignment.updated', data: { ...created.data, state: 'held', eventVersion: 8 } };
  const delivery = await app.handleDelivery(gateway.deliver(held));
  assert.equal(delivery.status, 202);
  assert.deepEqual(await delivery.work, { status: 'held' });
  assert.equal(gateway.calls.recipientReads, reads);
  assert.equal(gateway.calls.evidence.length, evidence);
});
