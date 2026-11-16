// Gateway discovery: `GET /.well-known/tot-app-authorization-metadata` on the
// storefront origin publishes `token_endpoint` and `webhook_signing_keys`, a JWK
// Set of the RSA public keys (alg RS256) that sign webhook deliveries. The
// document is cached for its `Cache-Control` max-age. An unknown keyid forces
// one refetch (keys rotate), rate-limited, before a delivery is rejected.
import { RSA_VERIFY_ALGORITHM } from './http-signature.js';
import { TransportError } from './errors.js';

export const METADATA_PATH = '/.well-known/tot-app-authorization-metadata';
export const TOKEN_PATH = '/api/apps/oauth/token';
export const API_PREFIX = '/api/apps/v1';

const DEFAULT_MAX_AGE_SECONDS = 300;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The storefront origin as `scheme://host[:port]`. HTTPS is required except for
 * a loopback host (a local simulator). A path, query, fragment or userinfo is
 * refused so a base URL with `/api/apps/v1` appended is caught at construction.
 */
export function normalizeOrigin(origin) {
  let url;
  try {
    url = new URL(String(origin));
  } catch {
    throw new TypeError('origin must be an absolute URL such as https://acme.tokenoftrust.store');
  }
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopback) throw new TypeError('origin must use https');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new TypeError('origin must be scheme://host[:port] with no path, query or credentials');
  }
  return url.origin;
}

function maxAgeSeconds(cacheControl) {
  const m = /max-age=(\d+)/.exec(cacheControl ?? '');
  return m ? Number(m[1]) : DEFAULT_MAX_AGE_SECONDS;
}

/** Import one published webhook signing key; anything but a public RS256 signing key yields null. */
export async function importWebhookSigningKey(jwk) {
  if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || jwk.d !== undefined) return null;
  if (jwk.use !== undefined && jwk.use !== 'sig') return null;
  if (jwk.alg !== undefined && jwk.alg !== 'RS256') return null;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, RSA_VERIFY_ALGORITHM, false, ['verify']);
    return { kid: jwk.kid, key };
  } catch {
    return null;
  }
}

async function importKeySet(jwks) {
  const entries = await Promise.all((jwks?.keys ?? []).map(importWebhookSigningKey));
  return new Map(entries.filter(Boolean).map(({ kid, key }) => [kid, key]));
}

/** A fixed set of webhook signing keys, for tests or a pinned key set. */
export class StaticSigningKeys {
  /** @param {{ keys: object[] }} jwks A JWK Set of public RS256 keys. */
  constructor(jwks) {
    this.ready = importKeySet(jwks);
  }

  async resolveSigningKey(keyid) {
    return (await this.ready).get(keyid) ?? null;
  }
}

/** The gateway's published authorization metadata, cached. */
export class AuthorizationMetadata {
  /**
   * @param {object} options
   * @param {string} options.origin The storefront origin.
   * @param {typeof fetch} [options.fetch]
   * @param {() => number} [options.now] Milliseconds since the epoch.
   * @param {number} [options.minRefreshIntervalMs] Least time between forced refetches on an unknown keyid.
   */
  constructor({ origin, fetch: fetchImpl = (...args) => globalThis.fetch(...args), now = () => Date.now(), minRefreshIntervalMs = 30_000 }) {
    this.origin = normalizeOrigin(origin);
    this.url = `${this.origin}${METADATA_PATH}`;
    this.expectedTokenEndpoint = `${this.origin}${TOKEN_PATH}`;
    this.fetch = fetchImpl;
    this.now = now;
    this.minRefreshIntervalMs = minRefreshIntervalMs;
    this.cached = null;
    this.lastFetchAt = -Infinity;
    this.inflight = null;
  }

  async load(force = false) {
    if (!force && this.cached && this.cached.expiresAt > this.now()) return this.cached;
    this.inflight ??= this.fetchDocument().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async fetchDocument() {
    this.lastFetchAt = this.now();
    let res;
    try {
      res = await this.fetch(this.url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual' });
    } catch (cause) {
      throw new TransportError({ code: 'metadata_unreachable', retryable: true, cause });
    }
    if (!res.ok) throw new TransportError({ code: 'metadata_unavailable', status: res.status, retryable: res.status >= 500 });
    let doc;
    try {
      doc = await res.json();
    } catch {
      throw new TransportError({ code: 'metadata_unavailable', status: res.status });
    }
    this.cached = {
      tokenEndpoint: doc?.token_endpoint,
      authMethods: Array.isArray(doc?.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [],
      keys: await importKeySet(doc?.webhook_signing_keys),
      expiresAt: this.now() + maxAgeSeconds(res.headers.get('cache-control')) * 1000,
    };
    return this.cached;
  }

  /** The published token endpoint, accepted only as this origin's exact OAuth path. */
  async tokenEndpoint() {
    const { tokenEndpoint } = await this.load();
    if (tokenEndpoint !== this.expectedTokenEndpoint) throw new TransportError({ code: 'token_endpoint_refused' });
    return tokenEndpoint;
  }

  /** The webhook signing key for `keyid`, refetching once (rate-limited) when it is unknown. */
  async resolveSigningKey(keyid) {
    let doc = await this.load();
    if (!doc.keys.has(keyid) && this.now() - this.lastFetchAt >= this.minRefreshIntervalMs) doc = await this.load(true);
    return doc.keys.get(keyid) ?? null;
  }
}
