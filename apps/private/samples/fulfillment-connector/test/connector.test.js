import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnector } from '../src/connector.js';
import { idempotencyKeyFor } from '../src/gateway-client.js';
import { createSimulatedLabelProvider } from '../src/label-provider.js';
import { createLogger } from '../src/log.js';
import { example } from '../sim/local-gateway.js';
import { setup } from './helpers.js';

const event = () => example('fulfillment.assignment.created.cloudevent.json');

async function run(simulate) {
  const ctx = setup({ simulate });
  const delivery = await ctx.app.handleDelivery(ctx.gateway.deliver(event()));
  ctx.outcome = await delivery.work;
  return ctx;
}

test('happy path: label-outcome then handoff, under stable keys, matching the contract examples', async () => {
  const { gateway, outcome } = await run();
  assert.deepEqual(outcome, { status: 'fulfilled', version: 9 });
  assert.equal(gateway.calls.recipientReads, 1);
  const [label, handoff] = gateway.calls.evidence;
  assert.equal(gateway.calls.evidence.length, 2);
  assert.equal(label.body.kind, 'label-outcome');
  assert.equal(label.body.outcome, 'purchased');
  assert.equal(label.body.purchaseId, 'pur_EXAMPLE0001');
  assert.equal(label.body.expectedVersion, 7);
  assert.equal(handoff.body.kind, 'handoff');
  assert.equal(handoff.body.carrier, label.body.carrier);
  assert.equal(handoff.body.expectedVersion, 8);
  assert.equal(label.key, idempotencyKeyFor('ord_10482', label.body));
  assert.equal(handoff.key, idempotencyKeyFor('ord_10482', handoff.body));
  assert.equal(gateway.order.handoff, 'handed_off');
});

test('the same fact always derives the same Idempotency-Key, and a different fact a different one', () => {
  const body = example('fulfillment.shipment-evidence.handoff.request.json');
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  assert.equal(idempotencyKeyFor('ord_10482', body), idempotencyKeyFor('ord_10482', reordered));
  assert.notEqual(idempotencyKeyFor('ord_10482', body), idempotencyKeyFor('ord_10482', { ...body, expectedVersion: 9 }));
  const key = idempotencyKeyFor('ord_10482', body);
  assert.ok(key.length >= 8 && key.length <= 128);
});

test('--label-outcome=unknown: reports unknown, reconciles under the same purchase id, never buys or reads twice', async () => {
  const { gateway, outcome } = await run({ unknownLabelOutcome: true });
  assert.equal(outcome.status, 'fulfilled');
  const kinds = gateway.calls.evidence.map((e) => `${e.body.kind}:${e.body.outcome ?? ''}`);
  assert.deepEqual(kinds, ['label-outcome:unknown', 'label-outcome:purchased', 'handoff:']);
  const unknown = gateway.calls.evidence[0].body;
  assert.deepEqual(Object.keys(unknown).sort(), ['assignmentId', 'expectedVersion', 'kind', 'outcome', 'purchaseId']);
  assert.ok(gateway.calls.evidence.every((e) => e.body.purchaseId === 'pur_EXAMPLE0001'));
  assert.equal(gateway.calls.recipientReads, 1);
});

test('--force-retry: the same key and identical body are re-sent and the original response is replayed', async () => {
  const { gateway, logs, outcome } = await run({ forceRetry: true });
  assert.equal(outcome.status, 'fulfilled');
  const evidence = gateway.calls.evidence;
  assert.equal(evidence.length, 4);
  assert.equal(evidence[0].key, evidence[1].key);
  assert.deepEqual(evidence[0].body, evidence[1].body);
  assert.equal(evidence[2].key, evidence[3].key);
  const retries = logs().filter((l) => l.msg === 'forced retry with the same Idempotency-Key');
  assert.equal(retries.length, 2);
  assert.ok(retries.every((l) => l.matched === true));
  assert.equal(gateway.order.version, 9);
});

test('--conflicting-key-reuse: reusing the label key for the handoff body is refused with idempotency-conflict', async () => {
  const { gateway, logs, outcome } = await run({ conflictingKeyReuse: true });
  assert.equal(outcome.status, 'fulfilled');
  const [label, misuse, handoff] = gateway.calls.evidence;
  assert.equal(misuse.key, label.key);
  assert.equal(misuse.body.kind, 'handoff');
  assert.notEqual(handoff.key, label.key);
  const probe = logs().find((l) => l.msg === 'conflicting key reuse probe');
  assert.deepEqual([probe.refused, probe.code], [true, 'idempotency-conflict']);
});

test('an order absent from the reconciliation read is not touched', async () => {
  const ctx = setup();
  const other = event();
  other.id = 'evt_other_order';
  other.data.orderId = 'ord_not_mine';
  const delivery = await ctx.app.handleDelivery(ctx.gateway.deliver(other));
  assert.deepEqual(await delivery.work, { status: 'absent' });
  assert.equal(ctx.gateway.calls.recipientReads, 0);
  assert.equal(ctx.gateway.calls.evidence.length, 0);
});

test('the reconciliation pass fulfills an assignment whose delivery was lost', async () => {
  const { gateway, app } = setup();
  const results = await app.connector.reconcileAll();
  assert.deepEqual(results, [{ status: 'fulfilled', version: 9 }]);
  assert.deepEqual(await app.connector.reconcileAll(), []);
  assert.equal(gateway.calls.recipientReads, 1);
});

test('an ended assignment stops processing on its refusal code', async () => {
  const assignment = example('fulfillment.assignments.response.json').assignments[0];
  const stale = { ...assignment, assignmentId: 'asg_SUPERSEDED' };
  const stubGateway = {
    listAssignments: async () => ({ ok: true, assignments: [stale] }),
    readRecipient: async () => ({ ok: true, body: example('fulfillment.recipient.response.json') }),
    postShipmentEvidence: async () => ({ ok: false, status: 409, code: 'assignment-ended' }),
  };
  const connector = createConnector({ gateway: stubGateway, labelProvider: createSimulatedLabelProvider(), logger: createLogger(() => {}) });
  assert.deepEqual(await connector.onAssignmentEvent({ data: { assignmentId: 'asg_SUPERSEDED', orderId: stale.orderId, state: 'active' } }), { status: 'stopped', code: 'assignment-ended' });
  assert.equal(connector.assignmentState('asg_SUPERSEDED').state, 'ended');
  assert.deepEqual(await connector.reconcileAll(), [{ status: 'skipped', state: 'ended' }]);
});
