// Cloudflare Workers entry point. The same app as server.js: `fetch` receives
// signed deliveries on WEBHOOK_PUBLIC_URL's path, and the cron trigger runs
// the reconciliation pass that recovers late or lost deliveries.
//
// Sample limitation: the seen-event-id set and the assignment state live in
// this isolate's memory. Each isolate keeps its own copy and loses it on
// eviction, so dedupe and in-flight state are per isolate. The gateway's
// Idempotency-Key replay keeps a re-run harmless; a production connector
// persists both (they carry no contact).
//
// Without a label provider it serves nothing: `fetch` answers 503 and
// `scheduled` logs and does no work, until LABEL_PROVIDER is "carrier" (your
// real provider) or "simulated" (fabricated labels, nothing ships).
import { Buffer } from 'node:buffer';
import { createDeployedApp } from './src/app.js';
import { readConfig } from './src/config.js';
import { LABEL_PROVIDER_HINT, LabelProviderNotConfigured } from './src/label-provider.js';
import { createLogger, errorFields } from './src/log.js';
import { MAX_BODY_BYTES } from './src/webhook.js';

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Build a Worker. Options are injection points for tests; a deploy uses the defaults. */
export function createWorker({ logger: injectedLogger, ...options } = {}) {
  let app = null;
  const baseLogger = injectedLogger ?? createLogger((line) => console.log(line));

  /** The app, or null (logged) when no label provider is configured. */
  function appFor(env) {
    if (app) return app;
    try {
      app = createDeployedApp({ env, logger: baseLogger, ...options });
    } catch (err) {
      if (!(err instanceof LabelProviderNotConfigured)) throw err;
      baseLogger.error('label provider not configured; refusing to serve', {
        code: 'label_provider_not_configured',
        reason: err.reason,
        hint: LABEL_PROVIDER_HINT,
      });
      return null;
    }
    return app;
  }

  return {
    async fetch(request, env, ctx) {
      const configured = appFor(env);
      if (!configured) return json(503, { code: 'label_provider_not_configured' });
      const { handleDelivery, logger } = configured;
      const webhookPath = new URL(readConfig(env).webhookUrl).pathname;
      if (new URL(request.url).pathname !== webhookPath) return json(404, { code: 'not_found' });
      if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json(413, { code: 'body_too_large' });
      const rawBody = Buffer.from(await request.arrayBuffer());
      if (rawBody.length > MAX_BODY_BYTES) return json(413, { code: 'body_too_large' });
      const headers = {};
      for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
      try {
        const result = await handleDelivery({ method: request.method, headers, rawBody });
        if (result.work) ctx.waitUntil(result.work);
        return json(result.status, result.body);
      } catch (err) {
        logger.error('webhook handler error', errorFields(err));
        return json(500, { code: 'internal_error' });
      }
    },

    async scheduled(controller, env, ctx) {
      const configured = appFor(env);
      if (!configured) return;
      const { connector, logger } = configured;
      ctx.waitUntil(
        connector.reconcileAll().catch((err) => logger.error('reconciliation pass failed', errorFields(err))),
      );
    },
  };
}

export default createWorker();
