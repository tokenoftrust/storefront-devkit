// Discovery, per apps/private/webhooks-and-api.md: the gateway authorization
// metadata publishes `token_endpoint` and `webhook_signing_keys`, a JWK Set of
// the RSA public keys (alg RS256) that sign webhook deliveries. Cached per its
// cache-control max-age; an unknown keyid forces one bounded refresh (key
// rotation) before the delivery is rejected.
import { RSA_VERIFY_ALGORITHM } from './http-signature.js';

export const METADATA_PATH = '/.well-known/tot-app-authorization-metadata';
const DEFAULT_MAX_AGE_SECONDS = 300;
const MIN_REFRESH_INTERVAL_MS = 30_000;

function maxAgeSeconds(cacheControl) {
  const m = /max-age=(\d+)/.exec(cacheControl ?? '');
  return m ? Number(m[1]) : DEFAULT_MAX_AGE_SECONDS;
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
  let cached = null;
  let lastFetchAt = 0;

  async function load(force = false) {
    if (!force && cached && cached.expiresAt > now()) return cached;
    lastFetchAt = now();
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`authorization metadata unavailable (status ${res.status})`);
    const doc = await res.json();
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
      if (typeof tokenEndpoint !== 'string') throw new Error('authorization metadata has no token_endpoint');
      return tokenEndpoint;
    },
    async resolveSigningKey(keyid) {
      let doc = await load();
      if (!doc.keys.has(keyid) && now() - lastFetchAt >= MIN_REFRESH_INTERVAL_MS) doc = await load(true);
      return doc.keys.get(keyid) ?? null;
    },
  };
}
