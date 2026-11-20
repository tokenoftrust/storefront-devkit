// MOCK dropship platform + one supplier (a Duoplane-style service). Runs in-process on MOCK_PORT so the connector has
// something to talk to before real API keys exist. Shapes are illustrative, NOT the real
// vendor's API: read your provider's API docs before pointing PROVIDER_API_URL at it.
//
//   POST /purchase_orders                 { order_reference, shipping_address, items[{sku,quantity}] } -> { id, status }
//   GET  /purchase_orders/<id>            -> { id, status, items, shipments[], backorders[], cancelled[] }
//   POST /purchase_orders/<id>/hold       -> status on_hold: the supplier ships nothing until resumed
//   POST /purchase_orders/<id>/resume     -> back to processing; held cartons ship
//   POST /purchase_orders/<id>/cancel     -> status cancelled: unshipped cartons are cancelled
//
// Supplier behaviour (after MOCK_SHIP_SECONDS):
//   - each line with quantity > 1 ships in two cartons (exercises partial fulfilment)
//   - MOCK_BACKORDER=1 backorders every line instead of shipping
//   - MOCK_SUPPLIER_CARRIER (default UPS) is the carrier the supplier uses; USPS shows the PACT refusal
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const tracking = (carrier) => (carrier === 'USPS' ? `94001${String(Date.now()).padStart(17, '0')}` : `1Z${randomBytes(8).toString('hex').toUpperCase()}`);

export function startMockDropshipPlatform({ port, shipSeconds = 8, backorder = false, carrier = 'UPS' }) {
  const pos = new Map();
  let seq = 5000;

  function ship(po, sku, quantity) {
    if (po.status === 'cancelled') return po.cancelled.push({ sku, quantity });
    if (po.status === 'on_hold') return po.waiting.push({ sku, quantity });
    po.shipments.push({ id: ++seq, carrier, service: 'GROUND', tracking_number: tracking(carrier), items: [{ sku, quantity }], shipped_at: new Date().toISOString() });
  }

  function supplierActs(po) {
    if (po.status === 'sent') po.status = 'processing';
    for (const item of po.items) {
      if (backorder) {
        po.backorders.push({ sku: item.sku, quantity: item.quantity, reason: 'supplier out of stock' });
        continue;
      }
      const parts = item.quantity > 1 ? [Math.ceil(item.quantity / 2), Math.floor(item.quantity / 2)] : [item.quantity];
      parts.forEach((q, i) => (shipSeconds ? setTimeout(() => ship(po, item.sku, q), i * shipSeconds * 1000).unref() : ship(po, item.sku, q)));
    }
  }

  const server = createServer(async (req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      return send(400, { error: 'invalid JSON' });
    }

    if (req.method === 'POST' && req.url === '/purchase_orders') {
      if (!body.order_reference || !Array.isArray(body.items) || !body.shipping_address) return send(422, { error: 'order_reference, shipping_address and items are required' });
      const existing = [...pos.values()].find((p) => p.order_reference === body.order_reference);
      if (existing) return send(200, existing);
      const po = { id: ++seq, order_reference: body.order_reference, status: 'sent', items: body.items, shipments: [], backorders: [], cancelled: [], waiting: [] };
      pos.set(po.id, po);
      if (shipSeconds) setTimeout(() => supplierActs(po), shipSeconds * 1000).unref();
      return send(201, po);
    }

    const act = /^\/purchase_orders\/(\d+)\/(hold|resume|cancel)$/.exec(req.url);
    if (req.method === 'POST' && act) {
      const po = pos.get(Number(act[1]));
      if (!po) return send(404, { error: 'not found' });
      if (po.status === 'cancelled') return send(409, { error: 'purchase order is cancelled' });
      if (act[2] === 'hold') po.status = 'on_hold';
      if (act[2] === 'cancel') {
        po.status = 'cancelled';
        po.cancelled.push(...po.waiting.splice(0));
      }
      if (act[2] === 'resume') {
        po.status = 'processing';
        for (const w of po.waiting.splice(0)) ship(po, w.sku, w.quantity);
      }
      return send(200, po);
    }

    const m = /^\/purchase_orders\/(\d+)$/.exec(req.url);
    if (req.method === 'GET' && m) {
      const po = pos.get(Number(m[1]));
      return po ? send(200, po) : send(404, { error: 'not found' });
    }

    send(404, { error: 'not found' });
  });

  // Tests pass shipSeconds: 0 and drive the supplier by hand.
  server.supplierActs = (poId) => supplierActs(pos.get(poId));
  server.purchaseOrders = pos;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
