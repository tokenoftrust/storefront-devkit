// Offline checks: no credentials, no network. `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { tenantPathFetch } from '../core/tot.mjs';
import { log } from '../core/log.mjs';
import { StaticSigningKeys, WebhookReceiver } from '../vendor/connector-kit/index.js';
import { startMockLabelProvider } from '../apps/label-station/mock-label-provider.mjs';

test('tenantPathFetch adds /<store> to API calls only', async () => {
  const seen = [];
  const f = tenantPathFetch('https://storefront.tokenoftrust.store', 'example.com', async (url) => (seen.push(url), new Response('{}')));
  await f('https://storefront.tokenoftrust.store/api/apps/v1/fulfillment/assignments');
  await f('https://storefront.tokenoftrust.store/api/apps/oauth/token', { method: 'POST' });
  await f('https://storefront.tokenoftrust.store/.well-known/tot-app-authorization-metadata');
  assert.deepEqual(seen, [
    'https://storefront.tokenoftrust.store/example.com/api/apps/v1/fulfillment/assignments',
    'https://storefront.tokenoftrust.store/example.com/api/apps/oauth/token',
    'https://storefront.tokenoftrust.store/.well-known/tot-app-authorization-metadata',
  ]);
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

test('every manifest has the scopes its webhooks need', () => {
  for (const app of ['label-station', 'dropship', 'inventory-sync']) {
    const m = JSON.parse(readFileSync(new URL(`../apps/${app}/tot-app.json`, import.meta.url)));
    const topics = m.webhooks?.topics ?? [];
    if (topics.some((t) => t.startsWith('order.'))) assert.ok(m.scopes.includes('orders:webhook'), `${app}: order.* needs orders:webhook`);
    if (topics.some((t) => t.startsWith('fulfillment.'))) assert.ok(m.scopes.includes('fulfillment:process'), `${app}: fulfillment.* needs fulfillment:process`);
    if (topics.includes('inventory.changed')) assert.ok(m.scopes.includes('inventory:read'), `${app}: inventory.changed needs inventory:read`);
  }
});

test('webhook receiver accepts a correctly signed delivery and refuses a tampered one', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const endpoint = 'https://tunnel.example/webhooks';
  const receiver = new WebhookReceiver({ endpoint, keys: new StaticSigningKeys({ keys: [jwk] }) });

  const event = { specversion: '1.0', id: 'evt-1', source: '/tenants/example.com/storefront', type: 'com.tokenoftrust.storefront.order.fulfilled', time: new Date().toISOString(), datacontenttype: 'application/json', dataschemaversion: '1', retrycount: 0, tenantid: 'example.com', appinstallid: 'inst-1', data: { id: '1' } };
  const body = JSON.stringify(event);
  const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
  const created = Math.floor(Date.now() / 1000);
  const params = `("@method" "@target-uri" "content-digest");created=${created};keyid="test-key";alg="rsa-v1_5-sha256"`;
  const base = `"@method": POST\n"@target-uri": ${endpoint}\n"content-digest": ${digest}\n"@signature-params": ${params}`;
  const sig = createSign('sha256').update(base).sign(privateKey, 'base64');
  const headers = { 'content-type': 'application/json', 'content-digest': digest, 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` };

  const ok = await receiver.verify({ method: 'POST', headers, body });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const bad = await receiver.verify({ method: 'POST', headers, body: body.replace('"1"', '"2"') });
  assert.equal(bad.ok, false);
});

test('mock label provider: order, label, void, pickup callback', async () => {
  let notified = null;
  const server = await startMockLabelProvider({ port: 0, onShipNotify: (s) => (notified = s) });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
  try {
    const order = await post('/orders/createorder', { orderNumber: 'o-1', items: [{ sku: 'A', quantity: 1 }], shipTo: { name: 'x' } });
    assert.equal((await post('/orders/createorder', { orderNumber: 'o-1', items: [], shipTo: {} })).orderId, order.orderId, 'createorder upserts by orderNumber');
    const label = await post('/orders/createlabelfororder', { orderId: order.orderId, carrierCode: 'ups', serviceCode: 'ups_ground' });
    assert.match(label.trackingNumber, /^1Z[A-Z0-9]{16}$/);
    await post(`/_mock/pickup/${label.shipmentId}`);
    assert.equal(notified?.shipmentId, label.shipmentId);
    assert.equal((await post('/shipments/voidlabel', { shipmentId: label.shipmentId })).approved, true);
  } finally {
    server.close();
  }
});
