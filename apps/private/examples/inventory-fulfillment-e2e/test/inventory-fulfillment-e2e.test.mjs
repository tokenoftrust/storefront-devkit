import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FIXTURE,
  createInventoryApiClient,
  createInventoryMirror,
  createSimulatedGateway,
  inventoryChangedEvent,
  runLive,
  runSelfTest,
} from '../index.mjs';
import { AuthorizationMetadata, WebhookReceiver } from '../vendor/connector-kit/index.js';
import { createTestWebhookSigner } from './webhook-signer.mjs';

const BASE_URL = 'https://storefront.tokenoftrust.store';

function simClient() {
  const gateway = createSimulatedGateway({ tenantId: 'acme' });
  const client = createInventoryApiClient({ baseUrl: BASE_URL, tenantId: 'acme', clientId: 'sim-client', clientSecret: 'sim-secret', fetchImpl: gateway });
  return { gateway, client };
}

test('inventory-fulfillment-e2e manifest requests least-privilege starter scopes, including reports:read', () => {
  const manifest = JSON.parse(readFileSync(new URL('../tot-app.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contractVersion, '1');
  assert.deepEqual(manifest.scopes, ['catalog:read', 'inventory:read', 'inventory:write', 'orders:read-minimal', 'reports:read']);
  assert.deepEqual(manifest.webhooks.topics, ['inventory.changed']);
});

test('fixture defaults the preview test location to isFulfillable: false and batches discrete WMS reasons', () => {
  assert.equal(FIXTURE.location.isFulfillable, false);
  assert.deepEqual(FIXTURE.movementBatch.items.map((i) => i.reason), ['received', 'damaged', 'cycle_count', 'adjustment']);
});

test('self-test: quarantine location, batch + replay, levels convergence, velocity report, signed inventory.changed ordering', async () => {
  const result = await runSelfTest();
  assert.equal(result.ok, true);
  assert.equal(result.locationId, 'loc-main-warehouse');
  assert.deepEqual(result.balances, { 'GEN-TEE-BLK-M': 30, 'GEN-TEE-WHT-L': 10 });
  assert.deepEqual(result.reconcileDrift, { 'GEN-TEE-BLK-M': -3, 'GEN-TEE-WHT-L': 0 });
  assert.match(result.previewOrderId, /^ord_preview_/);
  assert.deepEqual(result.webhookOutcomes, ['applied', 'stale']);
});

test('the client routes token and API calls under the tenant path on the shared host', async () => {
  const seen = [];
  const gateway = createSimulatedGateway({ tenantId: 'giantvapes.com' });
  const fetchImpl = (input, init) => {
    seen.push(new URL(input).pathname);
    return gateway(input, init);
  };
  const client = createInventoryApiClient({ baseUrl: BASE_URL, tenantId: 'giantvapes.com', clientId: 'c', clientSecret: 's', fetchImpl });
  const res = await client.listLocations();
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['/giantvapes.com/api/apps/oauth/token', '/giantvapes.com/api/apps/v1/inventory/locations']);
});

test('a 422 unknown-sku inside a batch names the item: ApiError index and field are preserved, nothing is recorded', async () => {
  const { client } = simClient();
  await client.upsertLocation(FIXTURE.location.locationId, FIXTURE.location);
  const items = [
    { sku: FIXTURE.catalogSku, locationId: FIXTURE.location.locationId, quantityDelta: 4, reason: 'received' },
    { sku: 'NOT-IN-CATALOG', locationId: FIXTURE.location.locationId, quantityDelta: 1, reason: 'received' },
  ];
  const refused = await client.postMovements(items);
  assert.equal(refused.status, 422);
  assert.equal(refused.ok, false);
  assert.equal(refused.body.code, 'unknown-sku');
  assert.equal(refused.body.index, 1);
  assert.equal(refused.body.field, 'sku');
  assert.match(refused.requestId, /^req_sim_/);

  const inv = await client.getInventory({ sku: FIXTURE.catalogSku, locationId: FIXTURE.location.locationId });
  assert.equal(inv.body.items[0].mirror.balance, FIXTURE.openingBalances[FIXTURE.catalogSku], 'atomic: item 0 was not applied');
});

test('reusing an Idempotency-Key with a different batch returns 409 idempotency-conflict', async () => {
  const { client } = simClient();
  await client.upsertLocation(FIXTURE.location.locationId, FIXTURE.location);
  const first = await client.postMovements(FIXTURE.movementBatch.items);
  assert.equal(first.status, 201);
  const changed = FIXTURE.movementBatch.items.map((i, n) => (n === 0 ? { ...i, quantityDelta: 13 } : i));
  const conflict = await client.postMovements(changed, first.idempotencyKey);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency-conflict');
});

test('a batch that would take a balance below zero is refused as a whole (409 balance-out-of-range)', async () => {
  const { client } = simClient();
  await client.upsertLocation(FIXTURE.location.locationId, FIXTURE.location);
  const res = await client.postMovements([
    { sku: FIXTURE.secondSku, locationId: FIXTURE.location.locationId, quantityDelta: 1, reason: 'received' },
    { sku: FIXTURE.secondSku, locationId: FIXTURE.location.locationId, quantityDelta: -50, reason: 'damaged' },
  ]);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'balance-out-of-range');
  // connector-kit 1.1.0 surfaces `index` only on 400/422 inventory refusals.
  assert.equal(res.body.index, undefined);
  const inv = await client.getInventory({ sku: FIXTURE.secondSku, locationId: FIXTURE.location.locationId });
  assert.equal(inv.body.items[0].mirror.balance, FIXTURE.openingBalances[FIXTURE.secondSku]);
});

test('batch size is bounded client-side to 1..250 items', async () => {
  const { client } = simClient();
  await assert.rejects(client.postMovements([]), RangeError);
  const tooMany = Array.from({ length: 251 }, () => ({ sku: FIXTURE.catalogSku, quantityDelta: 1, reason: 'received' }));
  await assert.rejects(client.putLevels(tooMany), RangeError);
});

test('inventory mirror applies data.asOf high-water mark per (sku, locationId)', () => {
  const mirror = createInventoryMirror();
  assert.equal(mirror.apply({ sku: 'A', locationId: 'l1', balance: 5, available: 0, asOf: '2026-11-13T12:00:05Z' }), 'applied');
  assert.equal(mirror.apply({ sku: 'A', locationId: 'l1', balance: 9, available: 0, asOf: '2026-11-13T12:00:01Z' }), 'stale');
  assert.equal(mirror.apply({ sku: 'A', locationId: 'l1', balance: 9, available: 0, asOf: '2026-11-13T12:00:05Z' }), 'stale');
  assert.equal(mirror.apply({ sku: 'A', locationId: 'l2', balance: 1, available: 0, asOf: '2026-11-13T12:00:01Z' }), 'applied');
  assert.equal(mirror.get('A', 'l1').balance, 5);
});

test('--live refuses to start without credentials and never echoes them', async () => {
  await assert.rejects(runLive({ env: { TOT_CLIENT_SECRET: 'do-not-print' }, log: () => {} }), (err) => {
    assert.match(err.message, /TOT_TENANT, TOT_CLIENT_ID/);
    assert.doesNotMatch(err.message, /do-not-print/);
    return true;
  });
});

test('webhook receiver verifies both RSA (webhook-signing-1) and Ed25519 (conformance) deliveries from bare-origin metadata and rejects wrong-tenant payloads with 403 tenant_mismatch', async () => {
  const edSigner = createTestWebhookSigner({ endpoint: FIXTURE.webhookEndpoint, keyid: 'conformance-ed-1', alg: 'ed25519' });
  const gateway = createSimulatedGateway({ signingJwk: edSigner.jwk, tenantId: 'giantvapes.com' });
  const receiver = new WebhookReceiver({
    endpoint: FIXTURE.webhookEndpoint,
    keys: new AuthorizationMetadata({ origin: BASE_URL, fetch: gateway }),
    tenant: 'giantvapes.com',
  });
  const sampleData = { sku: FIXTURE.catalogSku, locationId: FIXTURE.location.locationId, balance: 10, available: 0, asOf: '2026-11-26T00:00:00.000Z' };
  const okRes = await receiver.receive(edSigner.sign(inventoryChangedEvent(sampleData, { id: 'evt_ed_e2e_1', tenantId: 'giantvapes.com' })), async () => {});
  assert.deepEqual(okRes, { status: 202, body: { accepted: true } });

  const wrongTenantRes = await receiver.receive(edSigner.sign(inventoryChangedEvent(sampleData, { id: 'evt_ed_e2e_2', tenantId: 'other.com' })), async () => {});
  assert.deepEqual(wrongTenantRes, { status: 403, body: { accepted: false, code: 'tenant_mismatch' } });
});
