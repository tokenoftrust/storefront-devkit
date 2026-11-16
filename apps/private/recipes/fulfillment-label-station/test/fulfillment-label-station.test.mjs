import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PLATFORM_CARRIER_CATALOG,
  createLabelStationConnector,
  createLabelStationWebhookReceiver,
  createSimulatedLabelStationGateway,
  resolveCarrierProfile,
  runSelfTest,
} from '../index.mjs';

test('fulfillment-label-station manifest requests least-privilege fulfillment and recipient scopes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../tot-app.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contractVersion, '1');
  assert.deepEqual(manifest.scopes, [
    'orders:read:minimal',
    'orders:read:recipient',
    'orders:webhook',
    'fulfillment:process',
  ]);
  assert.ok(manifest.webhooks.topics.includes('fulfillment.assignment.created'));
  assert.ok(manifest.webhooks.topics.includes('order.partially_fulfilled'));
});

test('carrier catalog resolves all national and regional PACT carriers and flags USPS as PACT-ineligible', () => {
  const requiredSlugs = [
    'ups',
    'fedex',
    'dhl_express',
    'ontrac',
    'lasership',
    'gso_gls',
    'lso',
    'spee_dee',
    'stat_overnight',
    'better_trucks',
  ];
  for (const slug of requiredSlugs) {
    const profile = resolveCarrierProfile(slug, PLATFORM_CARRIER_CATALOG);
    assert.ok(profile, `Expected profile for ${slug}`);
    assert.equal(profile.pactEligible, true, `Expected ${slug} to be PACT eligible`);
  }
  const usps = resolveCarrierProfile('usps', PLATFORM_CARRIER_CATALOG);
  assert.equal(usps.pactEligible, false);
});

test('self-test verifies PACT USPS refusal, 1:N split cartons, and whole-order label-voided recovery', async () => {
  const result = await runSelfTest();
  assert.equal(result.ok, true);
  assert.equal(result.uspsRefusedCode, 'pact_carrier_ineligible');
  assert.equal(result.splitShipmentsComplete, true);
  assert.equal(result.replacementPurchaseId, 'pur_PACT9001_A2');
  assert.deepEqual(result.emittedTopics, [
    'order.partially_fulfilled',
    'order.fulfilled',
    'order.fulfilled',
  ]);
});

test('an unsigned delivery is refused by the kit receiver and never reaches the connector', async () => {
  const connector = createLabelStationConnector({
    baseUrl: 'https://tot-preview.tokenoftrust.store',
    accessToken: 'sim-label-station-token',
    fetchImpl: createSimulatedLabelStationGateway().fetchImpl,
  });
  const receiver = createLabelStationWebhookReceiver({
    origin: 'https://tot-preview.tokenoftrust.store',
    endpoint: 'https://connector.example.com/webhooks/tot',
    connector,
  });
  const event = JSON.parse(readFileSync(new URL('../fixtures/pact-assignment.json', import.meta.url), 'utf8')).assignmentEvent;
  const res = await receiver.handleRequest(new Request('https://connector.example.com/webhooks/tot', { method: 'POST', body: JSON.stringify(event) }));
  assert.equal(res.status, 400);
  assert.equal(connector.handleAssignmentWebhook(event).duplicate, false);
});
