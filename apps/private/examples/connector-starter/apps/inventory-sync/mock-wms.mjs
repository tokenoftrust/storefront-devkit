// MOCK warehouse system (a SkuVault-style WMS). Runs in-process on MOCK_PORT so the connector has something to
// talk to before real API keys exist. Shapes are illustrative, NOT any vendor's real API:
// read your provider's API docs before pointing PROVIDER_API_URL at it.
//
//   GET  /inventory                 -> { warehouse, asOf, items: [{ sku, quantityOnHand }] }
//   POST /_mock/pick { sku, qty }   -> simulates a pick in the warehouse (quantity goes down)
// Every MOCK_DRIFT_SECONDS one random SKU gains or loses a few units (receiving / picking).
import { createServer } from 'node:http';

export function startMockWms({ port, skus, driftSeconds = 20 }) {
  const stock = new Map(skus.map((sku, i) => [sku, 20 + i * 7]));
  let asOf = new Date().toISOString();

  setInterval(() => {
    const list = [...stock.keys()];
    const sku = list[Math.floor(Math.random() * list.length)];
    stock.set(sku, Math.max(0, stock.get(sku) + (Math.random() < 0.5 ? -3 : 5)));
    asOf = new Date().toISOString();
  }, driftSeconds * 1000).unref();

  const server = createServer(async (req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.method === 'GET' && req.url === '/inventory') {
      return send(200, { warehouse: 'MOCK-WH1', asOf, items: [...stock].map(([sku, quantityOnHand]) => ({ sku, quantityOnHand })) });
    }
    if (req.method === 'POST' && req.url === '/_mock/pick') {
      const { sku, qty = 1 } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!stock.has(sku)) return send(404, { error: 'unknown sku' });
      stock.set(sku, Math.max(0, stock.get(sku) - qty));
      asOf = new Date().toISOString();
      return send(200, { sku, quantityOnHand: stock.get(sku) });
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
