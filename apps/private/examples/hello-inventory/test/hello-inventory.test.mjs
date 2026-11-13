import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIdempotencyKey, createHelloInventoryClient, createSimulatedHelloGateway, runSelfTest } from '../index.mjs';

test('hello-inventory manifest requests least-privilege starter scopes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../tot-app.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contractVersion, '1');
  assert.deepEqual(manifest.scopes, [
    'catalog:read',
    'inventory:read',
    'inventory:write',
    'orders:read:minimal',
  ]);
});

test('hello-inventory self-test exercises location upsert, stock read/write, idempotent replay, and synthetic preview orders', async () => {
  const result = await runSelfTest();
  assert.equal(result.ok, true);
  assert.equal(result.locationId, 'loc-main-warehouse');
  assert.equal(result.balance, 25);
  assert.match(result.previewOrderId, /^ord_preview_/);
});

test('reusing an Idempotency-Key with a different movement delta returns 409 idempotency-conflict', async () => {
  const client = createHelloInventoryClient({
    baseUrl: 'https://tot-preview.tokenoftrust.store',
    clientId: 'sim-client',
    clientSecret: 'sim-secret',
    adminBearer: 'sim-admin-secret',
    tenantId: 'acme',
    fetchImpl: createSimulatedHelloGateway(),
  });
  await client.upsertLocation('loc-main-warehouse', { name: 'Main Warehouse', kind: 'warehouse' });
  const key = buildIdempotencyKey('hello-inv', { sku: 'GEN-TEE-BLK-M', quantityDelta: 5 });
  const first = await client.postMovement({ sku: 'GEN-TEE-BLK-M', locationId: 'loc-main-warehouse', quantityDelta: 5, reason: 'adjustment' }, key);
  assert.equal(first.status, 201);

  const conflict = await client.postMovement({ sku: 'GEN-TEE-BLK-M', locationId: 'loc-main-warehouse', quantityDelta: -3, reason: 'adjustment' }, key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'idempotency-conflict');
});
