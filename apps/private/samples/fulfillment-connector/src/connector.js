// Whole-order fulfillment: reconcile, read the recipient for the assigned
// order only, buy the label through the provider, then report label-outcome
// and handoff evidence under stable Idempotency-Keys.
//
// Local state is in memory and holds only opaque ids and states. The ship-to
// recipient lives in one local variable for the duration of one label call.
// The label provider, not local state, decides whether a label was already
// attempted: every pass asks it first, so a restart never reads the recipient
// again or buys a second label for a purchase id it already knows.
import { isDeepStrictEqual } from 'node:util';
import { idempotencyKeyFor } from './gateway-client.js';
import { ConnectorError, errorFields } from './log.js';

const ENDED_CODES = new Set(['assignment-ended', 'not-assigned']);
// Refusals that repeating the same evidence cannot clear: stop retrying them.
const TERMINAL_CODES = new Set(['conflict', 'label-regress', 'carrier-mismatch']);

export function createConnector({ gateway, labelProvider, logger, simulate = {} }) {
  const assignments = new Map(); // assignmentId -> { orderId, state, label }
  const inFlight = new Map(); // orderId -> Promise

  function record(assignmentId, orderId, patch) {
    const current = assignments.get(assignmentId) ?? { orderId, state: 'active', label: 'none' };
    const next = { ...current, ...patch };
    assignments.set(assignmentId, next);
    return next;
  }

  async function post(assignment, evidence, { traceparent, key = idempotencyKeyFor(assignment.orderId, evidence) } = {}) {
    const fields = { orderId: assignment.orderId, assignmentId: assignment.assignmentId, kind: evidence.kind, idempotencyKey: key };
    const result = await gateway.postShipmentEvidence(assignment.orderId, evidence, key, { traceparent });
    if (!result.ok) {
      logger.warn('shipment evidence refused', { ...fields, status: result.status, code: result.code, holds: result.holds, requestId: result.requestId });
      return result;
    }
    logger.info('shipment evidence recorded', { ...fields, outcome: evidence.outcome, label: result.body.label, handoff: result.body.handoff, version: result.body.version });
    if (simulate.forceRetry) {
      const replay = await gateway.postShipmentEvidence(assignment.orderId, evidence, key, { traceparent });
      const matched = replay.ok && isDeepStrictEqual(replay.body, result.body);
      logger[matched ? 'info' : 'error']('forced retry with the same Idempotency-Key', { ...fields, matched, status: replay.status, code: replay.code });
    }
    return result;
  }

  function stopOnRefusal(assignment, result) {
    if (ENDED_CODES.has(result.code)) record(assignment.assignmentId, assignment.orderId, { state: 'ended' });
    if (result.code === 'assignment-held') record(assignment.assignmentId, assignment.orderId, { state: 'held' });
    if (TERMINAL_CODES.has(result.code)) record(assignment.assignmentId, assignment.orderId, { state: 'refused' });
    return { status: 'stopped', code: result.code };
  }

  /** Call the provider; a failure is logged and rethrown by class only, never by message. */
  async function providerCall(op, assignment, fn) {
    try {
      return await fn();
    } catch (err) {
      logger.error('label provider call failed', { orderId: assignment.orderId, assignmentId: assignment.assignmentId, op, code: 'label_provider_failed', ...errorFields(err) });
      throw new ConnectorError('label_provider_failed');
    }
  }

  const lookup = (assignment) => providerCall('lookup', assignment, () => labelProvider.lookup(assignment.purchaseId));

  async function obtainLabel(assignment) {
    const attempted = await lookup(assignment);
    if (attempted) {
      logger.info('label already attempted; reconciling without buying again', { orderId: assignment.orderId, purchaseId: assignment.purchaseId, outcome: attempted.outcome });
      return { label: attempted };
    }
    const recipient = await gateway.readRecipient(assignment.orderId);
    if (!recipient.ok) return { refused: recipient };
    let shipTo = recipient.body;
    try {
      const label = await providerCall('purchase', assignment, () =>
        labelProvider.purchase({ purchaseId: assignment.purchaseId, shipTo, lineItems: assignment.lineItems }),
      );
      return { label };
    } finally {
      shipTo = null; // drop the only reference to the contact
      recipient.body = null;
    }
  }

  function labelEvidence(assignment, label, expectedVersion) {
    const evidence = { kind: 'label-outcome', assignmentId: assignment.assignmentId, purchaseId: assignment.purchaseId, outcome: label.outcome };
    if (label.outcome === 'purchased') {
      Object.assign(evidence, {
        carrier: label.carrier,
        service: label.service,
        trackingNumber: label.trackingNumber,
        trackingUrl: label.trackingUrl,
        adultSignature: label.adultSignature,
      });
    }
    evidence.expectedVersion = expectedVersion;
    return evidence;
  }

  async function processAssignment(assignment, { traceparent } = {}) {
    const { assignmentId, orderId } = assignment;
    let local = record(assignmentId, orderId, {});
    if (local.state !== 'active') return { status: 'skipped', state: local.state };
    let version = assignment.eventVersion;
    let labelPostKey;

    if (local.label !== 'purchased') {
      const obtained = await obtainLabel(assignment);
      if (obtained.refused) {
        logger.warn('recipient read refused', { orderId, assignmentId, status: obtained.refused.status, code: obtained.refused.code });
        return stopOnRefusal(assignment, obtained.refused);
      }
      let label = obtained.label;
      if (label.outcome === 'unknown') {
        if (local.label !== 'unknown') {
          const result = await post(assignment, labelEvidence(assignment, label, version), { traceparent });
          if (result.ok) version = result.body.version;
          else if (result.code === 'label-regress') logger.info('the gateway already holds this label outcome; reconciling', { orderId, assignmentId });
          else return stopOnRefusal(assignment, result);
          local = record(assignmentId, orderId, { label: 'unknown' });
        }
        label = await lookup(assignment);
        if (!label || label.outcome === 'unknown') return { status: 'pending', label: 'unknown' };
      }
      const evidence = labelEvidence(assignment, label, version);
      labelPostKey = idempotencyKeyFor(orderId, evidence);
      const result = await post(assignment, evidence, { traceparent, key: labelPostKey });
      if (!result.ok) return stopOnRefusal(assignment, result);
      version = result.body.version;
      if (label.outcome === 'voided') {
        record(assignmentId, orderId, { label: 'voided', state: 'voided' });
        return { status: 'stopped', label: 'voided' };
      }
      local = record(assignmentId, orderId, { label: 'purchased' });
    }

    const scan = await labelProvider.handoff(assignment.purchaseId);
    if (!scan.accepted) return { status: 'pending', handoff: 'awaiting-carrier' };
    const handoff = { kind: 'handoff', assignmentId, purchaseId: assignment.purchaseId, carrier: scan.carrier, expectedVersion: version };

    if (simulate.conflictingKeyReuse && labelPostKey) {
      const misuse = await post(assignment, handoff, { traceparent, key: labelPostKey });
      logger[misuse.code === 'idempotency-conflict' ? 'info' : 'error']('conflicting key reuse probe', {
        orderId,
        refused: !misuse.ok,
        code: misuse.code,
      });
    }

    const result = await post(assignment, handoff, { traceparent });
    if (!result.ok) return stopOnRefusal(assignment, result);
    record(assignmentId, orderId, { state: 'done' });
    return { status: 'fulfilled', version: result.body.version };
  }

  /** Reconcile through the API, then act only on what the API says is assigned. */
  function oncePerOrder(orderId, fn) {
    if (inFlight.has(orderId)) return inFlight.get(orderId);
    const work = fn().finally(() => inFlight.delete(orderId));
    inFlight.set(orderId, work);
    return work;
  }

  function processOrder(orderId, { traceparent } = {}) {
    return oncePerOrder(orderId, async () => {
      const list = await gateway.listAssignments();
      if (!list.ok) {
        logger.warn('reconciliation read refused', { orderId, status: list.status, code: list.code });
        return { status: 'stopped', code: list.code };
      }
      const assignment = list.assignments.find((a) => a.orderId === orderId);
      if (!assignment) {
        logger.info('order not in the reconciliation read; nothing to do', { orderId });
        return { status: 'absent' };
      }
      return processAssignment(assignment, { traceparent });
    });
  }

  return {
    /** Act on a verified, deduplicated fulfillment.assignment.* event. */
    async onAssignmentEvent(event) {
      const { assignmentId, orderId, state } = event.data;
      if (state === 'held' || state === 'cancelled') {
        record(assignmentId, orderId, { state });
        logger.info('assignment state recorded', { orderId, assignmentId, state });
        return { status: state };
      }
      const local = assignments.get(assignmentId);
      if (local?.state === 'held') record(assignmentId, orderId, { state: 'active' });
      return processOrder(orderId, { traceparent: event.traceparent });
    },

    /** The recovery path for late or lost deliveries. Run it on a timer. */
    async reconcileAll() {
      const list = await gateway.listAssignments();
      if (!list.ok) {
        logger.warn('reconciliation read refused', { status: list.status, code: list.code });
        return [];
      }
      const results = [];
      for (const assignment of list.assignments) {
        if (assignments.get(assignment.assignmentId)?.state === 'held') record(assignment.assignmentId, assignment.orderId, { state: 'active' });
        results.push(await oncePerOrder(assignment.orderId, () => processAssignment(assignment)));
      }
      return results;
    },

    assignmentState: (assignmentId) => assignments.get(assignmentId),
  };
}
