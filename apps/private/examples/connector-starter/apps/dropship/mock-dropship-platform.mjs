// MOCK dropship platform + one supplier (a Duoplane-style service). Runs in-process on MOCK_PORT so the connector has
// something to talk to before real API keys exist. Shapes are illustrative, NOT the real
// vendor's API: read your provider's API docs before pointing PROVIDER_API_URL at it.
//
//   POST /purchase_orders                 { order_reference, shipping_address, items[{sku,quantity}] } -> { id, status }
//   GET  /purchase_orders/<id>            -> { id, status, items, shipments[], backorders[] }
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

  function supplierActs(po) {
    po.status = 'processing';
    for (const item of po.items) {
      if (backorder) {
        po.backorders.push({ sku: item.sku, quantity: item.quantity, reason: 'supplier out of stock' });
        continue;
      }
      const parts = item.quantity > 1 ? [Math.ceil(item.quantity / 2), Math.floor(item.quantity / 2)] : [item.quantity];
      parts.forEach((q, i) =>
        setTimeout(() => {
          po.shipments.push({ id: ++seq, carrier, service: 'GROUND', tracking_number: tracking(carrier), items: [{ sku: item.sku, quantity: q }], shipped_at: new Date().toISOString() });
        }, i * shipSeconds * 1000),
      );
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
      const po = { id: ++seq, order_reference: body.order_reference, status: 'sent', items: body.items, shipments: [], backorders: [] };
      pos.set(po.id, po);
      setTimeout(() => supplierActs(po), shipSeconds * 1000);
      return send(201, po);
    }

    const m = /^\/purchase_orders\/(\d+)$/.exec(req.url);
    if (req.method === 'GET' && m) {
      const po = pos.get(Number(m[1]));
      return po ? send(200, po) : send(404, { error: 'not found' });
    }

    send(404, { error: 'not found' });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
