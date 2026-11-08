#!/usr/bin/env node
// Production entry point: receive signed deliveries on WEBHOOK_PUBLIC_URL
// (terminate TLS in front of this process) and run the reconciliation pass on
// a timer as the recovery path for late or lost deliveries.
import { createServer } from 'node:http';
import { createConnectorApp } from './src/app.js';
import { errorFields } from './src/log.js';
import { parseSimulationFlags, readConfig } from './src/config.js';
import { nodeRequestListener } from './src/webhook.js';

const config = readConfig();
const simulate = parseSimulationFlags();
const { handleDelivery, connector, logger } = createConnectorApp({ ...config, simulate });

const reconcile = () =>
  connector.reconcileAll().catch((err) => logger.error('reconciliation pass failed', errorFields(err)));

createServer(nodeRequestListener(handleDelivery, logger)).listen(config.port, () => {
  logger.info('fulfillment connector listening', { port: config.port, simulate });
  reconcile();
  setInterval(reconcile, config.reconcileIntervalSeconds * 1000).unref();
});
