// Pull API client: OAuth2 client-credentials token, then the three
// /fulfillment routes under /api/apps/v1. Refusals come back as
// { ok: false, status, code } so callers branch on `code`, never on text.
//
// A remote body is never trusted as text: `code` and `holds` are mapped onto
// the fixed sets the contract publishes (anything else becomes `unexpected`),
// `error` is never read, and a refused token request throws a fixed code. A
// refusal the transport decided (TransportRefusal, including the storefront's
// preview_context_refused) is never retried and never fetches a new token.
import { createHash } from 'node:crypto';
import { ConnectorError, errorFields } from './log.js';
import { TransportRefusal } from './preview-transport.js';

const API_PREFIX = '/api/apps/v1';
const TOKEN_REFRESH_MARGIN_MS = 30_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

// FulfillmentRefusal.code in ../../contract/openapi.yaml.
const HOLD_CODES = new Set([
  'operator-hold', 'payment-not-captured', 'adult-signature', 'label', 'reconcile', 'fulfillment', 'evidence', 'payment', 'stock', 'ship-to',
]);
const REFUSAL_CODES = new Set([
  'invalid_token', 'scope_denied', 'denied', 'stage-unknown', 'unconfigured', 'unavailable', 'not-assigned', 'assignment-held',
  'assignment-ended', 'consent-missing', 'consent-revoked', 'consent-expired', 'quota', 'contact-erased', 'contact-expired',
  'contact-absent', 'contact-unreadable', 'audit-unavailable', 'vault-key-unavailable', 'malformed', 'idempotency-conflict',
  'label-regress', 'conflict', 'carrier-prohibited', 'carrier-mismatch', ...HOLD_CODES,
]);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A remote refusal reduced to fixed values before anything logs or branches on it. */
export function normalizeRefusal(body) {
  const code = body && typeof body === 'object' && REFUSAL_CODES.has(body.code) ? body.code : 'unexpected';
  const holds = Array.isArray(body?.holds) ? body.holds.map((h) => (HOLD_CODES.has(h) ? h : 'unexpected')) : undefined;
  return { code, holds };
}

/** A stable Idempotency-Key: the same fact always yields the same key. */
export function idempotencyKeyFor(orderId, evidence) {
  const canonical = JSON.stringify([orderId, ...Object.keys(evidence).sort().map((k) => [k, evidence[k]])]);
  return `fc-${evidence.kind}-${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
}

export function createGatewayClient({
  baseUrl,
  clientId,
  clientSecret,
  metadata,
  fetchImpl = fetch,
  logger,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxAttempts = 4,
}) {
  let token = null;

  async function accessToken(force = false) {
    if (!force && token && token.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return token.value;
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    const res = await fetchImpl(await metadata.tokenEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.access_token !== 'string') throw new ConnectorError('token_refused');
    token = { value: body.access_token, expiresAt: now() + Number(body.expires_in ?? 300) * 1000 };
    return token.value;
  }

  async function send(method, path, { body, headers = {} } = {}) {
    const url = new URL(`${API_PREFIX}${path}`, baseUrl).toString();
    for (let authAttempt = 0; ; authAttempt++) {
      const res = await fetchImpl(url, {
        method,
        headers: { accept: 'application/json', authorization: `Bearer ${await accessToken(authAttempt > 0)}`, ...headers },
        body,
      });
      if (res.status === 401 && authAttempt === 0) continue;
      const json = await res.json().catch(() => ({}));
      const header = res.headers.get('tot-request-id');
      const requestId = header !== null && REQUEST_ID.test(header) ? header : undefined;
      if (res.ok) return { ok: true, status: res.status, body: json, requestId };
      return { ok: false, status: res.status, ...normalizeRefusal(json), requestId };
    }
  }

  async function withRetry(label, fn) {
    for (let attempt = 1; ; attempt++) {
      let result;
      try {
        result = await fn();
      } catch (err) {
        if (err instanceof TransportRefusal || attempt >= maxAttempts) throw err;
        logger.warn('request failed, retrying', { op: label, attempt, ...errorFields(err) });
        await sleep(2 ** attempt * 100);
        continue;
      }
      if (result.ok || !RETRYABLE_STATUS.has(result.status) || attempt >= maxAttempts) return result;
      logger.warn('request refused as retryable, retrying', { op: label, attempt, status: result.status, code: result.code });
      await sleep(2 ** attempt * 100);
    }
  }

  return {
    async listAssignments() {
      const assignments = [];
      let cursor;
      do {
        const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
        const page = await withRetry('assignments', () => send('GET', `/fulfillment/assignments?${query}`));
        if (!page.ok) return page;
        assignments.push(...page.body.assignments);
        cursor = page.body.nextCursor;
      } while (cursor);
      return { ok: true, assignments };
    },

    /** The response is ship-to contact: callers keep it in memory only, for one label call. */
    readRecipient(orderId) {
      return withRetry('recipient', () => send('GET', `/fulfillment/orders/${encodeURIComponent(orderId)}/recipient`));
    },

    /**
     * POST shipment evidence. The body is serialized once and every retry
     * re-sends those exact bytes under the same key, which is what makes a
     * lost response safe to retry.
     */
    postShipmentEvidence(orderId, evidence, idempotencyKey, { traceparent } = {}) {
      const bytes = JSON.stringify(evidence);
      const headers = { 'content-type': 'application/json', 'idempotency-key': idempotencyKey };
      if (traceparent) headers.traceparent = traceparent;
      return withRetry('shipment-evidence', () =>
        send('POST', `/fulfillment/orders/${encodeURIComponent(orderId)}/shipment-evidence`, { body: bytes, headers }),
      );
    },
  };
}
