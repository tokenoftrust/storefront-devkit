#!/usr/bin/env node
// Production entry point: receive signed deliveries on WEBHOOK_PUBLIC_URL
// (terminate TLS in front of this process) and run the reconciliation pass on
// a timer as the recovery path for late or lost deliveries.
//
// It refuses to start without a label provider: LABEL_PROVIDER=carrier (your
// real provider) or LABEL_PROVIDER=simulated (fabricated labels, nothing ships).
import { createServer } from 'node:http';
import { createDeployedApp } from './src/app.js';
import { parseSimulationFlags } from './src/config.js';
import { LABEL_PROVIDER_HINT, LabelProviderNotConfigured } from './src/label-provider.js';
import { createLogger, errorFields } from './src/log.js';
import { nodeRequestListener } from './src/webhook.js';

const simulate = parseSimulationFlags();
let deployed;
try {
  deployed = createDeployedApp({ env: process.env, logger: createLogger(), simulate });
} catch (err) {
  if (!(err instanceof LabelProviderNotConfigured)) throw err;
  createLogger((line) => process.stderr.write(`${line}\n`)).error('label provider not configured; refusing to start', {
    code: 'label_provider_not_configured',
    reason: err.reason,
    hint: LABEL_PROVIDER_HINT,
  });
  process.exit(1);
}
const { handleDelivery, connector, logger, config, simulated } = deployed;

const reconcile = () =>
  connector.reconcileAll().catch((err) => logger.error('reconciliation pass failed', errorFields(err)));

createServer(nodeRequestListener(handleDelivery, logger)).listen(config.port, () => {
  logger.info('fulfillment connector listening', { port: config.port, simulate, simulated });
  reconcile();
  setInterval(reconcile, config.reconcileIntervalSeconds * 1000).unref();
});
