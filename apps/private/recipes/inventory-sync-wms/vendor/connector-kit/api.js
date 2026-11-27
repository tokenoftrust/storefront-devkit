// Pull API client for `/api/apps/v1`. Every mutating call carries an
// Idempotency-Key, generated once per call when the caller supplies none, and
// every retry re-sends the same bytes under the same key, so a lost response is
// safe to retry. 408/429/502/503/504 and network failures are retried with
// bounded backoff; `Retry-After` is honored exactly. One 401 refreshes the
// token and repeats the call. Cursor pagination (`cursor` / `nextCursor`, with
// `limit` and `updatedSince`) drains every page.
import { ApiError, AuthError, ConnectorError, TransportError, safeCode, safeRequestId } from './errors.js';
import { hex, sha256, utf8 } from './encoding.js';
import { API_PREFIX, resolveStoreBase } from './metadata.js';
import { RETRYABLE_STATUS, backoffDelay, defaultSleep, parseRetryAfter, retryPolicy } from './retry.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const METHODS = new Set(['GET', 'HEAD', ...MUTATING]);
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,128}$/;
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*$/;

/** A random Idempotency-Key for one logical write. */
export function newIdempotencyKey(prefix = 'ck') {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * A deterministic Idempotency-Key: the same prefix and parts always yield the
 * same key, so a write re-derived after a restart replays instead of
 * duplicating. Parts are JSON-serialized with sorted object keys.
 */
export async function deriveIdempotencyKey(prefix, ...parts) {
  const canonical = JSON.stringify(parts, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v,
  );
  return `${prefix}-${hex(await sha256(utf8(canonical))).slice(0, 48)}`;
}

function appendQuery(params, query) {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v instanceof Date ? v.toISOString() : String(v));
  }
}

function itemsOf(body, itemsKey) {
  if (itemsKey !== undefined) {
    if (!Array.isArray(body?.[itemsKey])) throw new TypeError(`page has no "${itemsKey}" array`);
    return body[itemsKey];
  }
  const arrays = Object.keys(body ?? {}).filter((k) => Array.isArray(body[k]));
  if (arrays.length !== 1) throw new TypeError('cannot infer the items array of this page; pass itemsKey');
  return body[arrays[0]];
}

export class ApiClient {
  #apiPrefix;

  /**
   * @param {object} options
   * @param {string} options.origin The storefront origin, e.g. https://acme.tokenoftrust.store.
   * @param {string} [options.tenant] Store slug on a shared host. Can also be supplied as a single path segment in origin.
   * @param {{ getAccessToken(): Promise<string>, invalidate?(token: string): void }} options.auth Usually a ConnectorAuthClient.
   * @param {object} [options.retry] Retry policy overrides (see DEFAULT_RETRY_POLICY).
   * @param {typeof fetch} [options.fetch]
   * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
   * @param {() => number} [options.random]
   * @param {() => number} [options.now] Milliseconds since the epoch.
   * @param {(info: { attempt: number, delayMs: number, error: ConnectorError }) => void} [options.onRetry] Observe retries (for logging).
   */
  constructor({
    origin,
    tenant,
    auth,
    retry,
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
    sleep = defaultSleep,
    random = Math.random,
    now = () => Date.now(),
    onRetry,
  }) {
    if (!auth || typeof auth.getAccessToken !== 'function') throw new TypeError('auth must provide getAccessToken()');
    const { bareOrigin, base } = resolveStoreBase(origin, tenant);
    this.origin = bareOrigin;
    this.#apiPrefix = `${base.slice(bareOrigin.length)}${API_PREFIX}`;
    this.auth = auth;
    this.retry = retryPolicy(retry);
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.random = random;
    this.now = now;
    this.onRetry = onRetry;
  }

  get(path, options) {
    return this.request({ ...options, method: 'GET', path });
  }

  delete(path, options) {
    return this.request({ ...options, method: 'DELETE', path });
  }

  post(path, body, options) {
    return this.request({ ...options, method: 'POST', path, body });
  }

  put(path, body, options) {
    return this.request({ ...options, method: 'PUT', path, body });
  }

  patch(path, body, options) {
    return this.request({ ...options, method: 'PATCH', path, body });
  }

  url(path, query) {
    const refuse = () => new TypeError('path must be an absolute path under /api/apps/v1, e.g. /inventory; pass query separately');
    if (typeof path !== 'string' || !SAFE_PATH.test(path)) throw refuse();
    if (this.#apiPrefix !== API_PREFIX && /%2f|%5c/i.test(path)) throw refuse();
    const pathname = `${this.#apiPrefix}${path}`;
    const url = new URL(pathname, this.origin);
    // Any normalization (a dot segment, an encoded dot) would move the call elsewhere.
    if (url.origin !== this.origin || url.pathname !== pathname) throw refuse();
    appendQuery(url.searchParams, query);
    return url.toString();
  }

  /**
   * One API call with retries.
   *
   * @param {object} req
   * @param {string} req.method
   * @param {string} req.path Path under /api/apps/v1, e.g. `/inventory/movements`.
   * @param {Record<string, unknown>} [req.query]
   * @param {unknown} [req.body] JSON-serialized once.
   * @param {string} [req.idempotencyKey] Mutating calls only; generated when omitted.
   * @param {string} [req.traceparent] W3C Trace Context to propagate.
   * @param {Record<string, string>} [req.headers] Extra headers.
   * @param {AbortSignal} [req.signal]
   * @returns {Promise<{ status: number, body: any, headers: Headers, requestId?: string, idempotencyKey?: string }>}
   */
  async request({ method, path, query, body, idempotencyKey, traceparent, headers = {}, signal }) {
    const verb = String(method).toUpperCase();
    if (!METHODS.has(verb)) throw new TypeError(`unsupported method ${method}`);
    const url = this.url(path, query);
    const sendHeaders = { accept: 'application/json' };
    for (const [k, v] of Object.entries(headers)) sendHeaders[k.toLowerCase()] = String(v);
    let key;
    if (MUTATING.has(verb)) {
      key = idempotencyKey ?? newIdempotencyKey();
      if (!IDEMPOTENCY_KEY.test(key)) throw new TypeError('idempotencyKey must be 8..128 printable ASCII characters');
      sendHeaders['idempotency-key'] = key;
    } else if (idempotencyKey !== undefined) {
      throw new TypeError(`${verb} takes no idempotencyKey`);
    }
    if (traceparent !== undefined) {
      if (!TRACEPARENT.test(traceparent)) throw new TypeError('traceparent must be a W3C trace context value');
      sendHeaders.traceparent = traceparent;
    }
    // Serialized once: every retry re-sends these exact bytes.
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) sendHeaders['content-type'] = 'application/json';

    let refreshedAfter401 = false;
    for (let attempt = 1; ; attempt++) {
      let error;
      let token;
      try {
        token = await this.auth.getAccessToken();
        const res = await this.send(url, { method: verb, headers: { ...sendHeaders, authorization: `Bearer ${token}` }, body: payload, signal });
        const result = await this.read(res);
        if (res.ok) return { ...result, ...(key ? { idempotencyKey: key } : {}) };
        error = this.refusal(res, result, path);
      } catch (err) {
        if (!(err instanceof ConnectorError)) throw err;
        error = err;
      }
      // A failed write may still have committed: the caller resends under this key.
      if (key) error.idempotencyKey = key;
      // The auth client already retried its own token request.
      if (error instanceof AuthError) throw error;
      if (error instanceof ApiError && error.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        this.auth.invalidate?.(token);
        attempt--;
        continue;
      }
      if (!error.retryable || attempt >= this.retry.maxAttempts) throw error;
      if (error.retryAfterMs !== undefined && error.retryAfterMs > this.retry.maxRetryAfterMs) throw error;
      const delayMs = error.retryAfterMs ?? backoffDelay(attempt, this.retry, this.random);
      this.onRetry?.({ attempt, delayMs, error });
      await this.sleep(delayMs, signal);
    }
  }

  async send(url, init) {
    try {
      return await this.fetch(url, { ...init, redirect: 'manual' });
    } catch (cause) {
      if (init.signal?.aborted) throw new TransportError({ code: 'aborted', cause });
      throw new TransportError({ code: 'network', retryable: true, cause });
    }
  }

  async read(res) {
    const requestId = safeRequestId(res.headers.get('tot-request-id'));
    const text = await res.text();
    let body = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, body, headers: res.headers, requestId };
  }

  refusal(res, { body, requestId }, path) {
    if (res.status >= 300 && res.status < 400) return new TransportError({ code: 'redirect_refused', status: res.status, requestId });
    const code = safeCode(body?.code ?? body?.error ?? (body === null ? `http_${res.status}` : undefined));
    const holds = Array.isArray(body?.holds) ? body.holds.map(safeCode) : undefined;
    const isInventoryBatchRefusal =
      path?.startsWith('/inventory/') &&
      (res.status === 400 || res.status === 422 || (res.status === 409 && code === 'balance-out-of-range'));
    return new ApiError({
      code,
      status: res.status,
      requestId: requestId ?? safeRequestId(body?.requestId),
      retryable: RETRYABLE_STATUS.has(res.status),
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()),
      holds,
      field: body?.field,
      index: isInventoryBatchRefusal ? body?.index : undefined,
      reasons: res.status === 409 ? body?.reasons : undefined,
    });
  }

  /**
   * Every page of a cursor-paginated list.
   *
   * @param {string} path e.g. `/catalog/products`.
   * @param {object} [options]
   * @param {Record<string, unknown>} [options.query] Extra filters.
   * @param {number} [options.limit] Page size (1..100).
   * @param {string|Date} [options.updatedSince] Only records changed since then.
   * @param {string} [options.cursor] Resume from a saved `nextCursor`.
   * @param {string} [options.itemsKey] The page's items array; inferred when the page has exactly one array.
   * @param {number} [options.maxPages] Stop after this many pages.
   * @param {AbortSignal} [options.signal]
   * @returns {AsyncGenerator<{ items: any[], nextCursor?: string, truncated: boolean, body: any, requestId?: string }>}
   */
  async *pages(path, { query, limit, updatedSince, cursor, itemsKey, maxPages = Infinity, signal } = {}) {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw new TypeError('limit must be an integer in 1..100');
    }
    let next = cursor;
    const seen = new Set(cursor === undefined ? [] : [cursor]);
    for (let page = 0; page < maxPages; page++) {
      const res = await this.get(path, { query: { ...query, limit, updatedSince, cursor: next }, signal });
      const nextCursor = typeof res.body?.nextCursor === 'string' && res.body.nextCursor !== '' ? res.body.nextCursor : undefined;
      yield { items: itemsOf(res.body, itemsKey), nextCursor, truncated: res.body?.truncated === true, body: res.body, requestId: res.requestId };
      if (nextCursor === undefined) return;
      // A repeated cursor (A→A or A→B→A) would page forever.
      if (seen.has(nextCursor)) throw new TransportError({ code: 'pagination_stalled', requestId: res.requestId });
      seen.add(nextCursor);
      next = nextCursor;
    }
  }

  /** Every item across every page. Same options as `pages`. */
  async *items(path, options) {
    for await (const page of this.pages(path, options)) yield* page.items;
  }

  /**
   * Drain a list into memory. `truncated` is true when any page said the
   * server did not return everything (e.g. orders changed since `updatedSince`
   * beyond its cap): run a full backfill without `updatedSince`.
   */
  async collect(path, options) {
    const items = [];
    let truncated = false;
    let pages = 0;
    for await (const page of this.pages(path, options)) {
      items.push(...page.items);
      truncated ||= page.truncated;
      pages++;
    }
    return { items, truncated, pages };
  }
}
