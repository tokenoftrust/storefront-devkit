// A simulated external label provider. Storefront never buys labels: the
// connector's own provider does, and the connector reports the result.
// Replace this module with your real provider client.
//
// The provider records every purchase by purchase id (a real provider takes a
// client reference for the same reason), so asking twice never buys two labels
// and `lookup` answers for any earlier attempt, voided ones included, without
// needing the ship-to. `unknownOutcome: true` makes the first purchase answer
// "unknown" (think: a timeout after the provider accepted the request);
// `lookup` then reveals the label that was in fact created, which is how an
// unknown is reconciled.
import { createHash } from 'node:crypto';

const SHIP_TO_REQUIRED = ['line1', 'city', 'country'];

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
