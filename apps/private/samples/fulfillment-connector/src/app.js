// Wires the pieces together. `fetchImpl` is injectable so the same app runs
// against the real gateway (server.js, worker.js) or the local simulator
// (demo.js, tests). The label provider is always passed in: there is no
// default, so nothing reports a fabricated label by omission.
//
// The deployed app (server.js, worker.js) is preview-bound: createDeployedApp
// wraps the fetch in the one scoped preview transport, with no opt-out.
import { loadConfig } from './config.js';
import { createConnector } from './connector.js';
import { createGatewayClient } from './gateway-client.js';
import { createGatewayMetadata } from './gateway-metadata.js';
import { SIMULATED_LABELS_FIELDS, selectLabelProvider } from './label-provider.js';
import { createLogger, withFields } from './log.js';
import { createPreviewFetch } from './preview-transport.js';
import { createEventIdStore, createWebhookHandler } from './webhook.js';

export function createConnectorApp({
  baseUrl,
  clientId,
  clientSecret,
  webhookUrl,
  simulate = {},
  fetchImpl = (...args) => fetch(...args),
  logger = createLogger(),
  labelProvider,
  now = () => Date.now(),
  sleep,
}) {
  if (!labelProvider) {
    throw new TypeError(
      'createConnectorApp needs a labelProvider: pass your real provider (see createCarrierLabelProvider in ' +
        'src/label-provider.js), or createSimulatedLabelProvider() in a demo or test',
    );
  }
  const metadata = createGatewayMetadata({ baseUrl, fetchImpl, now });
  const gateway = createGatewayClient({ baseUrl, clientId, clientSecret, metadata, fetchImpl, logger, now, sleep });
  const connector = createConnector({ gateway, labelProvider, logger, simulate });
  const handleDelivery = createWebhookHandler({
    targetUri: webhookUrl,
    resolveSigningKey: metadata.resolveSigningKey,
    eventIds: createEventIdStore(),
    connector,
    logger,
    now,
  });
  return { handleDelivery, connector, logger };
}

/**
 * The app as server.js and worker.js run it: configuration from `env`, and the
 * label provider from `LABEL_PROVIDER` unless one is injected. Throws
 * ConfigRefused on any configuration refusal and LabelProviderNotConfigured
 * when no provider is wired. The simulator runs only on
 * LABEL_PROVIDER=simulated, and then every log line says so.
 *
 * Every outbound request goes through ONE scoped fetch built around `fetchImpl`
 * (the platform fetch unless a test injects one). The client secret and the
 * preview capability reach only the closures that send them; the returned
 * `config` carries neither.
 */
export function createDeployedApp({ env, logger, labelProvider, simulate = {}, fetchImpl = (...args) => fetch(...args), now = () => Date.now(), ...options }) {
  const { config, clientSecret, preview } = loadConfig(env);
  const selected = labelProvider
    ? { provider: labelProvider, simulated: false }
    : selectLabelProvider(env, { unknownOutcome: simulate.unknownLabelOutcome });
  const appLogger = selected.simulated ? withFields(logger, SIMULATED_LABELS_FIELDS) : logger;
  if (selected.simulated) appLogger.warn('simulated label provider in use: no label is bought and nothing ships');
  const scopedFetch = createPreviewFetch({ origin: config.baseUrl, capability: preview.capability, expiresAtMs: preview.expiresAtMs, fetchImpl, now });
  const app = createConnectorApp({ ...config, ...options, clientSecret, now, fetchImpl: scopedFetch, simulate, logger: appLogger, labelProvider: selected.provider });
  return { ...app, config, simulated: selected.simulated };
}
