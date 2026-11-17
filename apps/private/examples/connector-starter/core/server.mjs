// Local HTTP server for signed Storefront webhooks.
//   POST /webhooks  -> verified by connector-kit (digest, RFC 9421 signature, replay guard), then routed by topic
//   GET  /health    -> 200, used by `npm run doctor` to check the tunnel reaches you
import { createServer } from 'node:http';
import { EVENT_TYPE_PREFIX } from '../vendor/connector-kit/index.js';
import { log, logError } from './log.mjs';

/**
 * handlers: { 'fulfillment.assignment.created': async (event) => {...}, ... }
 * A handler that throws makes the receiver answer 500, so Storefront retries the delivery.
 * Keep handlers short: acknowledge, then do slow vendor work in the background.
 */
export function startWebhookServer({ cfg, tot, handlers }) {
  const receiver = tot.receiver();
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, app: cfg.app }));
        return;
      }
      if (req.url !== '/webhooks') {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(cfg.webhookEndpoint, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
      const response = await receiver.handleRequest(request, async (event) => {
        const topic = event.type.startsWith(EVENT_TYPE_PREFIX) ? event.type.slice(EVENT_TYPE_PREFIX.length) : event.type;
        log('webhook.received', { topic, id: event.id, data: event.data });
        const handler = handlers[topic];
        if (handler) await handler(event);
      });
      if (response.status >= 400) log('webhook.refused', { status: response.status, body: await response.clone().json().catch(() => null) });
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      logError('webhook.error', err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  server.listen(cfg.port, () => log('server.listening', { port: cfg.port, endpoint: cfg.webhookEndpoint }));
  return server;
}
