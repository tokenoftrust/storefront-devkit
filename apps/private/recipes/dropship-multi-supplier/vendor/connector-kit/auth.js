// Installation tokens: the RFC 6749 section 4.4 client-credentials grant at
// `POST /api/apps/oauth/token`, with exactly one client authentication method:
//
//   client_secret_basic  HTTP Basic, each half form-urlencoded (RFC 6749 2.3.1)
//   client_secret_post   client_id and client_secret in the form body
//   private_key_jwt      an RFC 7523 assertion signed RS256 or ES256
//
// The token is cached and refreshed early, before it expires, and concurrent
// callers share one refresh. Credentials, assertions and tokens never enter an
// error, and a refusal carries only the OAuth `error` code.
import { AuthError, TransportError, safeRequestId } from './errors.js';
import { base64Encode, base64UrlEncode, utf8 } from './encoding.js';
import { TOKEN_PATH, normalizeOrigin } from './metadata.js';
import { RETRYABLE_STATUS, backoffDelay, defaultSleep, parseRetryAfter, retryPolicy } from './retry.js';

export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
export const CLIENT_AUTH_METHODS = Object.freeze(['client_secret_basic', 'client_secret_post', 'private_key_jwt']);
/** The gateway refuses an assertion whose `exp` is more than this far ahead. */
export const MAX_ASSERTION_LIFETIME_SECONDS = 300;

const OAUTH_ERRORS = new Set(['invalid_request', 'unsupported_grant_type', 'invalid_client', 'invalid_grant', 'temporarily_unavailable']);
const TOKEN_RETRY_DEFAULTS = { maxAttempts: 3 };

function formEncode(value) {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

async function importSigningKey(privateKey) {
  if (privateKey && typeof privateKey === 'object' && privateKey.type === 'private' && privateKey.algorithm) {
    return { key: privateKey, kid: undefined };
  }
  const jwk = privateKey;
  if (!jwk || typeof jwk !== 'object' || typeof jwk.d !== 'string') {
    throw new TypeError('privateKey must be a private CryptoKey or a private JWK');
  }
  let algorithm;
  if (jwk.kty === 'RSA') algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  else if (jwk.kty === 'EC' && jwk.crv === 'P-256') algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
  else throw new TypeError('privateKey must be an RSA key or an EC P-256 key');
  const { alg: _alg, key_ops: _ops, use: _use, ...material } = jwk;
  const key = await crypto.subtle.importKey('jwk', material, algorithm, false, ['sign']);
  return { key, kid: typeof jwk.kid === 'string' ? jwk.kid : undefined };
}

function jwsAlgFor(key) {
  if (key.algorithm.name === 'RSASSA-PKCS1-v1_5') return 'RS256';
  if (key.algorithm.name === 'ECDSA' && key.algorithm.namedCurve === 'P-256') return 'ES256';
  throw new TypeError('privateKey must be RSASSA-PKCS1-v1_5 (RS256) or ECDSA P-256 (ES256)');
}

export class ConnectorAuthClient {
  // The token, the in-flight token request and every credential are #private,
  // so logging, inspecting or serializing the client prints none of them.
  #token = null;
  #inflight = null;
  #secret;
  #signer;

  /**
   * @param {object} options
   * @param {string} options.origin The storefront origin, e.g. https://acme.tokenoftrust.store.
   * @param {string} options.clientId The installation's client id.
   * @param {string} [options.clientSecret] For `client_secret_basic` (default) or `client_secret_post`.
   * @param {CryptoKey|object} [options.privateKey] For `private_key_jwt`: a private CryptoKey or private JWK (RSA or EC P-256).
   * @param {string} [options.keyId] The `kid` of the registered public key. Defaults to the JWK's `kid`.
   * @param {'client_secret_basic'|'client_secret_post'|'private_key_jwt'} [options.method]
   * @param {number} [options.refreshSkewSeconds] Refresh this long before expiry (at most half the token lifetime).
   * @param {number} [options.assertionLifetimeSeconds] Lifetime of each client assertion (1..300).
   * @param {object} [options.retry] Retry policy overrides for the token request (default 3 attempts).
   * @param {typeof fetch} [options.fetch]
   * @param {() => number} [options.now] Milliseconds since the epoch.
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {() => number} [options.random]
   * @param {() => string} [options.randomId] Source of assertion `jti` values.
   */
  constructor({
    origin,
    clientId,
    clientSecret,
    privateKey,
    keyId,
    method,
    refreshSkewSeconds = 60,
    assertionLifetimeSeconds = 60,
    retry,
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    sleep = defaultSleep,
    random = Math.random,
    randomId = () => crypto.randomUUID(),
  }) {
    if (typeof clientId !== 'string' || clientId === '') throw new TypeError('clientId is required');
    const resolved = method ?? (privateKey !== undefined ? 'private_key_jwt' : 'client_secret_basic');
    if (!CLIENT_AUTH_METHODS.includes(resolved)) throw new TypeError(`method must be one of ${CLIENT_AUTH_METHODS.join(', ')}`);
    if (resolved === 'private_key_jwt') {
      if (privateKey === undefined) throw new TypeError('private_key_jwt requires privateKey');
      if (clientSecret !== undefined) throw new TypeError('private_key_jwt takes no clientSecret');
    } else {
      if (typeof clientSecret !== 'string' || clientSecret === '') throw new TypeError(`${resolved} requires clientSecret`);
      if (privateKey !== undefined) throw new TypeError(`${resolved} takes no privateKey`);
    }
    if (!Number.isInteger(assertionLifetimeSeconds) || assertionLifetimeSeconds < 1 || assertionLifetimeSeconds > MAX_ASSERTION_LIFETIME_SECONDS) {
      throw new TypeError(`assertionLifetimeSeconds must be an integer in 1..${MAX_ASSERTION_LIFETIME_SECONDS}`);
    }
    this.origin = normalizeOrigin(origin);
    this.tokenEndpoint = `${this.origin}${TOKEN_PATH}`;
    this.clientId = clientId;
    this.method = resolved;
    this.refreshSkewMs = refreshSkewSeconds * 1000;
    this.assertionLifetimeSeconds = assertionLifetimeSeconds;
    this.retry = retryPolicy({ ...TOKEN_RETRY_DEFAULTS, ...retry });
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.random = random;
    this.randomId = randomId;
    this.#secret = clientSecret ?? null;
    this.#signer = resolved === 'private_key_jwt' ? importSigningKey(privateKey) : null;
    this.#signer?.catch(() => {});
    this.keyId = keyId;
  }

  /** A bearer access token, refreshed early when the cached one is close to expiry. */
  async getAccessToken({ forceRefresh = false } = {}) {
    return (await this.getToken({ forceRefresh })).accessToken;
  }

  /** The cached token, its expiry (ms since epoch) and granted scopes, refreshing when needed. */
  async getToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.#token && !this.needsRefresh(this.#token)) return this.#token;
    this.#inflight ??= this.requestToken().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /**
   * Drop the cached token. Pass the token a request was refused with so a
   * concurrent caller's newer token is not discarded.
   */
  invalidate(accessToken) {
    if (accessToken === undefined || this.#token?.accessToken === accessToken) this.#token = null;
  }

  needsRefresh(token) {
    const lifetime = token.expiresAt - token.issuedAt;
    const skew = Math.min(this.refreshSkewMs, lifetime / 2);
    return this.now() >= token.expiresAt - skew;
  }

  /** A fresh, signed RFC 7523 client assertion. Exposed for diagnostics and tests. */
  async createClientAssertion() {
    const signer = this.#signer;
    if (!signer) throw new TypeError('createClientAssertion requires private_key_jwt');
    const { key, kid: jwkKid } = await signer;
    const alg = jwsAlgFor(key);
    const kid = this.keyId ?? jwkKid;
    const iat = Math.floor(this.now() / 1000);
    const header = { alg, typ: 'JWT', ...(kid ? { kid } : {}) };
    const payload = { iss: this.clientId, sub: this.clientId, aud: this.tokenEndpoint, iat, exp: iat + this.assertionLifetimeSeconds, jti: this.randomId() };
    const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
    const params = alg === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' };
    const signature = new Uint8Array(await crypto.subtle.sign(params, key, utf8(signingInput)));
    return `${signingInput}.${base64UrlEncode(signature)}`;
  }

  async buildRequest() {
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.method === 'client_secret_basic') {
      headers.authorization = `Basic ${base64Encode(utf8(`${formEncode(this.clientId)}:${formEncode(this.#secret)}`))}`;
    } else if (this.method === 'client_secret_post') {
      form.set('client_id', this.clientId);
      form.set('client_secret', this.#secret);
    } else {
      form.set('client_id', this.clientId);
      form.set('client_assertion_type', CLIENT_ASSERTION_TYPE);
      form.set('client_assertion', await this.createClientAssertion());
    }
    return { method: 'POST', headers, body: form.toString(), redirect: 'manual' };
  }

  async requestOnce() {
    const init = await this.buildRequest();
    const sentAt = this.now();
    let res;
    try {
      res = await this.fetch(this.tokenEndpoint, init);
    } catch (cause) {
      throw new TransportError({ code: 'network', retryable: true, cause });
    }
    const requestId = safeRequestId(res.headers.get('tot-request-id'));
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const code = OAUTH_ERRORS.has(body?.error) ? body.error : 'unexpected';
      throw new AuthError({
        code,
        status: res.status,
        requestId,
        retryable: RETRYABLE_STATUS.has(res.status),
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()),
      });
    }
    const expiresIn = Number(body?.expires_in);
    if (typeof body?.access_token !== 'string' || body.access_token === '' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new AuthError({ code: 'invalid_token_response', status: res.status, requestId });
    }
    return {
      accessToken: body.access_token,
      issuedAt: sentAt,
      expiresAt: sentAt + expiresIn * 1000,
      scope: typeof body.scope === 'string' && body.scope !== '' ? body.scope.split(' ') : [],
    };
  }

  async requestToken() {
    for (let attempt = 1; ; attempt++) {
      try {
        this.#token = await this.requestOnce();
        return this.#token;
      } catch (err) {
        if (!err.retryable || attempt >= this.retry.maxAttempts) throw err;
        if (err.retryAfterMs !== undefined && err.retryAfterMs > this.retry.maxRetryAfterMs) throw err;
        await this.sleep(err.retryAfterMs ?? backoffDelay(attempt, this.retry, this.random));
      }
    }
  }
}
