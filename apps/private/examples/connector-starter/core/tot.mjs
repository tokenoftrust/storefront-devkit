// Storefront clients for one app install: token, /api/apps/v1 calls, webhook verification.
// All three come from the vendored connector-kit (vendor/connector-kit, do not edit).
import { ApiClient, ApiError, AuthorizationMetadata, ConnectorAuthClient, WebhookReceiver } from '../vendor/connector-kit/index.js';

/**
 * WORKAROUND (see KNOWN-ISSUES.md, "connector-kit and the test stage URL").
 * A test install only answers under https://storefront.tokenoftrust.store/<tenant>/api/apps/...,
 * but connector-kit refuses an origin with a path. We give the kit the bare host and add
 * "/<tenant>" to /api/apps/* URLs here. Delete this function once that is fixed.
 */
export function tenantPathFetch(host, tenant, inner = (...a) => globalThis.fetch(...a)) {
  const prefix = `/${encodeURIComponent(tenant)}`;
  return (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin === host && url.pathname.startsWith('/api/apps/')) url.pathname = prefix + url.pathname;
    return inner(url.toString(), init);
  };
}

export function createTot(cfg) {
  if (cfg.missing.length) throw new Error(`missing in ${cfg.envPath}: ${cfg.missing.join(', ')} (run: npm run doctor -- ${cfg.app})`);
  const fetchImpl = tenantPathFetch(cfg.host, cfg.tenant);
  const auth = new ConnectorAuthClient({ origin: cfg.host, clientId: cfg.clientId, clientSecret: cfg.clientSecret, fetch: fetchImpl });
  const api = new ApiClient({ origin: cfg.host, auth, fetch: fetchImpl });
  // Webhook signing keys are published once for the whole host (not per tenant):
  // https://storefront.tokenoftrust.store/.well-known/tot-app-authorization-metadata -> webhook_signing_keys
  const keys = new AuthorizationMetadata({ origin: cfg.host });

  /**
   * call('GET', '/fulfillment/assignments') -> { ok, status, body, requestId }.
   * Never throws for an API refusal: branch on body.code (e.g. 'carrier-prohibited').
   */
  async function call(method, path, { query, body, idempotencyKey } = {}) {
    try {
      const res = await api.request({ method, path, query, body, idempotencyKey });
      return { ok: true, status: res.status, body: res.body, requestId: res.requestId };
    } catch (err) {
      if (err instanceof ApiError) return { ok: false, status: err.status, body: { code: err.code }, requestId: err.requestId };
      throw err;
    }
  }

  function receiver() {
    if (!cfg.webhookEndpoint) throw new Error('WEBHOOK_PUBLIC_URL is not set (see README "Tunnel")');
    return new WebhookReceiver({ endpoint: cfg.webhookEndpoint, keys });
  }

  return { auth, api, call, keys, receiver };
}
