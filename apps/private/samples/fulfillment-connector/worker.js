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
//
// Configuration is read on every request. A refused configuration (a missing
// value, or a TOT_STOREFRONT_BASE_URL without one valid preview capability)
// makes `fetch` answer a fixed 503 config_invalid and `scheduled` log and make
// no outbound request. Neither echoes any configured value.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createDeployedApp } from './src/app.js';
import { ConfigRefused, readConfig } from './src/config.js';
import { LABEL_PROVIDER_HINT, LabelProviderNotConfigured } from './src/label-provider.js';
import { createLogger, errorFields } from './src/log.js';
import { MAX_BODY_BYTES } from './src/webhook.js';

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Build a Worker. Options are injection points for tests; a deploy uses the defaults. */
const CONFIG_KEYS = ['TOT_APP_CLIENT_ID', 'TOT_APP_CLIENT_SECRET', 'TOT_STOREFRONT_BASE_URL', 'WEBHOOK_PUBLIC_URL', 'LABEL_PROVIDER'];
/** Identifies a configuration without holding its values. */
const fingerprint = (env) => createHash('sha256').update(JSON.stringify(CONFIG_KEYS.map((k) => env[k] ?? null))).digest('hex');

export function createWorker({ logger: injectedLogger, ...options } = {}) {
  let app = null;
  let appKey = null;
  const baseLogger = injectedLogger ?? createLogger((line) => console.log(line));

  /** `{ app, config }`, or `{ refused: code }` (logged) when configuration or the label provider refuses. */
  function appFor(env) {
    let config;
    try {
      config = readConfig(env);
    } catch (err) {
      if (!(err instanceof ConfigRefused)) throw err;
      baseLogger.error('configuration refused; refusing to serve', { code: err.code, variable: err.variable });
      return { refused: err.code };
    }
    const key = fingerprint(env);
    if (app && appKey === key) return { app, config };
    try {
      app = createDeployedApp({ env, logger: baseLogger, ...options });
      appKey = key;
    } catch (err) {
      if (!(err instanceof LabelProviderNotConfigured)) throw err;
      baseLogger.error('label provider not configured; refusing to serve', {
        code: 'label_provider_not_configured',
        reason: err.reason,
        hint: LABEL_PROVIDER_HINT,
      });
      return { refused: 'label_provider_not_configured' };
    }
    return { app, config };
  }

  return {
    async fetch(request, env, ctx) {
      const configured = appFor(env);
      if (configured.refused) return json(503, { code: configured.refused });
      const { handleDelivery, logger } = configured.app;
      const webhookPath = new URL(configured.config.webhookUrl).pathname;
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
      if (configured.refused) return;
      const { connector, logger } = configured.app;
      ctx.waitUntil(
        connector.reconcileAll().catch((err) => logger.error('reconciliation pass failed', errorFields(err))),
      );
    },
  };
}

export default createWorker();
