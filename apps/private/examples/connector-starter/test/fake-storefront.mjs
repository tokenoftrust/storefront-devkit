// Test double for core/tot.mjs `tot.call` (Storefront /api/apps/v1), shaped after contract 1.4.0.
// Records every write so tests can count side effects. Offline; no credentials.
export function createFakeStorefront({ assignments = [], catalogSkus = null, failNext = {} } = {}) {
  const writes = [];
  const replays = new Map(); // idempotency key -> response
  const balances = new Map();
  const state = { assignments, writes, balances, failNext };
  const ok = (status, body) => ({ ok: true, status, body, requestId: `req_fake_${writes.length}` });
  const refuse = (status, body) => ({ ok: false, status, body, requestId: `req_fake_${writes.length}` });
  const bal = (sku, loc) => balances.get(`${sku}|${loc}`) ?? 0;

  async function call(method, path, { body, idempotencyKey, query } = {}) {
    if (failNext[path] > 0) {
      failNext[path]--;
      return refuse(503, { code: 'unavailable' });
    }
    if (idempotencyKey && replays.has(idempotencyKey)) return replays.get(idempotencyKey);
    const remember = (res) => {
      if (idempotencyKey && res.ok) replays.set(idempotencyKey, res);
      return res;
    };

    if (method === 'GET' && path === '/fulfillment/carriers') {
      return ok(200, {
        carriers: [
          { code: 'UPS', name: 'UPS', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.ups.com'] },
          { code: 'FEDEX', name: 'FedEx', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.fedex.com'] },
          { code: 'USPS', name: 'USPS', region: 'US', pactEligible: false, adultSignature: 'unsupported', trackingHosts: ['tools.usps.com'] },
        ],
        allowedCarriers: ['UPS', 'FEDEX'],
        pactEnabled: true,
        adultSignatureRequired: true,
      });
    }
    if (method === 'GET' && path === '/fulfillment/assignments') return ok(200, { assignments: state.assignments });
    const rec = /^\/fulfillment\/orders\/([^/]+)\/recipient$/.exec(path);
    if (method === 'GET' && rec) return ok(200, { orderId: decodeURIComponent(rec[1]), name: 'A Person', line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' });

    const ev = /^\/fulfillment\/orders\/([^/]+)\/shipment-evidence$/.exec(path);
    if (method === 'POST' && ev) {
      writes.push({ kind: body.kind, path, body, idempotencyKey });
      if (body.kind === 'label-voided') return remember(ok(200, { label: 'none', purchaseId: `${body.purchaseId}-2` }));
      return remember(ok(200, { label: body.kind === 'label-outcome' ? 'purchased' : undefined, handoff: body.kind === 'handoff' ? 'handed_off' : undefined }));
    }
    const sh = /^\/fulfillment\/assignments\/([^/]+)\/(shipments|exceptions)$/.exec(path);
    if (method === 'POST' && sh) {
      writes.push({ kind: sh[2], path, body, idempotencyKey });
      if (sh[2] === 'shipments' && body.carrier === 'USPS') return refuse(409, { code: 'carrier-prohibited' });
      return remember(ok(201, { complete: false }));
    }

    const loc = /^\/inventory\/locations\/([^/]+)$/.exec(path);
    if (method === 'PUT' && loc) {
      writes.push({ kind: 'location', path, body });
      return ok(200, { locationId: decodeURIComponent(loc[1]), ...body, updatedAt: new Date().toISOString() });
    }
    if (method === 'POST' && path === '/inventory/movements') {
      const index = body.items.findIndex((i) => catalogSkus && !catalogSkus.includes(i.sku));
      if (index >= 0) return refuse(422, { code: 'unknown-sku', field: 'sku', index });
      writes.push({ kind: 'movements', body, idempotencyKey });
      for (const i of body.items) balances.set(`${i.sku}|${i.locationId}`, bal(i.sku, i.locationId) + i.quantityDelta);
      return remember(ok(201, { receiptId: `rcpt_${writes.length}`, asOf: new Date().toISOString(), items: body.items.map((i) => ({ ...i, balance: bal(i.sku, i.locationId) })) }));
    }
    if (method === 'PUT' && path === '/inventory/levels') {
      writes.push({ kind: 'levels', body, idempotencyKey });
      const items = body.items.map((i) => {
        const quantityDelta = i.onHand - bal(i.sku, i.locationId);
        balances.set(`${i.sku}|${i.locationId}`, i.onHand);
        return { ...i, quantityDelta, balance: i.onHand };
      });
      return remember(ok(200, { receiptId: `rcpt_${writes.length}`, asOf: new Date().toISOString(), items }));
    }
    if (method === 'GET' && path === '/reports') {
      return ok(200, { reports: [{ id: 'sales-velocity', generatedAt: new Date().toISOString(), window: { days: query?.windowDays ?? 30, from: '2026-10-22T00:00:00Z', to: '2026-11-21T00:00:00Z' }, skus: [{ sku: 'SKU-A', soldUnits: 6, unsoldUnits: 30, velocityPerDay: 0.2, daysOfCover: 150 }] }] });
    }
    return refuse(404, { code: 'not_found' });
  }

  return { call, ...state, count: (kind) => writes.filter((w) => w.kind === kind).length };
}

/** A FulfillmentAssignment as GET /fulfillment/assignments returns it. */
export function assignment(overrides = {}) {
  return {
    assignmentId: 'asg_1',
    orderId: 'ord_1',
    stage: 'preview',
    eventVersion: 3,
    assignedAt: '2026-11-21T00:00:00Z',
    purchaseId: 'pur_1',
    lineItems: [{ sku: 'SKU-A', quantity: 2 }],
    locationId: 'loc-starter-test',
    allowedCarriers: ['UPS', 'FEDEX'],
    adultSignatureRequired: true,
    lines: [{ lineId: 'l1', sku: 'SKU-A', locationId: 'loc-starter-test', quantity: 2, shipped: 0, cancelled: 0, remaining: 2 }],
    ...overrides,
  };
}
