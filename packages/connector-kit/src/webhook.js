// Webhook receiver. The order follows apps/private/webhooks-and-api.md: raw
// body, Content-Digest, RFC 9421 signature (with a created/expires window and
// keyid resolution against the published `webhook_signing_keys`), CloudEvents
// envelope, then a replay guard on the event id through an injectable store.
// Only an event that passed every step reaches application code.
import { toBytes } from './encoding.js';
import { verifyContentDigest, verifyMessageSignature } from './http-signature.js';

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const EVENT_TYPE_PREFIX = 'com.tokenoftrust.storefront.';
const ENVELOPE_REQUIRED = ['specversion', 'id', 'source', 'type', 'time', 'datacontenttype', 'tenantid', 'appinstallid', 'dataschemaversion', 'data'];
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

/** HTTP status for each refusal code. */
export const WEBHOOK_REFUSALS = Object.freeze({
  method_not_allowed: 405,
  body_too_large: 413,
  digest_missing: 400,
  digest_malformed: 400,
  digest_unsupported: 400,
  digest_mismatch: 400,
  signature_missing: 401,
  signature_malformed: 401,
  signature_coverage: 401,
  unsupported_alg: 401,
  signature_expired: 401,
  unknown_key: 401,
  signature_invalid: 401,
  body_not_json: 400,
  envelope_invalid: 400,
  // A replay is acknowledged with 200 so the sender stops, and never reaches the application.
  replayed_event: 200,
});

/**
 * In-memory seen-event store, bounded by entry count and TTL. It does not
 * survive a restart or span instances: production receivers implement the same
 * two methods over durable storage (a unique-key insert with an expiry).
 */
export class MemorySeenEventStore {
  constructor({ maxEntries = 100_000, now = () => Date.now() } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  /** Record `key` as seen. Resolves true when it was new, false when already present and unexpired. */
  async claim(key, ttlSeconds) {
    const at = this.now();
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > at) return false;
    this.entries.delete(key);
    this.entries.set(key, at + ttlSeconds * 1000);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return true;
  }

  /** Forget `key` so a redelivery is processed (the application failed to handle it). */
  async release(key) {
    this.entries.delete(key);
  }
}

/** Lowercased, single-string header map from a Headers object, a plain object, or entry pairs. */
export function normalizeHeaders(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' && !Array.isArray(headers) ? headers.entries() : Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    out[String(name).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function envelopeProblem(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'not an object';
  for (const key of ENVELOPE_REQUIRED) if (!(key in event)) return `missing ${key}`;
  if (event.specversion !== '1.0') return 'specversion';
  for (const key of ['id', 'source', 'type', 'tenantid', 'appinstallid']) {
    if (typeof event[key] !== 'string' || event[key] === '') return key;
  }
  if (!event.type.startsWith(EVENT_TYPE_PREFIX)) return 'type';
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return 'data';
  return null;
}

export class WebhookReceiver {
  /**
   * @param {object} options
   * @param {string} options.endpoint The webhook endpoint exactly as registered in tot-app.json (the signed `@target-uri`).
   * @param {{ resolveSigningKey(keyid: string): Promise<CryptoKey|null> }} options.keys AuthorizationMetadata or StaticSigningKeys.
   * @param {{ claim(key: string, ttlSeconds: number): Promise<boolean>, release(key: string): Promise<void> }} [options.seenEvents]
   * @param {number} [options.maxAgeSeconds] Oldest acceptable signature `created` (default 300).
   * @param {number} [options.maxClockSkewSeconds] Furthest-future acceptable `created` (default 60).
   * @param {number} [options.replayTtlSeconds] How long an event id is remembered (default 7 days).
   * @param {number} [options.maxBodyBytes] Largest accepted body (default 1 MiB).
   * @param {() => number} [options.now] Milliseconds since the epoch.
   */
  constructor({
    endpoint,
    keys,
    seenEvents = new MemorySeenEventStore(),
    maxAgeSeconds = 300,
    maxClockSkewSeconds = 60,
    replayTtlSeconds = SEVEN_DAYS_SECONDS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    now = () => Date.now(),
  }) {
    // The registered string is kept verbatim: it is signed character for character.
    if (typeof endpoint !== 'string' || !URL.canParse(endpoint)) {
      throw new TypeError('endpoint must be the absolute webhook URL registered in tot-app.json');
    }
    if (!keys || typeof keys.resolveSigningKey !== 'function') throw new TypeError('keys must provide resolveSigningKey(keyid)');
    if (!seenEvents || typeof seenEvents.claim !== 'function' || typeof seenEvents.release !== 'function') {
      throw new TypeError('seenEvents must provide claim(key, ttlSeconds) and release(key)');
    }
    this.endpoint = endpoint;
    this.keys = keys;
    this.seenEvents = seenEvents;
    this.maxAgeSeconds = maxAgeSeconds;
    this.maxClockSkewSeconds = maxClockSkewSeconds;
    this.replayTtlSeconds = replayTtlSeconds;
    this.maxBodyBytes = maxBodyBytes;
    this.now = now;
  }

  /**
   * Verify one delivery and claim its event id.
   *
   * Resolves `{ ok: true, event, keyid, created, replayKey }`, or
   * `{ ok: false, status, code }` where `status` is the HTTP status to answer.
   * After `ok: true` the id is claimed: call `release(replayKey)` if the event
   * could not be handled, so the sender's retry is processed.
   *
   * @param {object} delivery
   * @param {string} delivery.method
   * @param {Headers|Record<string, string|string[]>} delivery.headers
   * @param {Uint8Array|ArrayBuffer|string} delivery.body The exact raw body bytes.
   */
  async verify({ method, headers, body }) {
    const refuse = (code) => ({ ok: false, status: WEBHOOK_REFUSALS[code], code });
    if (String(method).toUpperCase() !== 'POST') return refuse('method_not_allowed');
    const bytes = toBytes(body);
    if (bytes.length > this.maxBodyBytes) return refuse('body_too_large');
    const h = normalizeHeaders(headers);

    const digest = await verifyContentDigest(h['content-digest'], bytes);
    if (!digest.ok) return refuse(digest.code);

    const signature = await verifyMessageSignature({
      method: 'POST',
      targetUri: this.endpoint,
      headers: h,
      resolveKey: (keyid) => this.keys.resolveSigningKey(keyid),
      now: this.now(),
      maxAgeSeconds: this.maxAgeSeconds,
      maxClockSkewSeconds: this.maxClockSkewSeconds,
    });
    if (!signature.ok) return refuse(signature.code);

    let event;
    try {
      event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return refuse('body_not_json');
    }
    if (envelopeProblem(event)) return refuse('envelope_invalid');

    const replayKey = `${event.tenantid}/${event.id}`;
    if (!(await this.seenEvents.claim(replayKey, this.replayTtlSeconds))) return refuse('replayed_event');
    return { ok: true, event, keyid: signature.keyid, created: signature.created, replayKey };
  }

  /** Forget a claimed event id so its redelivery is processed. */
  release(replayKey) {
    return this.seenEvents.release(replayKey);
  }

  /**
   * Verify, then run `onEvent(event, context)`. Answers 202 once the handler
   * resolves, 200 for a replay, the refusal status otherwise, and 500 (with the
   * id released, so the sender retries) when the handler throws.
   *
   * @returns {Promise<{ status: number, body: object, error?: unknown }>}
   */
  async receive(delivery, onEvent) {
    const result = await this.verify(delivery);
    if (!result.ok) {
      return { status: result.status, body: result.code === 'replayed_event' ? { accepted: true, duplicate: true } : { accepted: false, code: result.code } };
    }
    try {
      await onEvent(result.event, { keyid: result.keyid, created: result.created });
    } catch (error) {
      await this.release(result.replayKey);
      return { status: 500, body: { accepted: false, code: 'handler_failed' }, error };
    }
    return { status: 202, body: { accepted: true } };
  }

  /** `receive` for a fetch-style Request; resolves a Response. */
  async handleRequest(request, onEvent) {
    const declared = Number(request.headers.get('content-length'));
    let result;
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      result = { status: 413, body: { accepted: false, code: 'body_too_large' } };
    } else {
      const body = new Uint8Array(await request.arrayBuffer());
      result = await this.receive({ method: request.method, headers: request.headers, body }, onEvent);
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
}
