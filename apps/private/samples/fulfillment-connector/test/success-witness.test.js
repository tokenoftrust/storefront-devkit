import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnector } from '../src/connector.js';
import { createLogger } from '../src/log.js';
import { example } from '../sim/local-gateway.js';

const RECONCILED = 'reconciliation-read-succeeded';
const RECIPIENT = 'recipient-read-succeeded';
const SENTINEL = 'PRIVATE_SUCCESS_WITNESS_SENTINEL';
const assignment = () => example('fulfillment.assignments.response.json').assignments[0];

function setup({ list, recipient, cached = false, purchase } = {}) {
  const item = { ...assignment(), unknown: SENTINEL };
  const lines = [];
  const sequence = [];
  const logger = createLogger((line) => {
    lines.push(line);
    const { kind } = JSON.parse(line);
    if ([RECONCILED, RECIPIENT].includes(kind)) sequence.push(kind);
  });
  const gateway = {
    async listAssignments() {
      assert.ok(!sequence.includes(RECONCILED), 'reconciliation_witness_before_success');
      const result = list ? await list() : { ok: true, assignments: [item], unknown: SENTINEL };
      sequence.push('list-return');
      return result;
    },
    async readRecipient() {
      assert.ok(!sequence.includes(RECIPIENT), 'recipient_witness_before_success');
      sequence.push('recipient-call');
      const result = recipient ? await recipient() : { ok: true, body: { unknown: SENTINEL }, requestId: SENTINEL };
      sequence.push('recipient-return');
      return result;
    },
    async postShipmentEvidence() { return { ok: true, body: { version: 8 } }; },
  };
  const labelProvider = {
    async lookup() { return cached ? { outcome: 'voided' } : null; },
    async purchase(input) {
      sequence.push('purchase');
      if (purchase) return purchase(input);
      return { outcome: 'voided' };
    },
  };
  const connector = createConnector({ gateway, labelProvider, logger });
  const run = (path, state = 'active') => path === 'event'
    ? connector.onAssignmentEvent({ data: { ...item, state } })
    : connector.reconcileAll();
  return { item, lines, sequence, run, logs: () => lines.map((line) => JSON.parse(line)) };
}

test('both entry points witness successful reconciliation and recipient return in exact order', async () => {
  for (const path of ['event', 'reconcile']) {
    const ctx = setup();
    await ctx.run(path);
    assert.deepEqual(ctx.sequence, ['list-return', RECONCILED, 'recipient-call',
      'recipient-return', RECIPIENT, 'purchase'], 'success_witness_missing_or_misordered');
    assert.ok(!ctx.lines.join('').includes(SENTINEL), 'success_witness_payload_leaked');
    const witnesses = ctx.logs().filter((line) => [RECONCILED, RECIPIENT].includes(line.kind));
    assert.equal(witnesses.length, 2);
    for (const line of witnesses) {
      assert.deepEqual(Object.keys(line).sort(), ['assignmentId', 'kind', 'level', 'msg', 'orderId', 'time'],
        'success_witness_field_not_allowlisted');
      assert.equal(line.orderId, ctx.item.orderId);
      assert.equal(line.assignmentId, ctx.item.assignmentId);
      assert.equal(line.level, 'info');
      assert.match(line.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.equal(line.msg, line.kind === RECONCILED ? 'reconciliation assignment read' : 'recipient read returned');
    }
  }
});

test('absent, unrelated and held or cancelled event assignments emit no success witnesses', async () => {
  for (const assignments of [[], [{ ...assignment(), orderId: 'ord_other_fixture' }]]) {
    const ctx = setup({ list: async () => ({ ok: true, assignments }) });
    assert.deepEqual(await ctx.run('event'), { status: 'absent' });
    assert.deepEqual(ctx.sequence, ['list-return'], 'unmatched_assignment_witnessed_as_success');
  }
  for (const state of ['held', 'cancelled']) {
    const ctx = setup();
    assert.deepEqual(await ctx.run('event', state), { status: state });
    assert.deepEqual(ctx.sequence, [], 'inactive_event_witnessed_as_success');
  }
});

test('refused or thrown reconciliation emits neither success witness', async () => {
  for (const path of ['event', 'reconcile']) {
    for (const thrown of [false, true]) {
      const ctx = setup({ list: async () => {
        if (thrown) throw new Error(SENTINEL);
        return { ok: false, status: 403, code: 'not-assigned' };
      } });
      if (thrown) await assert.rejects(ctx.run(path));
      else await ctx.run(path);
      assert.ok(!ctx.sequence.includes(RECONCILED), 'failed_reconciliation_witnessed_as_success');
      assert.ok(!ctx.sequence.includes(RECIPIENT), 'recipient_witness_without_return');
    }
  }
});

test('refused or thrown recipient read emits no recipient success or purchase', async () => {
  for (const thrown of [false, true]) {
    const ctx = setup({ recipient: async () => {
      if (thrown) throw new Error(SENTINEL);
      return { ok: false, status: 403, code: 'not-assigned' };
    } });
    if (thrown) await assert.rejects(ctx.run('event'));
    else await ctx.run('event');
    assert.ok(ctx.sequence.includes(RECONCILED), 'successful_reconciliation_not_witnessed');
    assert.ok(!ctx.sequence.includes(RECIPIENT), 'failed_recipient_return_witnessed_as_success');
    assert.ok(!ctx.sequence.includes('purchase'));
    assert.ok(!ctx.lines.join('').includes(SENTINEL), 'failure_payload_leaked');
  }
});

test('cached label bypass emits reconciliation witness without a recipient return witness', async () => {
  const ctx = setup({ cached: true });
  await ctx.run('event');
  assert.deepEqual(ctx.sequence, ['list-return', RECONCILED], 'cached_label_fabricated_recipient_witness');
});

test('successful recipient return remains witnessed when the later purchase throws', async () => {
  const ctx = setup({ purchase: async () => { throw new Error(SENTINEL); } });
  await assert.rejects(ctx.run('event'), { code: 'label_provider_failed' });
  assert.deepEqual(ctx.sequence, ['list-return', RECONCILED, 'recipient-call',
    'recipient-return', RECIPIENT, 'purchase'], 'recipient_witness_deferred_until_purchase');
  assert.ok(!ctx.lines.join('').includes(SENTINEL), 'provider_error_payload_leaked');
});
