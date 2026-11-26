// Storefront clients for one app install: token, /api/apps/v1 calls, webhook verification.
// All three come from the vendored connector-kit (vendor/connector-kit, do not edit).
import { ApiClient, ApiError, AuthorizationMetadata, ConnectorAuthClient, MemorySeenEventStore, WebhookReceiver } from '../vendor/connector-kit/index.js';

/** The refusal fields to branch on and log. Never a message, a body or a credential. */
export function refusalBody(err) {
  const body = { code: err.code };
  for (const key of ['holds', 'field', 'index', 'reasons']) if (err[key] !== undefined) body[key] = err[key];
  return body;
}

/**
 * In-process mock Storefront `/api/apps/v1` backend used when running offline
 * conformance certification (`MOCK_STOREFRONT=1` or `TOT_METADATA_ORIGIN` set
 * without live store credentials) while vendor sandbox credentials are sourced.
 */
export function createMockStorefront({ skus = ['SKU-CONFORMANCE-1', 'SKU-CONFORMANCE-2', 'SKU-CONFORMANCE-3'], assignments = [] } = {}) {
  const writes = [];
  const replays = new Map();
  const balances = new Map(skus.map((sku, idx) => [`${sku}|default`, 20 + idx * 5]));
  const state = { assignments: [...assignments], writes, balances, skus };
  const ok = (status, body) => ({ ok: true, status, body, requestId: `req_mock_${writes.length}` });
  const refuse = (status, body) => ({ ok: false, status, body, requestId: `req_mock_${writes.length}` });
  const bal = (sku, loc) => balances.get(`${sku}|${loc}`) ?? 0;

  async function call(method, path, { body, idempotencyKey, query } = {}) {
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
    if (method === 'GET' && rec) {
      return ok(200, { orderId: decodeURIComponent(rec[1]), name: 'Conformance Recipient', line1: '100 Conformance Way', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' });
    }
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
    if (method === 'GET' && path === '/inventory') {
      const limit = Number(query?.limit || state.skus.length);
      return ok(200, {
        items: state.skus.slice(0, limit).map((sku, idx) => ({
          sku,
          available: true,
          quantity: 20 + idx * 5,
          policy: 'deny',
        })),
      });
    }
    const loc = /^\/inventory\/locations\/([^/]+)$/.exec(path);
    if (method === 'PUT' && loc) {
      writes.push({ kind: 'location', path, body });
      return ok(200, { locationId: decodeURIComponent(loc[1]), ...body, updatedAt: new Date().toISOString() });
    }
    if (method === 'POST' && path === '/inventory/movements') {
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
      return ok(200, {
        reports: [
          {
            id: 'sales-velocity',
            generatedAt: new Date().toISOString(),
            window: { days: query?.windowDays ?? 30, from: '2026-10-22T00:00:00Z', to: '2026-11-21T00:00:00Z' },
            skus: state.skus.map((sku) => ({ sku, soldUnits: 6, unsoldUnits: 30, velocityPerDay: 0.2, daysOfCover: 150 })),
          },
        ],
      });
    }
    return refuse(404, { code: 'not_found' });
  }

  return { call, ...state };
}

/**
 * @param {object} cfg from loadConfig()
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] for tests
 * @param {{ claim, release }} [options.seenEvents] webhook replay guard; pass seenEventsFrom(store) to survive restarts
 * @param {string} [options.tenant] optional expected tenantid for WebhookReceiver tenant boundary enforcement
 * @param {string} [options.appInstallId] optional expected appinstallid for WebhookReceiver boundary enforcement
 */
export function createTot(cfg, { fetch: fetchImpl, seenEvents = new MemorySeenEventStore(), tenant, appInstallId } = {}) {
  const io = fetchImpl ? { fetch: fetchImpl } : {};
  // Webhook signing keys are published once for the whole host (not per tenant):
  // https://storefront.tokenoftrust.store/.well-known/tot-app-authorization-metadata -> webhook_signing_keys
  const keys = new AuthorizationMetadata({ origin: cfg.metadataOrigin ?? cfg.host, ...io });

  function receiver(receiverOverrides = {}) {
    if (!cfg.webhookEndpoint) throw new Error('WEBHOOK_PUBLIC_URL is not set (see README "Tunnel")');
    return new WebhookReceiver({
      endpoint: cfg.webhookEndpoint,
      keys,
      seenEvents,
      ...(tenant ? { tenant } : {}),
      ...(appInstallId ? { appInstallId } : {}),
      ...receiverOverrides,
    });
  }

  if (cfg.mockStorefront) {
    const mock = createMockStorefront();
    return { auth: null, api: null, call: mock.call, keys, receiver, mock };
  }

  if (cfg.missing.length) throw new Error(`missing in ${cfg.envPath}: ${cfg.missing.join(', ')} (run: npm run doctor -- ${cfg.app})`);
  // A test install answers under https://storefront.tokenoftrust.store/<tenant>/api/apps/...;
  // connector-kit 1.1.0 routes the token request and every API call there from the `tenant` option.
  const auth = new ConnectorAuthClient({ origin: cfg.host, tenant: cfg.tenant, clientId: cfg.clientId, clientSecret: cfg.clientSecret, ...io });
  const api = new ApiClient({ origin: cfg.host, tenant: cfg.tenant, auth, ...io });

  /**
   * call('GET', '/fulfillment/assignments') -> { ok, status, body, requestId }.
   * Never throws for an API refusal: branch on body.code (e.g. 'carrier-prohibited');
   * body also carries holds / field / index / reasons when Storefront names them.
   */
  async function call(method, path, { query, body, idempotencyKey } = {}) {
    try {
      const res = await api.request({ method, path, query, body, idempotencyKey });
      return { ok: true, status: res.status, body: res.body, requestId: res.requestId };
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, status: err.status, body: refusalBody(err), requestId: err.requestId };
      throw err;
    }
  }

  return { auth, api, call, keys, receiver };
}
