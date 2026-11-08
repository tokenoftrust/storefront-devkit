// A local, in-memory stand-in for the Storefront App Gateway, built only from
// the published contract and seeded with its synthetic examples. It answers a
// `fetch`-shaped function (no socket) and signs deliveries the way the
// contract describes, so the demo and tests exercise the real code paths.
// It is a test double, not a description of how the platform is built.
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign, constants } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { contentDigestFor } from '../src/http-signature.js';

const EXAMPLES = new URL('../../../contract/examples/', import.meta.url);
export const example = (name) => JSON.parse(readFileSync(new URL(name, EXAMPLES), 'utf8'));

export const SIM_BASE_URL = 'https://acme.tokenoftrust.store';
export const SIM_WEBHOOK_URL = 'https://fulfillment.example.com/webhooks/tot';
export const SIM_CLIENT_ID = 'sim-client-id';
export const SIM_CLIENT_SECRET = 'sim-client-secret-not-a-real-secret';

const CARRIERS = new Set(['UPS', 'FEDEX', 'USPS', 'DHL']);
const LABEL_FIELDS = ['carrier', 'service', 'trackingNumber', 'trackingUrl', 'adultSignature'];

/** RFC 9421 signer used by the simulator and by tests to forge bad signatures. */
export function signDelivery({ rawBody, targetUri, privateKey, keyid, alg = 'rsa-v1_5-sha256', created = Math.floor(Date.now() / 1000), digest }) {
  const contentDigest = digest ?? contentDigestFor(rawBody);
  const params = `("@method" "@target-uri" "content-digest");created=${created};keyid="${keyid}";alg="${alg}"`;
  const base = [`"@method": POST`, `"@target-uri": ${targetUri}`, `"content-digest": ${contentDigest}`, `"@signature-params": ${params}`].join('\n');
  const signature = cryptoSign('sha256', Buffer.from(base), { key: privateKey, padding: constants.RSA_PKCS1_PADDING });
  return {
    'content-type': 'application/cloudevents+json',
    'content-digest': contentDigest,
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${signature.toString('base64')}:`,
  };
}

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'tot-request-id': `req_${randomUUID().slice(0, 12)}`, 'cache-control': 'no-store', ...extra },
  });
const refuse = (status, code, extra = {}) => json(status, { code, error: code, ...extra });

export function createLocalGateway({ assignment = example('fulfillment.assignments.response.json').assignments[0], recipient = example('fulfillment.recipient.response.json') } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyid = 'sim-webhook-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: keyid, alg: 'RS256', use: 'sig' };
  const tokens = new Set();
  const idempotency = new Map();
  const order = { version: assignment.eventVersion, label: 'intent', handoff: 'none', facts: null };
  const calls = { recipientReads: 0, evidence: [] };

  function view() {
    const v = { orderId: assignment.orderId, version: order.version, label: order.label, handoff: order.handoff, purchaseId: assignment.purchaseId };
    if (order.facts) {
      v.carrier = order.facts.carrier;
      v.tracking = { number: order.facts.trackingNumber, url: order.facts.trackingUrl };
    }
    return v;
  }

  function applyEvidence(body) {
    if (body.assignmentId !== assignment.assignmentId) return refuse(409, 'assignment-ended');
    if (body.purchaseId !== assignment.purchaseId) return refuse(409, 'conflict');
    if (body.kind === 'label-outcome') {
      const { outcome } = body;
      if (outcome === 'purchased') {
        if (!LABEL_FIELDS.every((f) => body[f] !== undefined) || !CARRIERS.has(body.carrier)) return refuse(400, 'malformed');
        const facts = Object.fromEntries(LABEL_FIELDS.map((f) => [f, body[f]]));
        if (order.label === 'purchased') {
          if (JSON.stringify(facts) !== JSON.stringify(order.facts)) return refuse(409, 'conflict');
          return json(200, view());
        }
        if (order.label === 'voided') return refuse(409, 'label-regress');
        order.facts = facts;
        order.label = 'purchased';
      } else if (outcome === 'unknown') {
        if (order.label !== 'intent') return refuse(409, 'label-regress');
        order.label = 'UNKNOWN';
      } else if (outcome === 'voided') {
        if (order.label === 'voided') return json(200, view());
        if (order.label === 'purchased') return refuse(409, 'label-regress');
        order.label = 'voided';
      } else {
        return refuse(400, 'malformed');
      }
      order.version++;
      return json(200, view());
    }
    if (body.kind === 'handoff') {
      if (!CARRIERS.has(body.carrier)) return refuse(400, 'malformed');
      if (order.label !== 'purchased') return refuse(409, 'label', { holds: ['label'] });
      if (body.carrier !== order.facts.carrier) return refuse(409, 'carrier-mismatch');
      if (order.handoff === 'handed_off') return json(200, view());
      order.handoff = 'handed_off';
      order.version++;
      return json(200, view());
    }
    return refuse(400, 'malformed');
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (url.origin !== SIM_BASE_URL) throw new TypeError(`simulator has no route for ${url.origin}`);

    if (method === 'GET' && url.pathname === '/.well-known/tot-app-authorization-metadata') {
      return json(200, {
        issuer: SIM_BASE_URL,
        token_endpoint: `${SIM_BASE_URL}/api/apps/oauth/token`,
        jwks_uri: `${SIM_BASE_URL}/.well-known/jwks.json`,
        grant_types_supported: ['client_credentials'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        webhook_signing_keys: { keys: [jwk] },
      }, { 'cache-control': 'public, max-age=300' });
    }
    if (method === 'POST' && url.pathname === '/api/apps/oauth/token') {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') !== 'client_credentials') return json(400, { error: 'unsupported_grant_type' });
      if (form.get('client_id') !== SIM_CLIENT_ID || form.get('client_secret') !== SIM_CLIENT_SECRET) return json(401, { error: 'invalid_client' });
      const token = `sim-token-${randomUUID()}`;
      tokens.add(token);
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 300, scope: 'fulfillment:process orders:read:recipient' });
    }

    const bearer = (headers.authorization ?? '').replace(/^Bearer /, '');
    if (!tokens.has(bearer)) return json(401, { code: 'invalid_token', error: 'Unauthorized' });
    const path = url.pathname.replace(/^\/api\/apps\/v1/, '');
    const orderPath = /^\/fulfillment\/orders\/([^/]+)\/(recipient|shipment-evidence)$/.exec(path);

    if (method === 'GET' && path === '/fulfillment/assignments') {
      const active = order.handoff === 'handed_off' ? [] : [{ ...assignment, eventVersion: order.version }];
      return json(200, { assignments: active });
    }
    if (!orderPath) return refuse(404, 'not-assigned');
    if (decodeURIComponent(orderPath[1]) !== assignment.orderId) return refuse(404, 'not-assigned');
    if (method === 'GET' && orderPath[2] === 'recipient') {
      calls.recipientReads++;
      return json(200, { ...recipient, orderId: assignment.orderId });
    }
    if (method === 'POST' && orderPath[2] === 'shipment-evidence') {
      const key = headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8 || key.length > 128) return refuse(400, 'malformed');
      let body;
      try {
        body = JSON.parse(init.body);
      } catch {
        return refuse(400, 'malformed');
      }
      calls.evidence.push({ key, body });
      const hash = createHash('sha256').update(JSON.stringify([body, body.assignmentId, assignment.orderId])).digest('hex');
      const prior = idempotency.get(key);
      if (prior) {
        if (prior.hash !== hash) return refuse(409, 'idempotency-conflict');
        return json(prior.status, prior.body);
      }
      const response = applyEvidence(body);
      const stored = { hash, status: response.status, body: await response.clone().json() };
      if (response.ok) idempotency.set(key, stored);
      return response;
    }
    return refuse(404, 'not-assigned');
  }

  return {
    fetch: fetchImpl,
    privateKey,
    keyid,
    calls,
    order,
    /** A signed delivery of `event` to the connector's registered endpoint. */
    deliver(event, { targetUri = SIM_WEBHOOK_URL, ...overrides } = {}) {
      const rawBody = Buffer.from(JSON.stringify(event));
      return { method: 'POST', rawBody, headers: signDelivery({ rawBody, targetUri, privateKey, keyid, ...overrides }) };
    },
  };
}
