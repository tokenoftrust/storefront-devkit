// Webhook receiver. Order of operations follows the published guide: raw body,
// Content-Digest, RFC 9421 signature, envelope validation, dedupe on the
// CloudEvents id, then a 2xx once the event is safely accepted. The event is a
// notification only: the connector reconciles through the API before acting.
import { verifyContentDigest, verifyMessageSignature } from './http-signature.js';
import { errorFields } from './log.js';

export const MAX_BODY_BYTES = 1024 * 1024;
const TYPE_PREFIX = 'com.tokenoftrust.storefront.';
const FULFILLMENT_TYPES = new Set([
  'com.tokenoftrust.storefront.fulfillment.assignment.created',
  'com.tokenoftrust.storefront.fulfillment.assignment.updated',
]);
const ENVELOPE_REQUIRED = ['specversion', 'id', 'source', 'type', 'time', 'datacontenttype', 'tenantid', 'appinstallid', 'dataschemaversion', 'data'];
const DATA_KEYS = ['assignmentId', 'orderId', 'stage', 'state', 'eventVersion', 'occurredAt'];

/** In-memory seen-id set. A production receiver persists ids (they carry no contact). */
export function createEventIdStore({ maxEntries = 100_000 } = {}) {
  const seen = new Set();
  return {
    has: (id) => seen.has(id),
    add(id) {
      seen.add(id);
      if (seen.size > maxEntries) seen.delete(seen.values().next().value);
    },
  };
}

function envelopeProblem(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return 'not an object';
  for (const key of ENVELOPE_REQUIRED) if (!(key in event)) return `missing ${key}`;
  if (event.specversion !== '1.0') return 'specversion';
  if (event.dataschemaversion !== '1') return 'dataschemaversion';
  if (typeof event.id !== 'string' || event.id === '') return 'id';
  if (typeof event.type !== 'string' || !event.type.startsWith(TYPE_PREFIX)) return 'type';
  if (!FULFILLMENT_TYPES.has(event.type)) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'data';
  const keys = Object.keys(data).sort();
  if (keys.length !== DATA_KEYS.length || !DATA_KEYS.every((k) => keys.includes(k))) return 'data keys';
  if (typeof data.assignmentId !== 'string' || typeof data.orderId !== 'string') return 'data ids';
  if (!['preview', 'publication'].includes(data.stage)) return 'data.stage';
  if (!['active', 'held', 'cancelled'].includes(data.state)) return 'data.state';
  if (!Number.isInteger(data.eventVersion) || data.eventVersion < 0) return 'data.eventVersion';
  if (event.type.endsWith('.created') && data.state !== 'active') return 'data.state';
  return null;
}

export function createWebhookHandler({ targetUri, resolveSigningKey, eventIds, connector, logger, now = () => Date.now() }) {
  /**
   * Handle one delivery. `headers` are lowercased; `rawBody` is the exact
   * request bytes. Returns the response plus `work`, the accepted event's
   * processing promise (null when nothing was started).
   */
  return async function handleDelivery({ method, headers, rawBody }) {
    const reject = (status, code) => {
      logger.warn('webhook rejected', { status, code, requestId: headers['tot-request-id'] });
      return { status, body: { accepted: false, code }, work: null };
    };
    if (method !== 'POST') return reject(405, 'method_not_allowed');

    const digest = verifyContentDigest(headers['content-digest'], rawBody);
    if (!digest.ok) return reject(400, digest.code);

    const signature = await verifyMessageSignature({ method, targetUri, headers, resolveKey: resolveSigningKey, now: now() });
    if (!signature.ok) return reject(401, signature.code);

    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reject(400, 'body_not_json');
    }
    const problem = envelopeProblem(event);
    if (problem) return reject(400, `envelope_invalid:${problem}`);

    if (eventIds.has(event.id)) {
      logger.info('duplicate delivery ignored', { eventId: event.id, retrycount: event.retrycount });
      return { status: 200, body: { accepted: true, duplicate: true }, work: null };
    }
    eventIds.add(event.id);

    if (!FULFILLMENT_TYPES.has(event.type)) {
      logger.info('event type not handled by this connector', { eventId: event.id, type: event.type });
      return { status: 202, body: { accepted: true }, work: null };
    }
    logger.info('delivery accepted', { eventId: event.id, type: event.type, orderId: event.data.orderId, state: event.data.state, keyid: signature.keyid });
    const work = connector.onAssignmentEvent(event).catch((err) => {
      logger.error('processing failed; the reconciliation pass will retry', { eventId: event.id, ...errorFields(err) });
      return { status: 'error' };
    });
    return { status: 202, body: { accepted: true }, work };
  };
}

/** node:http adapter: read the raw body, call the handler, answer, then let the work run. */
export function nodeRequestListener(handleDelivery, logger) {
  return (req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
      try {
        const result = await handleDelivery({ method: req.method, headers, rawBody: Buffer.concat(chunks) });
        res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(result.body));
        await result.work;
      } catch (err) {
        logger.error('webhook handler error', errorFields(err));
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
  };
}
