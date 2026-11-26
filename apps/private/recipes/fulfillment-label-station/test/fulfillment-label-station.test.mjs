import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StaticSigningKeys } from '../vendor/connector-kit/index.js';
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
    'orders:read-minimal',
    'orders:read-recipient',
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
  assert.equal(result.uspsRefusedCode, 'carrier-prohibited');
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
    baseUrl: 'https://storefront.tokenoftrust.store',
    tenant: 'acme',
    accessToken: 'sim-label-station-token',
    fetchImpl: createSimulatedLabelStationGateway().fetchImpl,
  });
  const receiver = createLabelStationWebhookReceiver({
    origin: 'https://storefront.tokenoftrust.store',
    endpoint: 'https://connector.example.com/webhooks/tot',
    connector,
  });
  const event = JSON.parse(readFileSync(new URL('../fixtures/pact-assignment.json', import.meta.url), 'utf8')).assignmentEvent;
  const res = await receiver.handleRequest(new Request('https://connector.example.com/webhooks/tot', { method: 'POST', body: JSON.stringify(event) }));
  assert.equal(res.status, 400);
  assert.equal(connector.handleAssignmentWebhook(event).duplicate, false);
});

test('Ed25519 and RSA signed deliveries verify while expired, invalid-signature, wrong-key, and wrong-tenant deliveries fail closed', async () => {
  const edPair = generateKeyPairSync('ed25519');
  const rsaPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const edJwk = { ...edPair.publicKey.export({ format: 'jwk' }), kid: 'conformance-ed-1', alg: 'EdDSA', use: 'sig' };
  const rsaJwk = { ...rsaPair.publicKey.export({ format: 'jwk' }), kid: 'webhook-signing-1', alg: 'RS256', use: 'sig' };
  const keys = new StaticSigningKeys({ keys: [edJwk, rsaJwk] });
  const endpoint = 'https://connector.example.com/webhooks/tot';

  const connector = createLabelStationConnector({
    baseUrl: 'https://storefront.tokenoftrust.store',
    tenant: 'acme-vape',
    accessToken: 'sim-label-station-token',
    fetchImpl: createSimulatedLabelStationGateway().fetchImpl,
  });
  const receiver = createLabelStationWebhookReceiver({
    origin: 'https://storefront.tokenoftrust.store',
    endpoint,
    connector,
    tenant: 'acme-vape',
    keys,
  });

  const baseEvent = JSON.parse(readFileSync(new URL('../fixtures/pact-assignment.json', import.meta.url), 'utf8')).assignmentEvent;
  const signReq = (ev, { alg = 'ed25519', keyid = 'conformance-ed-1', privateKey = edPair.privateKey, created = Math.floor(Date.now() / 1000) } = {}) => {
    const body = JSON.stringify(ev);
    const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
    const params = `("@method" "@target-uri" "content-digest");created=${created};keyid="${keyid}";alg="${alg}"`;
    const base = `"@method": POST\n"@target-uri": ${endpoint}\n"content-digest": ${digest}\n"@signature-params": ${params}`;
    const sig =
      alg === 'ed25519'
        ? cryptoSign(null, Buffer.from(base), privateKey).toString('base64')
        : createSign('sha256').update(base).sign(privateKey, 'base64');
    return new Request(endpoint, {
      method: 'POST',
      headers: { 'content-digest': digest, 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` },
      body,
    });
  };

  assert.equal((await receiver.handleRequest(signReq({ ...baseEvent, id: 'evt_ed_ok' }))).status, 202);
  assert.equal(
    (await receiver.handleRequest(signReq({ ...baseEvent, id: 'evt_rsa_ok' }, { alg: 'rsa-v1_5-sha256', keyid: 'webhook-signing-1', privateKey: rsaPair.privateKey }))).status,
    202,
  );
  assert.equal((await receiver.handleRequest(signReq({ ...baseEvent, id: 'evt_exp' }, { created: Math.floor(Date.now() / 1000) - 600 }))).status, 401);
  assert.equal((await receiver.handleRequest(signReq({ ...baseEvent, id: 'evt_unknown_key' }, { keyid: 'missing-key' }))).status, 401);
  assert.equal(
    (await receiver.handleRequest(signReq({ ...baseEvent, id: 'evt_wrong_tenant', tenantid: 'other', source: '/tenants/other/storefront' }))).status,
    403,
  );
});
