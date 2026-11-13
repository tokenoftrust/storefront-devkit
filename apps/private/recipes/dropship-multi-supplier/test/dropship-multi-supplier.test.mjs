import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeExceptionCode,
  planStone2MultiVendorSplit,
  runSelfTest,
} from '../index.mjs';

test('dropship-multi-supplier manifest requests fulfillment, recipient, orders, and inventory scopes', () => {
  const manifest = JSON.parse(readFileSync(new URL('../tot-app.json', import.meta.url), 'utf8'));
  assert.equal(manifest.contractVersion, '1');
  assert.deepEqual(manifest.scopes, [
    'orders:read:minimal',
    'orders:read:recipient',
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
