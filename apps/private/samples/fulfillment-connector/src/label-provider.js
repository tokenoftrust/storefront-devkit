// A simulated external label provider. Storefront never buys labels: the
// connector's own provider does, and the connector reports the result.
// Replace this module with your real provider client.
//
// The provider is idempotent by purchase id (a real provider takes a client
// reference for the same reason), so asking twice never buys two labels.
// `unknownOutcome: true` makes the first purchase answer "unknown" (think: a
// timeout after the provider accepted the request); `lookup` then reveals the
// label that was in fact created, which is how an unknown is reconciled.
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
      if (!SHIP_TO_REQUIRED.every((field) => typeof shipTo?.[field] === 'string' && shipTo[field] !== '')) {
        return { outcome: 'voided', reason: 'ship-to-incomplete' };
      }
      if (!Array.isArray(lineItems) || lineItems.length === 0) return { outcome: 'voided', reason: 'no-items' };
      if (!labels.has(purchaseId)) {
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

    /** Reconcile an earlier purchase without buying again. */
    async lookup(purchaseId) {
      return labels.has(purchaseId) ? { ...labels.get(purchaseId) } : { outcome: 'unknown' };
    },

    /** The carrier's acceptance scan for the parcel. */
    async handoff(purchaseId) {
      const label = labels.get(purchaseId);
      return label ? { accepted: true, carrier: label.carrier } : { accepted: false };
    },
  };
}
