#!/usr/bin/env node
// Shipping & Label Station Connector Recipe (Multi-Carrier & Regional PACT Label Desks):
// 1. Receives fulfillment.assignment.created / .updated CloudEvents and reconciles via GET /fulfillment/assignments.
// 2. Queries GET /fulfillment/carriers to validate PACT Act & adultSignature eligibility
//    (UPS, FEDEX, DHL, ONTRAC, GLS_US, LSO, SPEE_DEE, STAT_OVERNIGHT, BETTER_TRUCKS; station slugs map
//    onto these codes) and verifies USPS refusal (409 carrier-prohibited) on regulated orders.
// 3. Hydrates the ship-to recipient in memory (GET /fulfillment/orders/{orderId}/recipient) without logging PII.
// 4. Demonstrates both fulfillment write-back patterns:
//    a) 1:N split-carton shipments via POST /fulfillment/assignments/{assignmentId}/shipments
//       (Carton 1 -> order.partially_fulfilled, Carton 2 -> order.fulfilled).
//    b) Whole-order shipment evidence via POST /fulfillment/orders/{orderId}/shipment-evidence
//       including label-outcome (purchased), label-voided (minting a fresh purchaseId), and handoff.
//
// Run offline self-test:
//   node index.mjs --self-test
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ApiClient, ApiError, AuthorizationMetadata, WebhookReceiver } from './vendor/connector-kit/index.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/pact-assignment.json', import.meta.url), 'utf8'),
);

/**
 * The platform carrier catalog (`CarrierProfile[]`) that `GET /api/apps/v1/fulfillment/carriers`
 * returns as `carriers`, each entry extended with this station's local `slug` / `aliases`. The
 * slugs are recipe-local: the wire carries only the uppercase `code` (`CarrierCode`).
 */
export const PLATFORM_CARRIER_CATALOG = Object.freeze([
  { code: 'UPS', slug: 'ups', name: 'UPS', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.ups.com'] },
  { code: 'FEDEX', slug: 'fedex', name: 'FedEx', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.fedex.com'] },
  { code: 'USPS', slug: 'usps', name: 'USPS', region: 'US', pactEligible: false, adultSignature: 'supported', trackingHosts: ['tools.usps.com'] },
  { code: 'DHL', slug: 'dhl_express', name: 'DHL', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.dhl.com'] },
  { code: 'ONTRAC', slug: 'ontrac', aliases: ['lasership'], name: 'OnTrac', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.ontrac.com'] },
  { code: 'LSO', slug: 'lso', name: 'Lone Star Overnight', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.lso.com'] },
  { code: 'BETTER_TRUCKS', slug: 'better_trucks', name: 'Better Trucks', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.bettertrucks.com'] },
  { code: 'GLS_US', slug: 'gso_gls', name: 'GLS US', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.gls-us.com'] },
  { code: 'SPEE_DEE', slug: 'spee_dee', name: 'Spee-Dee Delivery', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.speedeedelivery.com'] },
  { code: 'STAT_OVERNIGHT', slug: 'stat_overnight', name: 'Stat Overnight', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.statovernight.com'] },
]);

/** The `CarrierCatalog` body `GET /fulfillment/carriers` answers for a store with this policy. */
export function carrierCatalogResponse({ pactEnabled, adultSignatureRequired }) {
  const carriers = PLATFORM_CARRIER_CATALOG.map(({ slug, aliases, ...profile }) => profile);
  const allowedCarriers = carriers
    .filter((c) => (!pactEnabled || c.pactEligible) && (!adultSignatureRequired || c.adultSignature !== 'unsupported'))
    .map((c) => c.code);
  return { carriers, allowedCarriers, pactEnabled, adultSignatureRequired };
}

export function resolveCarrierProfile(carrierInput, catalog = PLATFORM_CARRIER_CATALOG) {
  const normalized = String(carrierInput ?? '').trim().toLowerCase();
  return (
    catalog.find(
      (c) =>
        c.code.toLowerCase() === normalized ||
        c.slug === normalized ||
        (Array.isArray(c.aliases) && c.aliases.includes(normalized)),
    ) ?? null
  );
}

export function deriveIdempotencyKey(prefix, payload) {
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 36);
  return `${prefix}-${digest}`;
}

/**
 * One `/api/apps/v1` call through the vendored connector-kit `ApiClient` (retries, `Retry-After`,
 * `Idempotency-Key`). A non-2xx answer resolves `{ status, ok: false, body: { code } }`.
 */
function createRequest({ baseUrl, tenant, tenantId, accessToken, auth, fetchImpl }) {
  const store = tenant ?? tenantId;
  const api = new ApiClient({
    origin: baseUrl,
    ...(store ? { tenant: store } : {}),
    auth: auth ?? { getAccessToken: async () => accessToken },
    fetch: fetchImpl,
  });
  return async function request(method, path, { query, body, idempotencyKey } = {}) {
    try {
      const res = await api.request({ method, path, query, body, idempotencyKey });
      return { status: res.status, ok: true, body: res.body };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, ok: false, body: { code: err.code } };
      throw err;
    }
  };
}

export function createLabelStationConnector({ baseUrl, tenant, tenantId, accessToken, auth, fetchImpl = fetch }) {
  const seenEvents = new Set();

  const request = createRequest({ baseUrl, tenant, tenantId, accessToken, auth, fetchImpl });

  return {
    listCarriers() {
      return request('GET', '/fulfillment/carriers');
    },
    listAssignments() {
      return request('GET', '/fulfillment/assignments');
    },
    /** Reads the ship-to recipient (`no-store`). Callers must never log or persist recipient PII. */
    readRecipient(orderId) {
      return request('GET', `/fulfillment/orders/${encodeURIComponent(orderId)}/recipient`);
    },
    postAssignmentShipment(assignmentId, shipmentWrite, idempotencyKey = deriveIdempotencyKey(`ship-${assignmentId}`, shipmentWrite)) {
      return request('POST', `/fulfillment/assignments/${encodeURIComponent(assignmentId)}/shipments`, {
        body: shipmentWrite,
        idempotencyKey,
      });
    },
    postWholeOrderEvidence(orderId, evidenceWrite, idempotencyKey = deriveIdempotencyKey(`ev-${orderId}`, evidenceWrite)) {
      return request('POST', `/fulfillment/orders/${encodeURIComponent(orderId)}/shipment-evidence`, {
        body: evidenceWrite,
        idempotencyKey,
      });
    },
    handleAssignmentWebhook(event) {
      if (seenEvents.has(event.id)) return { duplicate: true, state: null };
      seenEvents.add(event.id);
      return {
        duplicate: false,
        assignmentId: event.data.assignmentId,
        orderId: event.data.orderId,
        stage: event.data.stage,
        state: event.data.state,
      };
    },
  };
}

/**
 * Verifies a delivery (body digest, RFC 9421 signature, replay guard) with the vendored
 * connector-kit `WebhookReceiver`, then hands only verified, first-seen events to the connector.
 * `endpoint` is the registered `webhooks.endpoint` exactly as written in `tot-app.json`.
 */
export function createLabelStationWebhookReceiver({
  origin,
  endpoint,
  connector,
  tenant,
  appInstallId,
  keys = new AuthorizationMetadata({ origin }),
  seenEvents,
}) {
  const receiver = new WebhookReceiver({
    endpoint,
    keys,
    seenEvents,
    ...(tenant ? { tenant } : {}),
    ...(appInstallId ? { appInstallId } : {}),
  });
  return {
    handleRequest: (request) =>
      receiver.handleRequest(request, async (event) => {
        connector.handleAssignmentWebhook(event);
      }),
  };
}

/**
 * In-memory gateway simulator supporting PACT & adultSignature carrier enforcement,
 * 1:N split-carton shipments, and whole-order shipment evidence (`label-outcome`, `label-voided`, `handoff`).
 */
export function createSimulatedLabelStationGateway({ pactAct = true } = {}) {
  const assignment = structuredClone(FIXTURE.assignment);
  const recipient = structuredClone(FIXTURE.recipient);
  const emittedTopics = [];
  let wholeOrderLabel = 'intent';
  let wholeOrderHandoff = 'none';
  let purchaseSeq = 1;
  let lastFacts = null;

  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

  return {
    emittedTopics,
    async fetchImpl(input, init = {}) {
      const url = new URL(input);
      const method = (init.method ?? 'GET').toUpperCase();
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const path = url.pathname.replace(/^(?:\/[^/]+)?\/api\/apps\/v1/, '');

      if (method === 'GET' && path === '/fulfillment/carriers') {
        return json(200, carrierCatalogResponse({ pactEnabled: pactAct, adultSignatureRequired: assignment.adultSignatureRequired }));
      }

      if (method === 'GET' && path === '/fulfillment/assignments') {
        return json(200, { assignments: [assignment] });
      }

      const recipientMatch = /^\/fulfillment\/orders\/([^/]+)\/recipient$/.exec(path);
      if (method === 'GET' && recipientMatch) {
        if (decodeURIComponent(recipientMatch[1]) !== assignment.orderId) {
          return json(404, { code: 'not-assigned', error: 'not-assigned' });
        }
        return json(200, recipient);
      }

      const shipmentMatch = /^\/fulfillment\/assignments\/([^/]+)\/shipments$/.exec(path);
      if (method === 'POST' && shipmentMatch) {
        if (!headers['idempotency-key']) return json(400, { code: 'malformed', error: 'malformed' });
        if (decodeURIComponent(shipmentMatch[1]) !== assignment.assignmentId) {
          return json(404, { code: 'not-assigned', error: 'not-assigned' });
        }
        const body = JSON.parse(init.body);
        const profile = resolveCarrierProfile(body.carrier);
        if (!profile) return json(400, { code: 'malformed', error: 'malformed' });
        if (pactAct && !profile.pactEligible) {
          return json(409, { code: 'carrier-prohibited', error: 'carrier-prohibited' });
        }
        if (assignment.adultSignatureRequired && body.adultSignature !== 'accepted') {
          return json(409, { code: 'adult-signature', error: 'adult-signature' });
        }
        for (const reqLine of body.lines) {
          const line = assignment.lines.find((l) => l.sku === reqLine.sku);
          if (!line) return json(409, { code: 'line-unknown', error: 'line-unknown' });
          if (reqLine.quantity > line.remaining) {
            return json(409, { code: 'quantity-exceeded', error: 'quantity-exceeded' });
          }
          line.shipped += reqLine.quantity;
          line.remaining = line.quantity - line.shipped - line.cancelled;
        }
        const complete = assignment.lines.every((l) => l.remaining === 0);
        emittedTopics.push(complete ? 'order.fulfilled' : 'order.partially_fulfilled');
        return json(200, {
          assignmentId: assignment.assignmentId,
          shipmentId: `shp_${randomUUID().slice(0, 10)}`,
          fulfilledLines: body.lines,
          complete,
        });
      }

      const evidenceMatch = /^\/fulfillment\/orders\/([^/]+)\/shipment-evidence$/.exec(path);
      if (method === 'POST' && evidenceMatch) {
        if (!headers['idempotency-key']) return json(400, { code: 'malformed', error: 'malformed' });
        const body = JSON.parse(init.body);
        if (body.assignmentId !== assignment.assignmentId) {
          return json(409, { code: 'assignment-ended', error: 'assignment-ended' });
        }
        if (body.purchaseId !== assignment.purchaseId) {
          return json(409, { code: 'conflict', error: 'conflict' });
        }

        if (body.kind === 'label-outcome' || body.kind === 'label-purchased') {
          const profile = resolveCarrierProfile(body.carrier);
          if (!profile) return json(400, { code: 'malformed', error: 'malformed' });
          if (pactAct && !profile.pactEligible) {
            return json(409, { code: 'carrier-prohibited', error: 'carrier-prohibited' });
          }
          wholeOrderLabel = 'purchased';
          lastFacts = {
            carrier: profile.code,
            tracking: { number: body.trackingNumber, url: body.trackingUrl },
          };
          assignment.eventVersion += 1;
          return json(200, {
            orderId: assignment.orderId,
            version: assignment.eventVersion,
            label: wholeOrderLabel,
            handoff: wholeOrderHandoff,
            purchaseId: assignment.purchaseId,
            ...lastFacts,
          });
        }

        if (body.kind === 'label-voided') {
          if (wholeOrderLabel !== 'purchased') {
            return json(409, { code: 'label', error: 'label' });
          }
          wholeOrderLabel = 'none';
          lastFacts = null;
          purchaseSeq += 1;
          assignment.purchaseId = `pur_PACT9001_A${purchaseSeq}`;
          assignment.eventVersion += 1;
          return json(200, {
            orderId: assignment.orderId,
            version: assignment.eventVersion,
            label: 'none',
            handoff: wholeOrderHandoff,
            purchaseId: assignment.purchaseId,
          });
        }

        if (body.kind === 'handoff' || body.kind === 'handed-off') {
          if (wholeOrderLabel !== 'purchased') {
            return json(409, { code: 'label', error: 'label', holds: ['label'] });
          }
          wholeOrderHandoff = 'handed_off';
          assignment.eventVersion += 1;
          emittedTopics.push('order.fulfilled');
          return json(200, {
            orderId: assignment.orderId,
            version: assignment.eventVersion,
            label: wholeOrderLabel,
            handoff: wholeOrderHandoff,
            purchaseId: assignment.purchaseId,
            ...lastFacts,
          });
        }
      }

      return json(404, { code: 'not-assigned', error: 'not-assigned' });
    },
  };
}

export async function runSelfTest() {
  const sim = createSimulatedLabelStationGateway({ pactAct: true });
  const connector = createLabelStationConnector({
    baseUrl: 'https://storefront.tokenoftrust.store',
    tenant: 'acme',
    accessToken: 'sim-label-station-token',
    fetchImpl: sim.fetchImpl,
  });

  // 1. Handle fulfillment.assignment.created webhook and reconcile GET /fulfillment/assignments
  const webhookRes = connector.handleAssignmentWebhook(FIXTURE.assignmentEvent);
  assert.equal(webhookRes.duplicate, false);

  const assignmentsRes = await connector.listAssignments();
  assert.equal(assignmentsRes.status, 200);
  const activeAssignment = assignmentsRes.body.assignments[0];
  assert.equal(activeAssignment.adultSignatureRequired, true);

  // 2. Inspect GET /fulfillment/carriers for PACT & adult-signature eligibility
  const carriersRes = await connector.listCarriers();
  assert.equal(carriersRes.status, 200);
  const { allowedCarriers, pactEnabled } = carriersRes.body;
  assert.equal(pactEnabled, true);
  assert.equal(carriersRes.body.carriers.length, PLATFORM_CARRIER_CATALOG.length);
  for (const code of ['UPS', 'FEDEX', 'ONTRAC', 'BETTER_TRUCKS']) assert.ok(allowedCarriers.includes(code));
  assert.ok(!allowedCarriers.includes('USPS'));
  assert.equal(resolveCarrierProfile('lasership').code, 'ONTRAC');

  // 3. Hydrate ship-to recipient in memory (never logged)
  const recipientRes = await connector.readRecipient(activeAssignment.orderId);
  assert.equal(recipientRes.status, 200);
  assert.equal(recipientRes.body.city, 'Austin');

  // 4. Verify USPS is refused on a PACT-regulated order (409 carrier-prohibited)
  const uspsAttempt = await connector.postAssignmentShipment(activeAssignment.assignmentId, {
    lines: [{ sku: 'VAPE-KIT-STARTER', quantity: 2 }],
    carrier: 'USPS',
    service: 'PRIORITY',
    trackingNumber: '9400100000000000000000',
    trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000000',
    adultSignature: 'accepted',
  });
  assert.equal(uspsAttempt.status, 409);
  assert.equal(uspsAttempt.body.code, 'carrier-prohibited');

  // 5. Execute 1:N split-carton shipments with PACT-eligible carriers (UPS + Better Trucks)
  const carton1 = await connector.postAssignmentShipment(activeAssignment.assignmentId, {
    lines: [{ sku: 'VAPE-KIT-STARTER', quantity: 2 }],
    carrier: 'UPS',
    service: 'GROUND_ADULT_SIG',
    trackingNumber: '1Z9999999999999991',
    trackingUrl: 'https://www.ups.com/track?tracknum=1Z9999999999999991',
    adultSignature: 'accepted',
  });
  assert.equal(carton1.status, 200);
  assert.equal(carton1.body.complete, false);

  const carton2 = await connector.postAssignmentShipment(activeAssignment.assignmentId, {
    lines: [{ sku: 'PODS-MENTHOL-4PK', quantity: 3 }],
    carrier: 'BETTER_TRUCKS',
    service: 'NEXT_DAY_ADULT',
    trackingNumber: 'BT888888888882',
    trackingUrl: 'https://www.bettertrucks.com/track/BT888888888882',
    adultSignature: 'accepted',
  });
  assert.equal(carton2.status, 200);
  assert.equal(carton2.body.complete, true);

  // 6. Demonstrate whole-order label-outcome -> label-voided (minting new purchaseId) -> replacement label -> handoff
  const label1 = await connector.postWholeOrderEvidence(activeAssignment.orderId, {
    kind: 'label-outcome',
    assignmentId: activeAssignment.assignmentId,
    purchaseId: 'pur_PACT9001_A1',
    outcome: 'purchased',
    carrier: 'FEDEX',
    service: 'GROUND_HOME',
    trackingNumber: '794600000001',
    trackingUrl: 'https://www.fedex.com/fedextrack/?trknbr=794600000001',
    adultSignature: 'accepted',
  });
  assert.equal(label1.status, 200);

  const voided = await connector.postWholeOrderEvidence(activeAssignment.orderId, {
    kind: 'label-voided',
    assignmentId: activeAssignment.assignmentId,
    purchaseId: 'pur_PACT9001_A1',
  });
  assert.equal(voided.status, 200);
  assert.equal(voided.body.label, 'none');
  assert.equal(voided.body.purchaseId, 'pur_PACT9001_A2');

  const label2 = await connector.postWholeOrderEvidence(activeAssignment.orderId, {
    kind: 'label-outcome',
    assignmentId: activeAssignment.assignmentId,
    purchaseId: voided.body.purchaseId,
    outcome: 'purchased',
    carrier: 'UPS',
    service: 'GROUND',
    trackingNumber: '1Z9999999999999999',
    trackingUrl: 'https://www.ups.com/track?tracknum=1Z9999999999999999',
    adultSignature: 'accepted',
  });
  assert.equal(label2.status, 200);

  const handoff = await connector.postWholeOrderEvidence(activeAssignment.orderId, {
    kind: 'handoff',
    assignmentId: activeAssignment.assignmentId,
    purchaseId: voided.body.purchaseId,
    carrier: 'UPS',
  });
  assert.equal(handoff.status, 200);
  assert.equal(handoff.body.handoff, 'handed_off');

  return {
    ok: true,
    pactCarriersCount: allowedCarriers.length,
    uspsRefusedCode: uspsAttempt.body.code,
    splitShipmentsComplete: carton2.body.complete,
    replacementPurchaseId: voided.body.purchaseId,
    emittedTopics: sim.emittedTopics,
  };
}

if (process.argv.includes('--self-test') || import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runSelfTest();
  console.log(JSON.stringify({ event: 'fulfillment-label-station:self-test:passed', ...summary }));
}
