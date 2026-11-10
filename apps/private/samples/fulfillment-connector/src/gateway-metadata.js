// Discovery, per apps/private/webhooks-and-api.md: the gateway authorization
// metadata publishes `token_endpoint` and `webhook_signing_keys`, a JWK Set of
// the RSA public keys (alg RS256) that sign webhook deliveries. Cached per its
// cache-control max-age; an unknown keyid forces one bounded refresh (key
// rotation) before the delivery is rejected.
//
// The document is read only with GET on the metadata path, which is also the
// only way signing keys are refreshed. Its `token_endpoint` is accepted only as
// the exact same-origin OAuth path; the scoped preview transport enforces the
// same rule on the request itself. Failures throw fixed codes, never remote text.
import { RSA_VERIFY_ALGORITHM } from './http-signature.js';
import { ConnectorError } from './log.js';
import { METADATA_PATH, TOKEN_PATH } from './preview-transport.js';

export { METADATA_PATH };
const DEFAULT_MAX_AGE_SECONDS = 300;
const MIN_REFRESH_INTERVAL_MS = 30_000;

function maxAgeSeconds(cacheControl) {
  const m = /max-age=(\d+)/.exec(cacheControl ?? '');
  return m ? Number(m[1]) : DEFAULT_MAX_AGE_SECONDS;
}

function sameTokenEndpoint(published, expected) {
  if (typeof published !== 'string' || published.includes('#') || published.includes('@')) return false;
  try {
    return new URL(published).toString() === expected;
  } catch {
    return false;
  }
}

/** Import one published webhook signing key; anything but a public RS256 signing key is skipped. */
export async function importWebhookSigningKey(jwk) {
  if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || jwk.d !== undefined) return null;
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  if (jwk.alg !== undefined && jwk.alg !== 'RS256') return null;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256' }, RSA_VERIFY_ALGORITHM, false, ['verify']);
    return [jwk.kid, { key }];
  } catch {
    return null;
  }
}

export function createGatewayMetadata({ baseUrl, fetchImpl = (...args) => fetch(...args), now = () => Date.now() }) {
  const url = new URL(METADATA_PATH, baseUrl).toString();
  const expectedTokenEndpoint = new URL(TOKEN_PATH, baseUrl).toString();
  let cached = null;
  let lastFetchAt = 0;

  async function load(force = false) {
    if (!force && cached && cached.expiresAt > now()) return cached;
    lastFetchAt = now();
    const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (!res.ok) throw new ConnectorError('metadata_unavailable');
    const doc = await res.json().catch(() => {
      throw new ConnectorError('metadata_unavailable');
    });
    const entries = await Promise.all((doc.webhook_signing_keys?.keys ?? []).map(importWebhookSigningKey));
    cached = {
      tokenEndpoint: doc.token_endpoint,
      keys: new Map(entries.filter(Boolean)),
      expiresAt: now() + maxAgeSeconds(res.headers.get('cache-control')) * 1000,
    };
    return cached;
  }

  return {
    async tokenEndpoint() {
      const { tokenEndpoint } = await load();
      if (!sameTokenEndpoint(tokenEndpoint, expectedTokenEndpoint)) throw new ConnectorError('token_endpoint_refused');
      return tokenEndpoint;
    },
    async resolveSigningKey(keyid) {
      let doc = await load();
      if (!doc.keys.has(keyid) && now() - lastFetchAt >= MIN_REFRESH_INTERVAL_MS) doc = await load(true);
      return doc.keys.get(keyid) ?? null;
    },
  };
}
