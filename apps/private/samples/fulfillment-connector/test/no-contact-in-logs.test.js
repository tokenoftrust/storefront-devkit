import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/log.js';
import { example } from '../sim/local-gateway.js';
import { setup } from './helpers.js';

// Distinctive synthetic values so a leak cannot hide behind a common word.
const RECIPIENT = {
  orderId: 'ord_10482',
  name: 'Quorra Placeholderson',
  company: 'Zyxwv Placeholder Works',
  line1: '9876 Synthetic Lane',
  line2: 'Unit Qx-42',
  city: 'Fictionburgh',
  region: 'QZ',
  postalCode: '98765-4321',
  country: 'NZ',
};

function contactLeaks(text) {
  const leaks = [];
  for (const [field, value] of Object.entries(RECIPIENT)) {
    if (field === 'orderId') continue;
    const needle = value.length >= 4 ? value : `"${value}"`;
    if (text.includes(needle)) leaks.push(field);
  }
  return leaks;
}

/** Capture every byte written to stdout/stderr while `fn` runs. */
async function captureProcessOutput(fn) {
  const chunks = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return out.call(process.stdout, chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return err.call(process.stderr, chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return chunks.join('');
}

test('no recipient value reaches the log output across every flow, including all simulation flags', async () => {
  for (const simulate of [{}, { unknownLabelOutcome: true }, { forceRetry: true }, { conflictingKeyReuse: true }, { unknownLabelOutcome: true, forceRetry: true, conflictingKeyReuse: true }]) {
    let ctx;
    const processOutput = await captureProcessOutput(async () => {
      ctx = setup({ simulate, gatewayOptions: { recipient: RECIPIENT } });
      const delivery = await ctx.app.handleDelivery(ctx.gateway.deliver(example('fulfillment.assignment.created.cloudevent.json')));
      assert.equal((await delivery.work).status, 'fulfilled');
      await ctx.app.connector.reconcileAll();
    });
    assert.equal(ctx.gateway.calls.recipientReads, 1, 'the recipient was actually read');
    assert.ok(ctx.logs().some((l) => l.kind === 'handoff'), 'the flow logged through to the handoff');
    const logged = ctx.lines.join('\n');
    assert.deepEqual(contactLeaks(logged), [], `logger output leaked contact (${JSON.stringify(simulate)})`);
    assert.deepEqual(contactLeaks(processOutput), [], `process output leaked contact (${JSON.stringify(simulate)})`);
    assert.deepEqual(contactLeaks(JSON.stringify(ctx.gateway.calls.evidence)), [], 'evidence carried contact');
  }
});

test('the logger drops recipient- and credential-shaped fields even if a caller passes them', () => {
  const lines = [];
  const logger = createLogger((line) => lines.push(line));
  logger.info('careless call', { recipient: RECIPIENT, ...RECIPIENT, orderId: 'ord_1', postal_code: RECIPIENT.postalCode, authorization: 'Bearer x', client_secret: 'y' });
  assert.deepEqual(contactLeaks(lines.join('')), []);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.orderId, 'ord_1');
  assert.equal(parsed.authorization, undefined);
  assert.equal(parsed.client_secret, undefined);
});
