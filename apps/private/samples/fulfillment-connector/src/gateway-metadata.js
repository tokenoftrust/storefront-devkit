// Discovery: the gateway authorization metadata publishes the token endpoint
// and the public keys that sign webhook deliveries. Cached per its
// cache-control max-age; an unknown keyid forces one bounded refresh (key
// rotation) before the delivery is rejected.
import { createPublicKey } from 'node:crypto';

export const METADATA_PATH = '/.well-known/tot-app-authorization-metadata';
const DEFAULT_MAX_AGE_SECONDS = 300;
const MIN_REFRESH_INTERVAL_MS = 30_000;

const JWK_ALG_TO_HTTPSIG = {
  RS256: 'rsa-v1_5-sha256',
  PS512: 'rsa-pss-sha512',
  ES256: 'ecdsa-p256-sha256',
  ES384: 'ecdsa-p384-sha384',
  EdDSA: 'ed25519',
  Ed25519: 'ed25519',
};

function maxAgeSeconds(cacheControl) {
  const m = /max-age=(\d+)/.exec(cacheControl ?? '');
  return m ? Number(m[1]) : DEFAULT_MAX_AGE_SECONDS;
}

function toKeyEntry(jwk) {
  if (!jwk || typeof jwk.kid !== 'string' || jwk.d !== undefined) return null;
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const alg = JWK_ALG_TO_HTTPSIG[jwk.alg] ?? (jwk.alg ? jwk.alg : undefined);
    return [jwk.kid, { key, alg }];
  } catch {
    return null;
  }
}

export function createGatewayMetadata({ baseUrl, fetchImpl = fetch, now = () => Date.now() }) {
  const url = new URL(METADATA_PATH, baseUrl).toString();
  let cached = null;
  let lastFetchAt = 0;

  async function load(force = false) {
    if (!force && cached && cached.expiresAt > now()) return cached;
    lastFetchAt = now();
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`authorization metadata unavailable (status ${res.status})`);
    const doc = await res.json();
    const keys = new Map((doc.webhook_signing_keys?.keys ?? []).map(toKeyEntry).filter(Boolean));
    cached = {
      tokenEndpoint: doc.token_endpoint,
      keys,
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
