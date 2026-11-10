// The one outbound transport of the deployed connector. Every gateway call
// (authorization metadata and signing-key refresh, the OAuth token, the
// reconciliation read, the recipient read and shipment evidence) goes through
// the fetch this module builds, so one place decides where a request may go.
//
// It allows exactly one HTTPS origin and five method/path pairs, attaches the
// preview capability as the only Cookie, refuses redirects without following
// them, and refuses before any network I/O once the capability's local expiry
// has passed. The local expiry check is deny-only: it never establishes that a
// capability is authentic or belongs to this tenant, which the storefront
// verifies on every request. The capability lives only in this closure; it
// never enters a URL, a log line, an error or returned configuration.
import { ConnectorError } from './log.js';

/** The literal code the storefront answers when it refuses the preview context. */
export const PREVIEW_CONTEXT_REFUSED = 'preview_context_refused';
export const PREVIEW_COOKIE = 'tot_preview';

export const METADATA_PATH = '/.well-known/tot-app-authorization-metadata';
export const TOKEN_PATH = '/api/apps/oauth/token';
const ASSIGNMENTS_PATH = '/api/apps/v1/fulfillment/assignments';
const ORDER_ROUTE = /^\/api\/apps\/v1\/fulfillment\/orders\/([^/]+)\/(recipient|shipment-evidence)$/;
// An order id segment is sent as-is. A percent escape (an id that needed
// encoding) or a dot segment is refused rather than sent.
const ORDER_SEGMENT = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,127}$/;
const ASSIGNMENT_QUERY_KEYS = new Set(['limit', 'cursor']);

/**
 * A refusal this transport decided, never retried. `code` is fixed by this
 * sample; the message is the code, so it is safe to log.
 */
export class TransportRefusal extends ConnectorError {
  constructor(code) {
    super(code);
    this.name = 'TransportRefusal';
  }
}

/** The five allowed method/path pairs, or null. Exported for the table test. */
export function routeFor(method, url) {
  const { pathname } = url;
  const query = [...url.searchParams.keys()];
  const noQuery = url.search === '';
  if (method === 'GET' && pathname === METADATA_PATH) return noQuery ? 'metadata' : null;
  if (method === 'POST' && pathname === TOKEN_PATH) return noQuery ? 'token' : null;
  if (method === 'GET' && pathname === ASSIGNMENTS_PATH) {
    const unique = new Set(query);
    if (unique.size !== query.length || query.some((k) => !ASSIGNMENT_QUERY_KEYS.has(k))) return null;
    return 'assignments';
  }
  const order = ORDER_ROUTE.exec(pathname);
  if (!order || !noQuery || !ORDER_SEGMENT.test(order[1])) return null;
  if (method === 'GET' && order[2] === 'recipient') return 'recipient';
  if (method === 'POST' && order[2] === 'shipment-evidence') return 'shipment-evidence';
  return null;
}

function plainHeaders(headers) {
  const out = {};
  if (headers === undefined || headers === null) return out;
  const entries = typeof headers.entries === 'function' && !Array.isArray(headers) ? headers.entries() : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [name, value] of entries) out[String(name).toLowerCase()] = String(value);
  return out;
}

async function refusalCode(response) {
  try {
    const body = await response.clone().json();
    return body && typeof body === 'object' ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the scoped fetch. `fetchImpl` is the platform fetch (or a test double);
 * `now` is milliseconds. `expiresAtMs` is the capability's own `exp` claim.
 */
export function createPreviewFetch({ origin, capability, expiresAtMs, fetchImpl = (...args) => fetch(...args), now = () => Date.now() }) {
  if (typeof capability !== 'string' || capability === '' || !Number.isFinite(expiresAtMs)) throw new TransportRefusal('preview_context_missing');
  const allowedOrigin = new URL(origin).origin;

  return async function scopedFetch(input, init = {}) {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new TransportRefusal('destination_refused');
    const raw = String(input);
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new TransportRefusal('destination_refused');
    }
    if (url.protocol !== 'https:' || url.origin !== allowedOrigin || url.username !== '' || url.password !== '' || raw.includes('#')) {
      throw new TransportRefusal('destination_refused');
    }
    const method = String(init.method ?? 'GET').toUpperCase();
    if (!routeFor(method, url)) throw new TransportRefusal('route_refused');

    const headers = plainHeaders(init.headers);
    if (Object.hasOwn(headers, 'cookie')) throw new TransportRefusal('cookie_refused');
    headers.cookie = `${PREVIEW_COOKIE}=${capability}`;

    // Deny-only: a capability past its own expiry is never sent.
    if (now() >= expiresAtMs) throw new TransportRefusal('preview_context_expired');

    // workerd rejects redirect: 'error', so redirects are taken manually and refused.
    const response = await fetchImpl(url.toString(), { method, headers, body: init.body, redirect: 'manual' });
    if (response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400)) {
      throw new TransportRefusal('redirect_refused');
    }
    if (!response.ok && (await refusalCode(response)) === PREVIEW_CONTEXT_REFUSED) {
      throw new TransportRefusal(PREVIEW_CONTEXT_REFUSED);
    }
    return response;
  };
}
