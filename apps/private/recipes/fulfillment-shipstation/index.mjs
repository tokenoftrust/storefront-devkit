#!/usr/bin/env node
// Shipping & Label Station Connector Recipe (ShipStation / PirateShip / Shippo / Regional PACT Desks):
// 1. Receives fulfillment.assignment.created / .updated CloudEvents and reconciles via GET /fulfillment/assignments.
// 2. Queries GET /fulfillment/carriers to validate PACT Act & adultSignature eligibility
//    (ups, fedex, dhl_express, ontrac, lasership, gso_gls, lso, spee_dee, stat_overnight, better_trucks)
//    and verifies USPS refusal (422 pact_carrier_ineligible / 409 carrier-prohibited) on regulated orders.
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

const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/pact-assignment.json', import.meta.url), 'utf8'),
);

/**
 * Platform carrier catalog profiles returned by `GET /api/apps/v1/fulfillment/carriers`,
 * including both the canonical uppercase `code` (`CarrierCode`) and common station slug aliases.
 */
export const PLATFORM_CARRIER_CATALOG = Object.freeze([
  { code: 'UPS', slug: 'ups', name: 'UPS', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.ups.com'] },
  { code: 'FEDEX', slug: 'fedex', name: 'FedEx', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.fedex.com'] },
  { code: 'DHL', slug: 'dhl_express', name: 'DHL Express', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.dhl.com'] },
  { code: 'USPS', slug: 'usps', name: 'USPS', region: 'US', pactEligible: false, adultSignature: 'supported', trackingHosts: ['tools.usps.com'] },
  { code: 'ONTRAC', slug: 'ontrac', aliases: ['lasership'], name: 'OnTrac / LaserShip', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.ontrac.com'] },
  { code: 'GLS_US', slug: 'gso_gls', name: 'GLS US (GSO)', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.gls-us.com'] },
  { code: 'LSO', slug: 'lso', name: 'Lone Star Overnight (LSO)', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['www.lso.com'] },
  { code: 'SPEE_DEE', slug: 'spee_dee', name: 'Spee-Dee Delivery', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['speedeedelivery.com'] },
  { code: 'STAT_OVERNIGHT', slug: 'stat_overnight', name: 'Stat Overnight Delivery', region: 'US', pactEligible: true, adultSignature: 'required', trackingHosts: ['statovernight.com'] },
  { code: 'BETTER_TRUCKS', slug: 'better_trucks', name: 'Better Trucks', region: 'US', pactEligible: true, adultSignature: 'supported', trackingHosts: ['tracking.bettertrucks.com'] },
]);

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

export function createShipStationConnector({ baseUrl, accessToken, fetchImpl = fetch }) {
  const seenEvents = new Set();

  async function request(method, path, { body, idempotencyKey } = {}) {
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${accessToken}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const res = await fetchImpl(`${baseUrl}/api/apps/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, ok: res.ok, body: await res.json() };
  }

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
 * In-memory gateway simulator supporting PACT & adultSignature carrier enforcement,
 * 1:N split-carton shipments, and whole-order shipment evidence (`label-outcome`, `label-voided`, `handoff`).
 */
export function createSimulatedShipStationGateway({ pactAct = true } = {}) {
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
      const path = url.pathname.replace(/^\/api\/apps\/v1/, '');

      if (method === 'GET' && path === '/fulfillment/carriers') {
        return json(200, { carriers: PLATFORM_CARRIER_CATALOG });
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
          return json(422, { code: 'pact_carrier_ineligible', error: 'carrier-prohibited' });
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
            return json(422, { code: 'pact_carrier_ineligible', error: 'carrier-prohibited' });
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
  const sim = createSimulatedShipStationGateway({ pactAct: true });
  const connector = createShipStationConnector({
    baseUrl: 'https://tot-preview.tokenoftrust.store',
    accessToken: 'sim-shipstation-token',
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
  const pactEligibleSlugs = carriersRes.body.carriers.filter((c) => c.pactEligible).map((c) => c.slug);
  assert.ok(pactEligibleSlugs.includes('ups'));
  assert.ok(pactEligibleSlugs.includes('fedex'));
  assert.ok(pactEligibleSlugs.includes('ontrac'));
  assert.ok(pactEligibleSlugs.includes('better_trucks'));
  assert.ok(!pactEligibleSlugs.includes('usps'));

  // 3. Hydrate ship-to recipient in memory (never logged)
  const recipientRes = await connector.readRecipient(activeAssignment.orderId);
  assert.equal(recipientRes.status, 200);
  assert.equal(recipientRes.body.city, 'Austin');

  // 4. Verify USPS is refused on a PACT-regulated order (422 pact_carrier_ineligible)
  const uspsAttempt = await connector.postAssignmentShipment(activeAssignment.assignmentId, {
    lines: [{ sku: 'VAPE-KIT-STARTER', quantity: 2 }],
    carrier: 'USPS',
    service: 'PRIORITY',
    trackingNumber: '9400100000000000000000',
    trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400100000000000000000',
    adultSignature: 'accepted',
  });
  assert.equal(uspsAttempt.status, 422);
  assert.equal(uspsAttempt.body.code, 'pact_carrier_ineligible');

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
    trackingUrl: 'https://tracking.bettertrucks.com/BT888888888882',
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
    pactCarriersCount: pactEligibleSlugs.length,
    uspsRefusedCode: uspsAttempt.body.code,
    splitShipmentsComplete: carton2.body.complete,
    replacementPurchaseId: voided.body.purchaseId,
    emittedTopics: sim.emittedTopics,
  };
}

if (process.argv.includes('--self-test') || import.meta.url === `file://${process.argv[1]}`) {
  const summary = await runSelfTest();
  console.log(JSON.stringify({ event: 'fulfillment-shipstation:self-test:passed', ...summary }));
}
