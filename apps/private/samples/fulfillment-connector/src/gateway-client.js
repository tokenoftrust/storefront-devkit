// Pull API client: OAuth2 client-credentials token, then the three
// /fulfillment routes under /api/apps/v1. Refusals come back as
// { ok: false, status, code } so callers branch on `code`, never on text.
import { createHash } from 'node:crypto';

const API_PREFIX = '/api/apps/v1';
const TOKEN_REFRESH_MARGIN_MS = 30_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

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
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new Error(`token request refused (status ${res.status}, ${body.error ?? 'no error code'})`);
    }
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
      const requestId = res.headers.get('tot-request-id') ?? undefined;
      if (res.ok) return { ok: true, status: res.status, body: json, requestId };
      return { ok: false, status: res.status, code: json.code ?? 'unexpected', holds: json.holds, requestId };
    }
  }

  async function withRetry(label, fn) {
    for (let attempt = 1; ; attempt++) {
      let result;
      try {
        result = await fn();
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        logger.warn('request failed, retrying', { op: label, attempt, error: err.message });
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
