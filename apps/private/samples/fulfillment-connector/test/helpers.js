import { createConnectorApp } from '../src/app.js';
import { createSimulatedLabelProvider } from '../src/label-provider.js';
import { createLogger } from '../src/log.js';
import { createLocalGateway, SIM_BASE_URL, SIM_CLIENT_ID, SIM_CLIENT_SECRET, SIM_WEBHOOK_URL } from '../sim/local-gateway.js';

/** A connector wired to a fresh local gateway, with captured log lines. */
export function setup({ simulate = {}, gatewayOptions, now } = {}) {
  const gateway = createLocalGateway(gatewayOptions);
  const lines = [];
  const app = createConnectorApp({
    baseUrl: SIM_BASE_URL,
    clientId: SIM_CLIENT_ID,
    clientSecret: SIM_CLIENT_SECRET,
    webhookUrl: SIM_WEBHOOK_URL,
    simulate,
    fetchImpl: gateway.fetch,
    logger: createLogger((line) => lines.push(line)),
    labelProvider: createSimulatedLabelProvider({ unknownOutcome: simulate.unknownLabelOutcome }),
    sleep: async () => {},
    ...(now ? { now } : {}),
  });
  return { gateway, app, lines, logs: () => lines.map((l) => JSON.parse(l)) };
}
