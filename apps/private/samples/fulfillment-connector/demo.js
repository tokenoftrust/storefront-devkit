#!/usr/bin/env node
// Offline walkthrough: no credentials, no network, no listening socket. A
// signed fulfillment.assignment.created delivery from the local simulator goes
// through the same handler server.js uses, then the connector reconciles,
// reads the recipient, buys a simulated label and reports evidence.
//
//   node demo.js [--label-outcome=unknown] [--force-retry] [--conflicting-key-reuse]
import { createConnectorApp } from './src/app.js';
import { parseSimulationFlags } from './src/config.js';
import { createLocalGateway, example, SIM_BASE_URL, SIM_CLIENT_ID, SIM_CLIENT_SECRET, SIM_WEBHOOK_URL } from './sim/local-gateway.js';

const simulate = parseSimulationFlags();
const gateway = createLocalGateway();
const app = createConnectorApp({
  baseUrl: SIM_BASE_URL,
  clientId: SIM_CLIENT_ID,
  clientSecret: SIM_CLIENT_SECRET,
  webhookUrl: SIM_WEBHOOK_URL,
  simulate,
  fetchImpl: gateway.fetch,
  sleep: async () => {},
});

const event = example('fulfillment.assignment.created.cloudevent.json');
const delivery = gateway.deliver(event);
const first = await app.handleDelivery(delivery);
app.logger.info('demo: first delivery answered', { status: first.status });
const outcome = await first.work;
const again = await app.handleDelivery(gateway.deliver(event));
app.logger.info('demo: redelivery of the same event id answered', { status: again.status, duplicate: again.body.duplicate === true });
app.logger.info('demo: done', { outcome, label: gateway.order.label, handoff: gateway.order.handoff, version: gateway.order.version });
