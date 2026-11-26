import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StaticSigningKeys } from '../vendor/connector-kit/index.js';
import {
  createDropshipWebhookReceiver,
  createMultiSupplierRoutingConnector,
  createSimulatedMultiSupplierGateway,
  normalizeExceptionCode,
  planStone2MultiVendorSplit,
  runSelfTest,
} from '../index.mjs';

test('dropship-multi-supplier manifest requests fulfillment, recipient, orders, and inventory scopes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../tot-app.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contractVersion, '1');
  assert.deepEqual(manifest.scopes, [
    'orders:read-minimal',
    'orders:read-recipient',
    'orders:webhook',
    'fulfillment:process',
    'inventory:read',
    'inventory:write',
  ]);
});

test('normalizeExceptionCode maps backordered, cannot_fulfill, and address_undeliverable onto contract codes', () => {
  assert.equal(normalizeExceptionCode('backordered'), 'backordered');
  assert.equal(normalizeExceptionCode('cannot_fulfill'), 'vendor_rejected');
  assert.equal(normalizeExceptionCode('address_undeliverable'), 'address_undeliverable');
});

test('self-test verifies Stone 1 location-keyed routing, partial shipments (order.partially_fulfilled -> order.fulfilled), exceptions, and Stone 2 split planning', async () => {
  const result = await runSelfTest();
  assert.equal(result.ok, true);
  assert.equal(result.routedLocationId, 'vendor-west-ca');
  assert.deepEqual(result.emittedEvents, ['order.partially_fulfilled', 'order.fulfilled']);
  assert.equal(result.exceptionsRecorded, 2);
  assert.equal(result.stone2SplitRoutes, 2);
});

test('planStone2MultiVendorSplit groups cart lines by (appInstallId, locationId)', () => {
  const bindings = new Map([
    ['wh-east', { appInstallId: 'inst_wh_east' }],
    ['vendor-alpha', { appInstallId: 'inst_dropship_alpha' }],
  ]);
  const routes = planStone2MultiVendorSplit({
    orderId: 'ord_99',
    cartLines: [
      { lineId: 'l1', sku: 'SKU-1', locationId: 'wh-east', quantity: 2 },
      { lineId: 'l2', sku: 'SKU-2', locationId: 'vendor-alpha', quantity: 1 },
      { lineId: 'l3', sku: 'SKU-3', locationId: 'vendor-alpha', quantity: 3 },
    ],
    locationBindings: bindings,
  });
  assert.equal(routes.length, 2);
  assert.equal(routes[0].appInstallId, 'inst_wh_east');
  assert.equal(routes[1].lines.length, 2);
});

test('dropship webhook receiver verifies Ed25519 conformance deliveries and fails closed on wrong tenant or expired signature', async () => {
  const edPair = generateKeyPairSync('ed25519');
  const edJwk = { ...edPair.publicKey.export({ format: 'jwk' }), kid: 'conformance-ed-1', alg: 'EdDSA', use: 'sig' };
  const keys = new StaticSigningKeys({ keys: [edJwk] });
  const endpoint = 'https://dropship.example.com/webhooks/tot';
  const connector = createMultiSupplierRoutingConnector({
    baseUrl: 'https://storefront.tokenoftrust.store',
    tenant: 'acme',
    accessToken: 'sim-dropship-token',
    fetchImpl: createSimulatedMultiSupplierGateway().fetchImpl,
  });
  const receiver = createDropshipWebhookReceiver({
    origin: 'https://storefront.tokenoftrust.store',
    endpoint,
    connector,
    tenant: 'acme',
    keys,
  });

  const makeEvent = (overrides = {}) => ({
    specversion: '1.0',
    id: 'evt_dropship_1',
    source: '/tenants/acme/storefront',
    type: 'com.tokenoftrust.storefront.fulfillment.assignment.created',
    time: '2026-11-26T00:00:00.000Z',
    datacontenttype: 'application/json',
    dataschemaversion: '1',
    tenantid: 'acme',
    appinstallid: 'inst_3pl_dropship_router',
    data: { assignmentId: 'asg_1', orderId: 'ord_1', stage: 'preview', state: 'active', eventVersion: 1, occurredAt: '2026-11-26T00:00:00.000Z' },
    ...overrides,
  });

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

  assert.equal((await receiver.handleRequest(signReq(makeEvent()))).status, 202);
  assert.equal((await receiver.handleRequest(signReq(makeEvent({ id: 'evt_exp' }), { created: Math.floor(Date.now() / 1000) - 600 }))).status, 401);
  assert.equal((await receiver.handleRequest(signReq(makeEvent({ id: 'evt_tenant', tenantid: 'other', source: '/tenants/other/storefront' })))).status, 403);
});
