import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StaticSigningKeys } from '../vendor/connector-kit/index.js';
import {
  classifyThresholdTransition,
  createSimulatedWmsGateway,
  createWmsWebhookReceiver,
  createWmsInventoryConnector,
  runSelfTest,
} from '../index.mjs';

test('inventory-sync-wms manifest declares least-privilege WMS scopes and private_key_jwt clientAuth', () => {
  const manifest = JSON.parse(readFileSync(new URL('../tot-app.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contractVersion, '1');
  assert.deepEqual(manifest.scopes, ['catalog:read', 'inventory:read', 'inventory:write']);
  assert.equal(manifest.clientAuth.method, 'private_key_jwt');
  assert.match(manifest.clientAuth.jwksUri, /^https:\/\//);
});

test('self-test exercises multi-location upsert, CAS reconciliation recovery, 7 WMS movement reasons, and threshold transitions', async () => {
  const result = await runSelfTest();
  assert.equal(result.ok, true);
  assert.equal(result.locationsDeclared, 2);
  assert.equal(result.casRetriedAfterConflict, true);
  assert.equal(result.batchItemsCommitted, 7);
  assert.deepEqual(result.transitions, ['steady', 'low_stock', 'out_of_stock', 'back_in_stock']);
});

test('duplicate inventory.changed CloudEvent ids are deduplicated without re-firing transitions', () => {
  const sim = createSimulatedWmsGateway();
  const connector = createWmsInventoryConnector({
    baseUrl: 'https://storefront.tokenoftrust.store',
    tenant: 'acme',
    accessToken: 'sim-wms-token',
    fetchImpl: sim.fetchImpl,
  });
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/inventory.changed.cloudevent.json', import.meta.url), 'utf8'));
  const first = connector.handleInventoryChangedWebhook(fixture);
  assert.equal(first.duplicate, false);
  assert.equal(first.transition, 'low_stock');

  const second = connector.handleInventoryChangedWebhook(fixture);
  assert.equal(second.duplicate, true);
  assert.equal(second.transition, null);
});

test('classifyThresholdTransition distinguishes low_stock, out_of_stock, and back_in_stock accurately', () => {
  assert.equal(classifyThresholdTransition({ previousAvailable: 12, currentAvailable: 4, lowStockThreshold: 5 }), 'low_stock');
  assert.equal(classifyThresholdTransition({ previousAvailable: 4, currentAvailable: 0, lowStockThreshold: 5 }), 'out_of_stock');
  assert.equal(classifyThresholdTransition({ previousAvailable: 0, currentAvailable: 9, lowStockThreshold: 5 }), 'back_in_stock');
});

test('an unsigned delivery is refused by the kit receiver and never reaches the connector', async () => {
  const connector = createWmsInventoryConnector({
    baseUrl: 'https://storefront.tokenoftrust.store',
    tenant: 'acme',
    accessToken: 'sim-wms-token',
    fetchImpl: createSimulatedWmsGateway().fetchImpl,
  });
  const fixture = readFileSync(new URL('../fixtures/inventory.changed.cloudevent.json', import.meta.url), 'utf8');
  const receiver = createWmsWebhookReceiver({
    origin: 'https://storefront.tokenoftrust.store',
    endpoint: 'https://connector.example.com/webhooks/tot',
    connector,
  });
  const res = await receiver.handleRequest(new Request('https://connector.example.com/webhooks/tot', { method: 'POST', body: fixture }));
  assert.equal(res.status, 400);
  assert.equal(connector.handleInventoryChangedWebhook(JSON.parse(fixture)).duplicate, false);
});

test('WMS webhook receiver verifies Ed25519 deliveries and fails closed on wrong tenant or expired signature', async () => {
  const edPair = generateKeyPairSync('ed25519');
  const edJwk = { ...edPair.publicKey.export({ format: 'jwk' }), kid: 'conformance-ed-1', alg: 'EdDSA', use: 'sig' };
  const keys = new StaticSigningKeys({ keys: [edJwk] });
  const endpoint = 'https://connector.example.com/webhooks/tot';
  const connector = createWmsInventoryConnector({
    baseUrl: 'https://storefront.tokenoftrust.store',
    tenant: 'acme',
    accessToken: 'sim-wms-token',
    fetchImpl: createSimulatedWmsGateway().fetchImpl,
  });
  const receiver = createWmsWebhookReceiver({
    origin: 'https://storefront.tokenoftrust.store',
    endpoint,
    connector,
    tenant: 'acme',
    keys,
  });
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/inventory.changed.cloudevent.json', import.meta.url), 'utf8'));

  const signReq = (ev, { created = Math.floor(Date.now() / 1000) } = {}) => {
    const body = JSON.stringify(ev);
    const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
    const params = `("@method" "@target-uri" "content-digest");created=${created};keyid="conformance-ed-1";alg="ed25519"`;
    const base = `"@method": POST\n"@target-uri": ${endpoint}\n"content-digest": ${digest}\n"@signature-params": ${params}`;
    const sig = cryptoSign(null, Buffer.from(base), edPair.privateKey).toString('base64');
    return new Request(endpoint, {
      method: 'POST',
      headers: { 'content-digest': digest, 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` },
      body,
    });
  };

  assert.equal((await receiver.handleRequest(signReq({ ...fixture, id: 'evt_wms_ed_1' }))).status, 202);
  assert.equal((await receiver.handleRequest(signReq({ ...fixture, id: 'evt_wms_exp' }, { created: Math.floor(Date.now() / 1000) - 600 }))).status, 401);
  assert.equal((await receiver.handleRequest(signReq({ ...fixture, id: 'evt_wms_tenant', tenantid: 'other', source: '/tenants/other/storefront' }))).status, 403);
});
