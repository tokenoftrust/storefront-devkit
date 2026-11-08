// Label providers. Storefront never buys labels: the connector's own provider
// does, and the connector reports the result.
//
// The deployed entry points (server.js, worker.js) take their provider from
// `LABEL_PROVIDER`, and nothing else:
//   carrier    your real provider, built by createCarrierLabelProvider below.
//   simulated  the simulator: labels are fabricated and nothing ships.
// Unset or any other value is refused, so a deploy never falls back to the
// simulator.
//
// A provider is { purchase, lookup, handoff } (see the simulator for the exact
// shapes). It records every purchase under its purchase id, so asking twice
// never buys two labels and `lookup` answers for any earlier attempt, voided
// ones included, without needing the ship-to. A real provider persists those
// records (or asks the carrier by client reference) so `lookup` still answers
// after a restart; the simulator holds them in memory only.
import { createHash } from 'node:crypto';

const SHIP_TO_REQUIRED = ['line1', 'city', 'country'];

export const LABEL_PROVIDER_HINT =
  'implement createCarrierLabelProvider in src/label-provider.js and set LABEL_PROVIDER=carrier, ' +
  'or set LABEL_PROVIDER=simulated to run with fabricated labels that never ship';

/** Added to every log line while the simulator is in use. */
export const SIMULATED_LABELS_FIELDS = Object.freeze({
  simulatedLabels: 'LABEL_PROVIDER=simulated: labels are fabricated and nothing ships',
});

const NOT_CONFIGURED = {
  unset: 'LABEL_PROVIDER is not set',
  'unknown-value': 'LABEL_PROVIDER is neither "carrier" nor "simulated"',
  'not-implemented': 'createCarrierLabelProvider is not implemented',
};

/** No usable label provider. The message is fixed by this sample, so it is safe to print. */
export class LabelProviderNotConfigured extends Error {
  constructor(reason) {
    super(`${NOT_CONFIGURED[reason]}: ${LABEL_PROVIDER_HINT}`);
    this.name = 'LabelProviderNotConfigured';
    this.reason = reason;
  }
}

/** The provider the deployed entry points use, chosen by `env.LABEL_PROVIDER`. */
export function selectLabelProvider(env, { unknownOutcome = false } = {}) {
  const choice = env.LABEL_PROVIDER;
  if (choice === 'carrier') return { provider: createCarrierLabelProvider(env), simulated: false };
  if (choice === 'simulated') return { provider: createSimulatedLabelProvider({ unknownOutcome }), simulated: true };
  throw new LabelProviderNotConfigured(choice ? 'unknown-value' : 'unset');
}

/**
 * Plug your real provider in here. Return { purchase, lookup, handoff } with the
 * simulator's shapes, backed by your carrier account and configured from `env`
 * (Worker secrets or environment variables):
 *   purchase({ purchaseId, shipTo, lineItems })  buy once per purchaseId; use
 *       shipTo for this call only, never store, return or log it.
 *   lookup(purchaseId)  the outcome of an earlier attempt, or null when none was
 *       made; must answer after a restart, so persist by purchaseId.
 *   handoff(purchaseId)  { accepted: true, carrier } only after the carrier's
 *       real acceptance scan.
 */
export function createCarrierLabelProvider(_env) {
  throw new LabelProviderNotConfigured('not-implemented');
}

// `unknownOutcome: true` makes the first purchase answer "unknown" (think: a
// timeout after the provider accepted the request); `lookup` then reveals the
// label that was in fact created, which is how an unknown is reconciled.

export function createSimulatedLabelProvider({ unknownOutcome = false, carrier = 'UPS', service = 'GROUND' } = {}) {
  const labels = new Map();

  function trackingFor(purchaseId) {
    const number = `SIM${createHash('sha256').update(purchaseId).digest('hex').slice(0, 17).toUpperCase()}`;
    return { number, url: `https://www.ups.com/track?tracknum=${number}` };
  }

  return {
    /**
     * Buy the whole-order label. `shipTo` is used for this call only and is
     * never stored, returned or logged by the provider.
     */
    async purchase({ purchaseId, shipTo, lineItems }) {
      if (labels.has(purchaseId)) return { ...labels.get(purchaseId) };
      if (!SHIP_TO_REQUIRED.every((field) => typeof shipTo?.[field] === 'string' && shipTo[field] !== '')) {
        labels.set(purchaseId, { outcome: 'voided', reason: 'ship-to-incomplete' });
      } else if (!Array.isArray(lineItems) || lineItems.length === 0) {
        labels.set(purchaseId, { outcome: 'voided', reason: 'no-items' });
      } else {
        const tracking = trackingFor(purchaseId);
        labels.set(purchaseId, {
          outcome: 'purchased',
          carrier,
          service,
          trackingNumber: tracking.number,
          trackingUrl: tracking.url,
          adultSignature: 'accepted',
        });
        if (unknownOutcome) return { outcome: 'unknown' };
      }
      return { ...labels.get(purchaseId) };
    },

    /**
     * Reconcile without buying: the outcome of an earlier purchase under this
     * id (`purchased`, `voided` or `unknown`), or null when none was attempted.
     */
    async lookup(purchaseId) {
      return labels.has(purchaseId) ? { ...labels.get(purchaseId) } : null;
    },

    /** The carrier's acceptance scan for the parcel. */
    async handoff(purchaseId) {
      const label = labels.get(purchaseId);
      return label?.outcome === 'purchased' ? { accepted: true, carrier: label.carrier } : { accepted: false };
    },
  };
}
