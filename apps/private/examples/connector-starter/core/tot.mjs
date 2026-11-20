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
 * @param {object} cfg from loadConfig()
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] for tests
 * @param {{ claim, release }} [options.seenEvents] webhook replay guard; pass seenEventsFrom(store) to survive restarts
 */
export function createTot(cfg, { fetch: fetchImpl, seenEvents = new MemorySeenEventStore() } = {}) {
  if (cfg.missing.length) throw new Error(`missing in ${cfg.envPath}: ${cfg.missing.join(', ')} (run: npm run doctor -- ${cfg.app})`);
  const io = fetchImpl ? { fetch: fetchImpl } : {};
  // A test install answers under https://storefront.tokenoftrust.store/<tenant>/api/apps/...;
  // connector-kit 1.1.0 routes the token request and every API call there from the `tenant` option.
  const auth = new ConnectorAuthClient({ origin: cfg.host, tenant: cfg.tenant, clientId: cfg.clientId, clientSecret: cfg.clientSecret, ...io });
  const api = new ApiClient({ origin: cfg.host, tenant: cfg.tenant, auth, ...io });
  // Webhook signing keys are published once for the whole host (not per tenant):
  // https://storefront.tokenoftrust.store/.well-known/tot-app-authorization-metadata -> webhook_signing_keys
  const keys = new AuthorizationMetadata({ origin: cfg.host, ...io });

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

  function receiver() {
    if (!cfg.webhookEndpoint) throw new Error('WEBHOOK_PUBLIC_URL is not set (see README "Tunnel")');
    return new WebhookReceiver({ endpoint: cfg.webhookEndpoint, keys, seenEvents });
  }

  return { auth, api, call, keys, receiver };
}
