// MOCK label provider (a ShipStation-style label station). Runs in-process on MOCK_PORT so the connector has something to talk to
// before real API keys exist. It is shaped like a typical label-station API for the four calls this starter
// uses; the shapes are illustrative, NOT any vendor's real API.
// Read your provider's API docs and write a real client before pointing PROVIDER_API_URL at it.
//
//   POST /orders/createorder           -> { orderId, orderNumber, orderStatus }
//   POST /orders/createlabelfororder   -> { shipmentId, orderId, trackingNumber, carrierCode, serviceCode, labelData }
//   POST /shipments/voidlabel          -> { approved, message }
//   GET  /carriers                     -> [{ code, name, services: [serviceCode] }]
//   POST /orders/holduntil             { orderId } -> order on_hold: no label, no pickup
//   POST /orders/restorefromhold       { orderId } -> order back to awaiting_shipment
//   POST /orders/cancel                { orderId } -> order cancelled (void its label first)
// Mock-only:
//   POST /_mock/pickup/<shipmentId>    -> simulates the carrier acceptance scan (not label creation / SHIP_NOTIFY)
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const CARRIERS = [
  { code: 'ups', name: 'UPS', services: ['ups_ground', 'ups_2nd_day_air'] },
  { code: 'fedex', name: 'FedEx', services: ['fedex_ground', 'fedex_2day'] },
  { code: 'stamps_com', name: 'USPS (Stamps.com)', services: ['usps_ground_advantage'] },
];

const upsTracking = () => `1Z${randomBytes(8).toString('hex').toUpperCase()}`;
const fedexTracking = () => String(Math.floor(1e11 + Math.random() * 9e11));

export function startMockLabelProvider({ port, onCarrierPickup, onShipNotify = () => {} }) {
  const notifyPickup = onCarrierPickup ?? onShipNotify;
  const orders = new Map(); // orderId -> order
  const shipments = new Map(); // shipmentId -> shipment
  let seq = 100000;

  const server = createServer(async (req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      return send(400, { Message: 'invalid JSON' });
    }

    if (req.method === 'GET' && req.url === '/carriers') return send(200, CARRIERS.map(({ code, name, services }) => ({ code, name, services })));

    const status = { '/orders/holduntil': 'on_hold', '/orders/restorefromhold': 'awaiting_shipment', '/orders/cancel': 'cancelled' }[req.url];
    if (req.method === 'POST' && status) {
      const order = orders.get(Number(body.orderId));
      if (!order) return send(404, { Message: 'order not found' });
      if (order.orderStatus === 'cancelled' && status !== 'cancelled') return send(409, { Message: 'order is cancelled' });
      order.orderStatus = status;
      return send(200, order);
    }

    if (req.method === 'POST' && req.url === '/orders/createorder') {
      if (!body.orderNumber || !Array.isArray(body.items) || !body.shipTo) return send(400, { Message: 'orderNumber, items and shipTo are required' });
      // Upsert by order number: the same order number returns the same order.
      const existing = [...orders.values()].find((o) => o.orderNumber === body.orderNumber);
      if (existing) return send(200, existing);
      const order = { orderId: ++seq, orderNumber: body.orderNumber, orderStatus: 'awaiting_shipment', items: body.items };
      orders.set(order.orderId, order);
      return send(200, order);
    }

    if (req.method === 'POST' && req.url === '/orders/createlabelfororder') {
      const order = orders.get(Number(body.orderId));
      if (!order) return send(404, { Message: 'order not found' });
      if (order.orderStatus !== 'awaiting_shipment') return send(409, { Message: `order is ${order.orderStatus}` });
      const carrier = CARRIERS.find((c) => c.code === body.carrierCode);
      if (!carrier || !carrier.services.includes(body.serviceCode)) return send(400, { Message: `unknown carrier/service ${body.carrierCode}/${body.serviceCode}` });
      const shipment = {
        shipmentId: ++seq,
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        carrierCode: carrier.code,
        serviceCode: body.serviceCode,
        confirmation: body.confirmation ?? 'none',
        trackingNumber: carrier.code === 'fedex' ? fedexTracking() : upsTracking(),
        labelData: Buffer.from('MOCK LABEL').toString('base64'),
        voided: false,
      };
      shipments.set(shipment.shipmentId, shipment);
      return send(200, shipment);
    }

    if (req.method === 'POST' && req.url === '/shipments/voidlabel') {
      const s = shipments.get(Number(body.shipmentId));
      if (!s) return send(404, { Message: 'shipment not found' });
      s.voided = true;
      return send(200, { approved: true, message: 'Label voided successfully' });
    }

    const pickup = /^\/_mock\/pickup\/(\d+)$/.exec(req.url);
    if (req.method === 'POST' && pickup) {
      const s = shipments.get(Number(pickup[1]));
      if (!s || s.voided) return send(404, { Message: 'no live shipment' });
      if (orders.get(s.orderId)?.orderStatus !== 'awaiting_shipment') return send(409, { Message: 'order is not ready to ship' });
      send(200, { ok: true });
      notifyPickup(s);
      return;
    }

    send(404, { Message: 'not found' });
  });

  server.orders = orders;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
