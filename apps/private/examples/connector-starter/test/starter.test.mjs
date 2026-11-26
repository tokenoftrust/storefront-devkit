// Offline checks: no credentials, no network beyond 127.0.0.1 mocks. `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, createSign, createHash, sign as cryptoSign } from 'node:crypto';
import { createServer } from 'node:http';
import { loadConfig } from '../core/config.mjs';
import { createMockStorefront, createTot } from '../core/tot.mjs';
import { log } from '../core/log.mjs';
import { createFileStateStore, createMemoryStateStore, seenEventsFrom } from '../core/state.mjs';
import { startWebhookServer } from '../core/server.mjs';
import { StaticSigningKeys, WebhookReceiver } from '../vendor/connector-kit/index.js';
import { startMockLabelProvider } from '../apps/label-station/mock-label-provider.mjs';
import { createLabelStation, pickCarrier, providerClient as labelProviderClient, stationCarriers } from '../apps/label-station/connector.mjs';
import { startMockDropshipPlatform } from '../apps/dropship/mock-dropship-platform.mjs';
import { createDropship, providerClient as dropshipProviderClient } from '../apps/dropship/connector.mjs';
import { startMockWms } from '../apps/inventory-sync/mock-wms.mjs';
import { createInventorySync, providerClient as wmsProviderClient } from '../apps/inventory-sync/connector.mjs';
import { cliArgs } from '../scripts/test-order.mjs';
import { candidateArgs } from '../scripts/stage-candidate.mjs';
import { assignment, createFakeStorefront } from './fake-storefront.mjs';

const quiet = () => {};
const tmpState = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'starter-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.json');
};
const baseOf = (server) => `http://127.0.0.1:${server.address().port}`;

function signer(endpoint) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  return {
    keys: new StaticSigningKeys({ keys: [jwk] }),
    sign(event) {
      const body = JSON.stringify(event);
      const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
      const params = `("@method" "@target-uri" "content-digest");created=${Math.floor(Date.now() / 1000)};keyid="test-key";alg="rsa-v1_5-sha256"`;
      const base = `"@method": POST\n"@target-uri": ${endpoint}\n"content-digest": ${digest}\n"@signature-params": ${params}`;
      const sig = createSign('sha256').update(base).sign(privateKey, 'base64');
      return { headers: { 'content-type': 'application/json', 'content-digest': digest, 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` }, body };
    },
  };
}
const cloudEvent = (topic, id, data) => ({ specversion: '1.0', id, source: '/tenants/example.com/storefront', type: `com.tokenoftrust.storefront.${topic}`, time: new Date().toISOString(), datacontenttype: 'application/json', dataschemaversion: '1', retrycount: 0, tenantid: 'example.com', appinstallid: 'inst-1', data });

// ---------- core ----------

test('createTot routes token and API calls under /<tenant> and keeps ApiError field/index/holds/reasons', async () => {
  const seen = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    seen.push(url.pathname);
    if (url.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 't', token_type: 'Bearer', expires_in: 300, scope: 'inventory:write' });
    return Response.json({ code: 'unknown-sku', error: 'unknown-sku', field: 'sku', index: 1 }, { status: 422, headers: { 'tot-request-id': 'req_1' } });
  };
  const cfg = { app: 'inventory-sync', missing: [], host: 'https://storefront.tokenoftrust.store', tenant: 'example.com', clientId: 'c', clientSecret: 's', envPath: '.env' };
  const tot = createTot(cfg, { fetch: fetchImpl });
  const r = await tot.call('POST', '/inventory/movements', { body: { items: [{ sku: 'A', quantityDelta: 1, reason: 'received' }, { sku: 'X', quantityDelta: 1, reason: 'received' }] } });
  assert.deepEqual(seen, ['/example.com/api/apps/oauth/token', '/example.com/api/apps/v1/inventory/movements']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.body, { code: 'unknown-sku', field: 'sku', index: 1 });
  assert.equal(r.requestId, 'req_1');
});

test('file StateStore survives a restart; entries() filters by prefix; seen events persist', async (t) => {
  const path = tmpState(t);
  const a = createFileStateStore(path);
  await a.set('assign:1', { stage: 'labelled' });
  await a.set('wms:cursor', 7);
  assert.ok(await seenEventsFrom(a).claim('example.com/evt-1', 60));
  const b = createFileStateStore(path); // "restarted process"
  assert.deepEqual(await b.get('assign:1'), { stage: 'labelled' });
  assert.deepEqual((await b.entries('assign:')).map(([k]) => k), ['assign:1']);
  assert.equal(await seenEventsFrom(b).claim('example.com/evt-1', 60), false, 'duplicate after restart');
  await b.delete('wms:cursor');
  assert.equal(await createFileStateStore(path).get('wms:cursor'), undefined);
  assert.match(readFileSync(path, 'utf8'), /assign:1/);
});

test('logs never contain recipient address fields or secrets', () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    log('x', { orderId: 'o1', recipient: { name: 'A Person', line1: '1 Main St' }, nested: { postalCode: '90210' }, clientSecret: 's3cr3t' });
  } finally {
    console.log = orig;
  }
  assert.doesNotMatch(lines[0], /A Person|1 Main St|90210|s3cr3t/);
  assert.match(lines[0], /o1/);
});

test('every manifest has the scopes its webhooks and reads need', () => {
  for (const app of ['label-station', 'dropship', 'inventory-sync']) {
    const m = JSON.parse(readFileSync(new URL(`../apps/${app}/tot-app.json`, import.meta.url)));
    const topics = m.webhooks?.topics ?? [];
    if (topics.some((t) => t.startsWith('order.'))) assert.ok(m.scopes.includes('orders:webhook'), `${app}: order.* needs orders:webhook`);
    if (topics.some((t) => t.startsWith('fulfillment.'))) assert.ok(m.scopes.includes('fulfillment:process'), `${app}: fulfillment.* needs fulfillment:process`);
    if (topics.includes('inventory.changed')) assert.ok(m.scopes.includes('inventory:read'), `${app}: inventory.changed needs inventory:read`);
    if (topics.includes('fulfillment.assignment.created')) assert.ok(topics.includes('fulfillment.assignment.updated'), `${app}: subscribe to holds and cancels`);
  }
  const inv = JSON.parse(readFileSync(new URL('../apps/inventory-sync/tot-app.json', import.meta.url)));
  assert.ok(inv.scopes.includes('reports:read'), 'inventory-sync reads GET /reports');
});

test('webhook server: signed delivery reaches the handler once; a redelivered id answers 200 duplicate, even after a restart', async (t) => {
  const endpoint = 'https://tunnel.example/webhooks';
  const s = signer(endpoint);
  const path = tmpState(t);
  const seenData = [];
  const start = async () => {
    const store = createFileStateStore(path);
    const tot = { receiver: () => new WebhookReceiver({ endpoint, keys: s.keys, seenEvents: seenEventsFrom(store) }) };
    const server = startWebhookServer({ cfg: { app: 'inventory-sync', port: 0, webhookEndpoint: endpoint }, tot, handlers: { 'inventory.changed': async (e) => seenData.push(e.data) } });
    await new Promise((r) => server.once('listening', r));
    return server;
  };
  const delivery = s.sign(cloudEvent('inventory.changed', 'evt-9', { sku: 'A', locationId: 'l', balance: 1, available: 0, asOf: '2026-11-21T00:00:00Z' }));
  const post = (server, d) => fetch(`${baseOf(server)}/webhooks`, { method: 'POST', headers: d.headers, body: d.body });

  const orig = console.log;
  console.log = quiet;
  try {
    let server = await start();
    const first = await post(server, delivery);
    assert.equal(first.status, 202);
    const dup = await post(server, delivery);
    assert.equal(dup.status, 200);
    assert.deepEqual(await dup.json(), { accepted: true, duplicate: true });
    server.close();
    server = await start(); // restart
    const afterRestart = await post(server, delivery);
    assert.deepEqual([afterRestart.status, await afterRestart.json()], [200, { accepted: true, duplicate: true }]);
    const tampered = await post(server, { ...delivery, body: delivery.body.replace('"balance":1', '"balance":9') });
    assert.equal(tampered.status, 400);
    server.close();
  } finally {
    console.log = orig;
  }
  assert.equal(seenData.length, 1);
});

// ---------- scripts ----------

test('npm run order: bind/create use your location and 2 units; hold and cancel need an order id', () => {
  const cfg = { installId: 'inst-1', locationId: 'loc-starter-label-station' };
  assert.deepEqual(cliArgs('bind', cfg), ['app', 'test-order', 'bind', 'inst-1', '--location', 'loc-starter-label-station']);
  assert.deepEqual(cliArgs('create', cfg), ['app', 'test-order', 'create', '--location', 'loc-starter-label-station', '--quantity', '2']);
  assert.deepEqual(cliArgs('hold', cfg, 'ord_1'), ['app', 'test-order', 'hold', 'ord_1']);
  assert.deepEqual(cliArgs('cancel', cfg, 'ord_1'), ['app', 'test-order', 'cancel', 'ord_1']);
  assert.throws(() => cliArgs('cancel', cfg), /needs an orderId/);
});

test('stage-candidate wraps tot app candidate --app apps/<app> --jwks <file> --request-consent', () => {
  assert.deepEqual(candidateArgs('dropship', ['--jwks', 'keys/public-jwks.json'], 'example.com'), ['app', 'candidate', '--app', 'apps/dropship', '--jwks', 'keys/public-jwks.json', '--request-consent', '--tenant', 'example.com']);
  assert.deepEqual(candidateArgs('label-station', ['--generate-keys', './keys'], 'example.com').slice(4, 6), ['--generate-keys', './keys']);
  assert.throws(() => candidateArgs('dropship', [], 'example.com'), /--jwks/);
  assert.throws(() => candidateArgs('nope', ['--jwks', 'x'], 'example.com'), /usage/);
});

// ---------- label station ----------

test('label station carriers = provider ∩ tenant allowed ∩ STATION_CARRIERS; the order picks in its own order', () => {
  const catalog = {
    carriers: [
      { code: 'UPS', trackingHosts: ['www.ups.com'] },
      { code: 'FEDEX', trackingHosts: ['www.fedex.com'] },
      { code: 'USPS', trackingHosts: ['tools.usps.com'] },
    ],
    allowedCarriers: ['UPS', 'FEDEX'],
  };
  const providerCarriers = [
    { code: 'ups', services: ['ups_2nd_day_air', 'ups_ground'] },
    { code: 'fedex', services: ['fedex_ground'] },
    { code: 'stamps_com', services: ['usps_ground_advantage'] },
  ];
  const all = stationCarriers({ catalog, providerCarriers });
  assert.deepEqual([...all.keys()], ['UPS', 'FEDEX'], 'USPS is not allowed on this tenant');
  assert.equal(all.get('UPS').serviceCode, 'ups_ground');
  assert.equal(all.get('UPS').service, 'GROUND');
  assert.deepEqual([...stationCarriers({ catalog, providerCarriers, configured: ['FEDEX'] }).keys()], ['FEDEX']);
  assert.equal(pickCarrier(['FEDEX', 'UPS'], all)[0], 'FEDEX');
  assert.equal(pickCarrier(['USPS'], all), null);
});

async function labelHarness(t, { storePath, sf, server } = {}) {
  const shipped = [];
  const mock = server ?? (await startMockLabelProvider({ port: 0, onShipNotify: (s) => shipped.push(s) }));
  if (!server) t.after(() => mock.close());
  const fake = sf ?? createFakeStorefront({ assignments: [assignment()] });
  const store = storePath ? createFileStateStore(storePath) : createMemoryStateStore();
  const station = createLabelStation({ tot: fake, provider: labelProviderClient(baseOf(mock)), store, log: quiet });
  await station.discoverCarriers();
  return { mock, fake, store, station, shipped };
}

test('label station mock provider: order upsert, label, hold blocks label and pickup, cancel', async (t) => {
  const server = await startMockLabelProvider({ port: 0 });
  t.after(() => server.close());
  const provider = labelProviderClient(baseOf(server));
  const order = await provider('POST', '/orders/createorder', { orderNumber: 'o-1', items: [{ sku: 'A', quantity: 1 }], shipTo: { name: 'x' } });
  assert.equal((await provider('POST', '/orders/createorder', { orderNumber: 'o-1', items: [], shipTo: {} })).orderId, order.orderId, 'createorder upserts by orderNumber');
  const label = await provider('POST', '/orders/createlabelfororder', { orderId: order.orderId, carrierCode: 'ups', serviceCode: 'ups_ground' });
  assert.match(label.trackingNumber, /^1Z[A-Z0-9]{16}$/);
  await provider('POST', '/orders/holduntil', { orderId: order.orderId });
  await assert.rejects(provider('POST', '/orders/createlabelfororder', { orderId: order.orderId, carrierCode: 'ups', serviceCode: 'ups_ground' }), /409/);
  await assert.rejects(provider('POST', `/_mock/pickup/${label.shipmentId}`), /409/);
  await provider('POST', '/orders/cancel', { orderId: order.orderId });
  await assert.rejects(provider('POST', '/orders/restorefromhold', { orderId: order.orderId }), /409/);
});

test('label station: label-outcome then handoff; a restart never buys a second label', async (t) => {
  const storePath = tmpState(t);
  const first = await labelHarness(t, { storePath });
  await first.station.processAssignment(assignment());
  const label = first.fake.writes.find((w) => w.kind === 'label-outcome').body;
  assert.equal(label.carrier, 'UPS');
  assert.equal(label.service, 'GROUND');
  assert.equal(label.adultSignature, 'accepted');
  assert.match(label.trackingUrl, /^https:\/\/www\.ups\.com\//);
  await first.station.onShipNotify({ shipmentId: (await first.store.get('assign:asg_1')).shipment.shipmentId });
  assert.equal(first.fake.count('handoff'), 1);

  // Restart with the same state file: reconcile sees the same assignment, nothing is bought again.
  const second = await labelHarness(t, { storePath, sf: first.fake, server: first.mock });
  await second.station.reconcile('startup');
  assert.equal(first.mock.orders.size, 1);
  assert.equal(first.fake.count('label-outcome'), 1);
});

test('label station: crash after buying the label but before Storefront heard of it resumes without a second label', async (t) => {
  const storePath = tmpState(t);
  const fake = createFakeStorefront({ assignments: [assignment()], failNext: { '/fulfillment/orders/ord_1/shipment-evidence': 4 } });
  const first = await labelHarness(t, { storePath, sf: fake });
  await first.station.processAssignment(assignment()); // provider label bought, evidence refused (503 x retries)
  assert.equal((await first.store.get('assign:asg_1')).stage, 'label_bought');
  fake.failNext['/fulfillment/orders/ord_1/shipment-evidence'] = 0;

  const second = await labelHarness(t, { storePath, sf: fake, server: first.mock });
  await second.station.processAssignment(assignment());
  assert.equal((await second.store.get('assign:asg_1')).stage, 'labelled');
  assert.equal([...first.mock.orders.values()].length, 1);
  assert.equal(fake.count('label-outcome'), 1);
});

test('label station: held pauses (no handoff), a stale update is ignored, active resumes, cancelled voids and cancels', async (t) => {
  const h = await labelHarness(t);
  await h.station.processAssignment(assignment());
  const w = await h.store.get('assign:asg_1');
  await h.station.onAssignmentUpdated({ assignmentId: 'asg_1', orderId: 'ord_1', stage: 'preview', state: 'held', eventVersion: 5, occurredAt: 'x' });
  assert.equal(h.mock.orders.get(w.providerOrderId).orderStatus, 'on_hold');
  await h.station.onShipNotify({ shipmentId: w.shipment.shipmentId });
  assert.equal(h.fake.count('handoff'), 0, 'no handoff while held');

  await h.station.onAssignmentUpdated({ assignmentId: 'asg_1', orderId: 'ord_1', stage: 'preview', state: 'active', eventVersion: 4, occurredAt: 'x' });
  assert.equal((await h.store.get('assign:asg_1')).state, 'held', 'an older eventVersion never wins');

  h.fake.assignments.length = 0; // held/cancelled assignments are absent from the read
  await h.station.onAssignmentUpdated({ assignmentId: 'asg_1', orderId: 'ord_1', stage: 'preview', state: 'active', eventVersion: 6, occurredAt: 'x' });
  assert.equal(h.mock.orders.get(w.providerOrderId).orderStatus, 'awaiting_shipment');

  await h.station.onAssignmentUpdated({ assignmentId: 'asg_1', orderId: 'ord_1', stage: 'preview', state: 'cancelled', eventVersion: 7, occurredAt: 'x' });
  const after = await h.store.get('assign:asg_1');
  assert.equal(after.state, 'cancelled');
  assert.equal(after.shipment.voided, true);
  assert.equal(h.mock.orders.get(w.providerOrderId).orderStatus, 'cancelled');
  const writesBefore = h.fake.writes.length;
  await h.station.onShipNotify({ shipmentId: w.shipment.shipmentId });
  assert.equal(h.fake.writes.length, writesBefore, 'nothing is reported after cancel');
});

test('label station: an order whose carriers this station cannot buy is not labelled', async (t) => {
  const h = await labelHarness(t);
  await h.station.processAssignment(assignment({ assignmentId: 'asg_usps', allowedCarriers: ['USPS'] }));
  assert.equal(h.mock.orders.size, 0);
  assert.equal(h.fake.count('label-outcome'), 0);
});

// ---------- dropship ----------

async function dropshipHarness(t, { storePath, sf, server } = {}) {
  const mock = server ?? (await startMockDropshipPlatform({ port: 0, shipSeconds: 0 }));
  if (!server) t.after(() => mock.close());
  const fake = sf ?? createFakeStorefront({ assignments: [assignment()] });
  const store = storePath ? createFileStateStore(storePath) : createMemoryStateStore();
  return { mock, fake, store, dropship: createDropship({ tot: fake, provider: dropshipProviderClient(baseOf(mock)), store, log: quiet }) };
}

test('dropship: two cartons reported once each; a restart creates no second purchase order and re-reports nothing', async (t) => {
  const storePath = tmpState(t);
  const h = await dropshipHarness(t, { storePath });
  await h.dropship.startAssignment(assignment());
  const { poId } = await h.store.get('assign:asg_1');
  h.mock.supplierActs(poId);
  await h.dropship.reconcile('poll');
  assert.equal(h.fake.count('shipments'), 2);

  const again = await dropshipHarness(t, { storePath, sf: h.fake, server: h.mock });
  await again.dropship.reconcile('startup');
  assert.equal(h.mock.purchaseOrders.size, 1);
  assert.equal(h.fake.count('shipments'), 2);
});

test('dropship: held stops reporting and holds the PO, active resumes it, cancelled cancels unshipped cartons', async (t) => {
  const h = await dropshipHarness(t);
  await h.dropship.startAssignment(assignment());
  const { poId } = await h.store.get('assign:asg_1');
  await h.dropship.onAssignmentUpdated({ assignmentId: 'asg_1', orderId: 'ord_1', stage: 'preview', state: 'held', eventVersion: 5, occurredAt: 'x' });
  assert.equal(h.mock.purchaseOrders.get(poId).status, 'on_hold');
  h.mock.supplierActs(poId); // supplier tries to ship while held
  h.fake.assignments.length = 0;
  await h.dropship.reconcile('poll');
  assert.equal(h.fake.count('shipments'), 0);
  assert.ok(await h.store.get('assign:asg_1'), 'a held assignment is kept while absent from the read');

  h.fake.assignments.push(assignment());
  await h.dropship.onAssignmentUpdated({ assignmentId: 'asg_1', orderId: 'ord_1', stage: 'preview', state: 'active', eventVersion: 6, occurredAt: 'x' });
  assert.equal(h.fake.count('shipments'), 2, 'held cartons ship after resume');

  const c = await dropshipHarness(t);
  await c.dropship.startAssignment(assignment({ assignmentId: 'asg_2', orderId: 'ord_2' }));
  const po2 = (await c.store.get('assign:asg_2')).poId;
  await c.dropship.onAssignmentUpdated({ assignmentId: 'asg_2', orderId: 'ord_2', stage: 'preview', state: 'cancelled', eventVersion: 9, occurredAt: 'x' });
  c.mock.supplierActs(po2);
  assert.equal(c.mock.purchaseOrders.get(po2).status, 'cancelled');
  assert.equal(c.mock.purchaseOrders.get(po2).shipments.length, 0);
  await c.dropship.syncPurchaseOrder('asg_2', await c.store.get('assign:asg_2'));
  assert.equal(c.fake.count('shipments'), 0);
});

test('dropship: a poll that runs before the held webhook keeps the record, so the late webhook still holds the PO', async (t) => {
  const h = await dropshipHarness(t);
  await h.dropship.startAssignment(assignment());
  const { poId } = await h.store.get('assign:asg_1');
  h.fake.assignments.length = 0; // held in Storefront: absent from the read, webhook not delivered yet
  await h.dropship.reconcile('poll');
  assert.ok(await h.store.get('assign:asg_1'), 'absence alone does not close the record');
  await h.dropship.onAssignmentUpdated({ assignmentId: 'asg_1', orderId: 'ord_1', stage: 'preview', state: 'held', eventVersion: 5, occurredAt: 'x' });
  assert.equal(h.mock.purchaseOrders.get(poId).status, 'on_hold');
});

test('dropship: a record is forgotten once every carton is reported, or when Storefront answers assignment-ended', async (t) => {
  const h = await dropshipHarness(t);
  await h.dropship.startAssignment(assignment());
  h.mock.supplierActs((await h.store.get('assign:asg_1')).poId);
  await h.dropship.reconcile('poll'); // still listed: both cartons reported, record kept
  assert.equal(h.fake.count('shipments'), 2);
  assert.ok(await h.store.get('assign:asg_1'));
  h.fake.assignments.length = 0; // fully shipped: no longer listed
  await h.dropship.reconcile('poll');
  assert.equal(await h.store.get('assign:asg_1'), undefined);

  const e = await dropshipHarness(t, { sf: createFakeStorefront({ assignments: [assignment()], ended: new Set(['asg_1']) }) });
  await e.dropship.startAssignment(assignment());
  e.mock.supplierActs((await e.store.get('assign:asg_1')).poId);
  e.fake.assignments.length = 0; // released to another processor
  await e.dropship.reconcile('poll');
  assert.equal(e.fake.count('shipments'), 0);
  assert.equal(await e.store.get('assign:asg_1'), undefined, 'assignment-ended closes the record');
});

// ---------- inventory sync ----------

async function invHarness(t, { storePath, sf, server, skus = ['SKU-A', 'SKU-B'] } = {}) {
  const mock = server ?? (await startMockWms({ port: 0, skus, driftSeconds: 0 }));
  if (!server) t.after(() => mock.close());
  const fake = sf ?? createFakeStorefront();
  const store = storePath ? createFileStateStore(storePath) : createMemoryStateStore();
  const sync = createInventorySync({ tot: fake, provider: wmsProviderClient(baseOf(mock)), store, locationId: 'loc-starter-wms', log: quiet });
  return { mock, fake, store, sync, move: (sku, qty, reason) => fetch(`${baseOf(mock)}/_mock/move`, { method: 'POST', body: JSON.stringify({ sku, qty, reason }) }) };
}

test('inventory sync: baseline levels, then reason-coded movement batches, then levels with zero drift; a restart re-sends nothing', async (t) => {
  const storePath = tmpState(t);
  const h = await invHarness(t, { storePath });
  await h.sync.sync('startup');
  assert.equal(h.fake.count('levels'), 1);
  assert.equal(h.fake.count('movements'), 0);
  await h.move('SKU-A', 5, 'RECEIVE');
  await h.move('SKU-A', -1, 'DAMAGE');
  await h.move('SKU-B', -2, 'CYCLE_COUNT');
  await h.move('SKU-B', 1, 'SOMETHING_ELSE');
  await h.sync.sync('poll');
  const batch = h.fake.writes.find((w) => w.kind === 'movements').body.items;
  assert.deepEqual(batch.map((i) => i.reason), ['received', 'damaged', 'cycle_count', 'adjustment']);
  const levels = h.fake.writes.filter((w) => w.kind === 'levels');
  assert.equal(levels.length, 2);
  assert.equal(h.fake.balances.get('SKU-A|loc-starter-wms'), 24);

  const again = await invHarness(t, { storePath, sf: h.fake, server: h.mock });
  await again.sync.sync('startup');
  assert.equal(h.fake.count('movements'), 1, 'the cursor survived the restart');
});

test('inventory sync: a WMS that restarts its numbering never gets an old receipt replayed for a new movement', async (t) => {
  const fake = createFakeStorefront();
  const first = await invHarness(t, { sf: fake });
  await first.sync.sync('startup');
  await first.move('SKU-A', 12, 'RECEIVE'); // WMS seq 1
  await first.sync.sync('poll');
  assert.equal(fake.count('movements'), 1);

  await new Promise((r) => setTimeout(r, 5));
  const second = await invHarness(t, { sf: fake }); // fresh WMS (seq starts at 1 again) and fresh state
  await second.sync.sync('startup');
  await second.move('SKU-A', 12, 'RECEIVE'); // same seq, same content, a different movement
  await second.sync.sync('poll');
  assert.equal(fake.count('movements'), 2, 'the second movement was applied, not answered with the first receipt');
});

test('inventory sync: a 422 names the refused item (index); the app drops it and sends the rest', async (t) => {
  const h = await invHarness(t, { sf: createFakeStorefront({ catalogSkus: ['SKU-A'] }), skus: ['SKU-A', 'SKU-GONE'] });
  await h.sync.sync('startup');
  await h.move('SKU-GONE', 1, 'RECEIVE');
  await h.move('SKU-A', 2, 'RECEIVE');
  await h.sync.sync('poll');
  const sent = h.fake.writes.filter((w) => w.kind === 'movements');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.items.map((i) => i.sku), ['SKU-A']);
});

test('inventory sync: inventory.changed applies only newer asOf per (sku, location), across restarts', async (t) => {
  const storePath = tmpState(t);
  const h = await invHarness(t, { storePath });
  const ev = (asOf, balance) => ({ sku: 'SKU-A', locationId: 'loc-starter-wms', balance, available: 0, asOf });
  assert.equal(await h.sync.onInventoryChanged(ev('2026-11-21T10:00:05Z', 9)), 'applied');
  assert.equal(await h.sync.onInventoryChanged(ev('2026-11-21T10:00:01Z', 7)), 'stale');
  const again = await invHarness(t, { storePath, server: h.mock });
  assert.equal(await again.sync.onInventoryChanged(ev('2026-11-21T10:00:05Z', 9)), 'stale');
  assert.equal(await again.sync.onInventoryChanged({ ...ev('2026-11-21T10:00:02Z', 1), locationId: 'other' }), 'applied');
});

test('inventory sync: GET /reports?windowDays=30 returns velocity rows for the synced SKUs', async (t) => {
  const h = await invHarness(t);
  const rows = await h.sync.report(['SKU-A']);
  assert.deepEqual(rows.map((r) => [r.sku, r.soldUnits, r.daysOfCover]), [['SKU-A', 6, 150]]);
});

test('offline conformance parity: label-station, dropship, and inventory-sync certify cleanly against mock Storefront with Ed25519 and RSA webhook signing and fail closed on invalid signature, expired timestamp, wrong key, and wrong tenant', async (t) => {
  const edPair = generateKeyPairSync('ed25519');
  const rsaPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongEdPair = generateKeyPairSync('ed25519');
  const edJwk = { ...edPair.publicKey.export({ format: 'jwk' }), kid: 'conformance-ed25519-1', alg: 'EdDSA', use: 'sig' };
  const rsaJwk = { ...rsaPair.publicKey.export({ format: 'jwk' }), kid: 'webhook-signing-1', alg: 'RS256', use: 'sig' };

  const metaServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/tot-app-authorization-metadata') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
      res.end(
        JSON.stringify({
          issuer: 'https://storefront.tokenoftrust.store',
          token_endpoint: 'https://storefront.tokenoftrust.store/api/apps/oauth/token',
          webhook_signing_keys: { keys: [edJwk, rsaJwk] },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => metaServer.listen(0, '127.0.0.1', r));
  t.after(() => metaServer.close());
  const metadataOrigin = baseOf(metaServer);

  function signWebhook(endpoint, event, { alg = 'ed25519', keyid = 'conformance-ed25519-1', privateKey = edPair.privateKey, created = Math.floor(Date.now() / 1000) } = {}) {
    const body = JSON.stringify(event);
    const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
    const params = `("@method" "@target-uri" "content-digest");created=${created};keyid="${keyid}";alg="${alg}"`;
    const base = `"@method": POST\n"@target-uri": ${endpoint}\n"content-digest": ${digest}\n"@signature-params": ${params}`;
    const sig =
      alg === 'ed25519'
        ? cryptoSign(null, Buffer.from(base), privateKey).toString('base64')
        : createSign('sha256').update(base).sign(privateKey, 'base64');
    return {
      headers: {
        'content-type': 'application/cloudevents+json',
        'content-digest': digest,
        'signature-input': `sig1=${params}`,
        signature: `sig1=:${sig}:`,
      },
      body,
    };
  }

  const origEnv = { ...process.env };
  const origLog = console.log;
  console.log = quiet;
  try {
    for (const appName of ['label-station', 'dropship', 'inventory-sync']) {
      process.env.TOT_METADATA_ORIGIN = metadataOrigin;
      process.env.MOCK_STOREFRONT = '1';
      delete process.env.TOT_TENANT;
      delete process.env.TOT_INSTALL_ID;
      delete process.env.TOT_CLIENT_ID;
      delete process.env.TOT_CLIENT_SECRET;

      const cfg = loadConfig(appName);
      assert.equal(cfg.mockStorefront, true, `${appName} enables mockStorefront when TOT_METADATA_ORIGIN / MOCK_STOREFRONT is set`);
      cfg.port = 0;
      cfg.webhookPublicUrl = 'https://conformance.example';
      cfg.webhookEndpoint = 'https://conformance.example/webhooks';

      const store = createMemoryStateStore();
      const tot = createTot(cfg, {
        seenEvents: seenEventsFrom(store),
        tenant: 'example.com',
        appInstallId: 'inst-1',
      });
      assert.ok(tot.mock, `${appName} exposes in-process mock Storefront`);

      let handlers;
      if (appName === 'label-station') {
        const mockProvider = await startMockLabelProvider({ port: 0 });
        t.after(() => mockProvider.close());
        const station = createLabelStation({ tot, provider: labelProviderClient(baseOf(mockProvider)), store, log: quiet });
        await station.discoverCarriers();
        assert.deepEqual([...station.carriers.keys()], ['UPS', 'FEDEX']);
        handlers = station.handlers;
      } else if (appName === 'dropship') {
        const mockProvider = await startMockDropshipPlatform({ port: 0, shipSeconds: 0 });
        t.after(() => mockProvider.close());
        const dropship = createDropship({ tot, provider: dropshipProviderClient(baseOf(mockProvider)), store, log: quiet });
        handlers = dropship.handlers;
      } else {
        const sample = await tot.call('GET', '/inventory', { query: { limit: 3 } });
        assert.equal(sample.ok, true);
        const skus = sample.body.items.map((i) => i.sku);
        const mockProvider = await startMockWms({ port: 0, skus, driftSeconds: 0 });
        t.after(() => mockProvider.close());
        const sync = createInventorySync({ tot, provider: wmsProviderClient(baseOf(mockProvider)), store, locationId: cfg.locationId, log: quiet });
        assert.equal(await sync.declareLocation(), true);
        await sync.sync('startup');
        handlers = sync.handlers;
      }

      const server = startWebhookServer({ cfg, tot, handlers });
      await new Promise((r) => server.once('listening', r));
      t.after(() => server.close());
      const url = `${baseOf(server)}/webhooks`;

      const topic = appName === 'inventory-sync' ? 'inventory.changed' : 'fulfillment.assignment.updated';
      const payload =
        appName === 'inventory-sync'
          ? { sku: 'SKU-CONFORMANCE-1', locationId: cfg.locationId, balance: 15, available: 15, asOf: '2026-11-26T00:00:00.000Z' }
          : { assignmentId: 'asg_conf_1', orderId: 'ord_conf_1', stage: 'preview', state: 'held', eventVersion: 2, occurredAt: '2026-11-26T00:00:00.000Z' };

      // 1. Valid Ed25519 delivery (tot app conformance) -> 202
      const edEvent = cloudEvent(topic, `evt-ed-${appName}`, payload);
      const edSigned = signWebhook(cfg.webhookEndpoint, edEvent);
      const resEd = await fetch(url, { method: 'POST', headers: edSigned.headers, body: edSigned.body });
      assert.equal(resEd.status, 202, `${appName} accepts Ed25519 signed delivery`);

      // 2. Duplicate Ed25519 delivery -> 200 duplicate
      const resDup = await fetch(url, { method: 'POST', headers: edSigned.headers, body: edSigned.body });
      assert.equal(resDup.status, 200);
      assert.deepEqual(await resDup.json(), { accepted: true, duplicate: true });

      // 3. Valid RSA delivery (webhook-signing-1) -> 202
      const rsaPayload =
        appName === 'inventory-sync'
          ? { ...payload, asOf: '2026-11-26T00:01:00.000Z', balance: 14 }
          : { ...payload, state: 'cancelled', eventVersion: 3 };
      const rsaEvent = cloudEvent(topic, `evt-rsa-${appName}`, rsaPayload);
      const rsaSigned = signWebhook(cfg.webhookEndpoint, rsaEvent, {
        alg: 'rsa-v1_5-sha256',
        keyid: 'webhook-signing-1',
        privateKey: rsaPair.privateKey,
      });
      const resRsa = await fetch(url, { method: 'POST', headers: rsaSigned.headers, body: rsaSigned.body });
      assert.equal(resRsa.status, 202, `${appName} accepts RSA webhook-signing-1 delivery`);

      // 4. Fail-closed: invalid signature -> 401 signature_invalid
      const badSigEvent = cloudEvent(topic, `evt-badsig-${appName}`, payload);
      const badSigSigned = signWebhook(cfg.webhookEndpoint, badSigEvent);
      const tamperedHeaders = { ...badSigSigned.headers, signature: 'sig1=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==:' };
      const resBadSig = await fetch(url, { method: 'POST', headers: tamperedHeaders, body: badSigSigned.body });
      assert.equal(resBadSig.status, 401);
      assert.equal((await resBadSig.json()).code, 'signature_invalid');

      // 5. Fail-closed: expired timestamp -> 401 signature_expired
      const expiredEvent = cloudEvent(topic, `evt-exp-${appName}`, payload);
      const expiredSigned = signWebhook(cfg.webhookEndpoint, expiredEvent, {
        created: Math.floor(Date.now() / 1000) - 600,
      });
      const resExpired = await fetch(url, { method: 'POST', headers: expiredSigned.headers, body: expiredSigned.body });
      assert.equal(resExpired.status, 401);
      assert.equal((await resExpired.json()).code, 'signature_expired');

      // 6. Fail-closed: wrong key -> 401 signature_invalid / unknown_key
      const wrongKeyEvent = cloudEvent(topic, `evt-wrongkey-${appName}`, payload);
      const wrongKeySigned = signWebhook(cfg.webhookEndpoint, wrongKeyEvent, {
        privateKey: wrongEdPair.privateKey,
      });
      const resWrongKey = await fetch(url, { method: 'POST', headers: wrongKeySigned.headers, body: wrongKeySigned.body });
      assert.equal(resWrongKey.status, 401);
      assert.equal((await resWrongKey.json()).code, 'signature_invalid');

      // 7. Fail-closed: wrong tenant payload -> 403 tenant_mismatch
      const wrongTenantEvent = {
        ...cloudEvent(topic, `evt-wrongtenant-${appName}`, payload),
        tenantid: 'other.example.com',
        source: '/tenants/other.example.com/storefront',
      };
      const wrongTenantSigned = signWebhook(cfg.webhookEndpoint, wrongTenantEvent);
      const resWrongTenant = await fetch(url, { method: 'POST', headers: wrongTenantSigned.headers, body: wrongTenantSigned.body });
      assert.equal(resWrongTenant.status, 403);
      assert.equal((await resWrongTenant.json()).code, 'tenant_mismatch');
    }
  } finally {
    console.log = origLog;
    for (const k of Object.keys(process.env)) if (!(k in origEnv)) delete process.env[k];
    Object.assign(process.env, origEnv);
  }
});
