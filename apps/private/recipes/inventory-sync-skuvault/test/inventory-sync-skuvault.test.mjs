import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyThresholdTransition,
  createSimulatedWmsGateway,
  createSkuVaultWmsConnector,
  runSelfTest,
} from '../index.mjs';

test('inventory-sync-skuvault manifest declares least-privilege WMS scopes and private_key_jwt clientAuth', () => {
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
  const connector = createSkuVaultWmsConnector({
    baseUrl: 'https://tot-preview.tokenoftrust.store',
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
