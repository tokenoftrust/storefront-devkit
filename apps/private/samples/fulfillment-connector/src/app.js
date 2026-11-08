// Wires the pieces together. `fetchImpl` is injectable so the same app runs
// against the real gateway (server.js) or the local simulator (demo.js, tests).
import { createConnector } from './connector.js';
import { createGatewayClient } from './gateway-client.js';
import { createGatewayMetadata } from './gateway-metadata.js';
import { createSimulatedLabelProvider } from './label-provider.js';
import { createLogger } from './log.js';
import { createEventIdStore, createWebhookHandler } from './webhook.js';

export function createConnectorApp({
  baseUrl,
  clientId,
  clientSecret,
  webhookUrl,
  simulate = {},
  fetchImpl = fetch,
  logger = createLogger(),
  labelProvider = createSimulatedLabelProvider({ unknownOutcome: simulate.unknownLabelOutcome }),
  now = () => Date.now(),
  sleep,
}) {
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
