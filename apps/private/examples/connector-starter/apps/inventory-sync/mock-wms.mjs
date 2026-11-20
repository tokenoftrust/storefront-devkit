// MOCK warehouse system (a SkuVault-style WMS). Runs in-process on MOCK_PORT so the connector has something to
// talk to before real API keys exist. Shapes are illustrative, NOT any vendor's real API:
// read your provider's API docs before pointing PROVIDER_API_URL at it.
//
//   GET  /inventory                      -> { warehouse, asOf, lastMovement, items: [{ sku, quantityOnHand }] }
//   GET  /movements?after=<seq>          -> { movements: [{ seq, sku, quantityDelta, reason, at }], last }
//   POST /_mock/move { sku, qty, reason } -> records one movement (qty may be negative)
//   POST /_mock/pick { sku, qty }        -> shorthand for a picked movement of -qty
// Every MOCK_DRIFT_SECONDS one random SKU is received, picked, damaged or cycle-counted.
// Reasons use the WMS's own words; the connector maps them to Storefront reasons.
import { createServer } from 'node:http';

const DRIFT = [
  { reason: 'RECEIVE', delta: 5 },
  { reason: 'PICK', delta: -2 },
  { reason: 'DAMAGE', delta: -1 },
  { reason: 'CYCLE_COUNT', delta: -1 },
];

export function startMockWms({ port, skus, driftSeconds = 20 }) {
  const stock = new Map(skus.map((sku, i) => [sku, 20 + i * 7]));
  const movements = [];
  let asOf = new Date().toISOString();

  function move(sku, quantityDelta, reason) {
    const next = Math.max(0, stock.get(sku) + quantityDelta);
    const applied = next - stock.get(sku);
    if (applied === 0) return null;
    stock.set(sku, next);
    asOf = new Date().toISOString();
    const m = { seq: movements.length + 1, sku, quantityDelta: applied, reason, at: asOf };
    movements.push(m);
    return m;
  }

  if (driftSeconds) {
    setInterval(() => {
      const list = [...stock.keys()];
      const d = DRIFT[Math.floor(Math.random() * DRIFT.length)];
      move(list[Math.floor(Math.random() * list.length)], d.delta, d.reason);
    }, driftSeconds * 1000).unref();
  }

  const server = createServer(async (req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = new URL(req.url, 'http://wms.local');
    if (req.method === 'GET' && url.pathname === '/inventory') {
      // `lastMovement`: the movement seq this snapshot includes, so a sync can pair counts with movements.
      return send(200, { warehouse: 'MOCK-WH1', asOf, lastMovement: movements.length, items: [...stock].map(([sku, quantityOnHand]) => ({ sku, quantityOnHand })) });
    }
    if (req.method === 'GET' && url.pathname === '/movements') {
      const after = Number(url.searchParams.get('after') || 0);
      return send(200, { movements: movements.filter((m) => m.seq > after), last: movements.length });
    }
    if (req.method === 'POST' && (url.pathname === '/_mock/move' || url.pathname === '/_mock/pick')) {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!stock.has(body.sku)) return send(404, { error: 'unknown sku' });
      const m = url.pathname === '/_mock/pick' ? move(body.sku, -(body.qty ?? 1), 'PICK') : move(body.sku, body.qty, body.reason ?? 'ADJUST');
      return send(200, { sku: body.sku, quantityOnHand: stock.get(body.sku), movement: m });
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
