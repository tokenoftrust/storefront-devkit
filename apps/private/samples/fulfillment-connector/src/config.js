// Configuration comes from the environment only; simulation switches come
// from command-line flags so they can never be left on by a deploy config.

export function readConfig(env = process.env) {
  const missing = ['TOT_APP_CLIENT_ID', 'TOT_APP_CLIENT_SECRET', 'TOT_STOREFRONT_BASE_URL', 'WEBHOOK_PUBLIC_URL'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`);
  const baseUrl = new URL(env.TOT_STOREFRONT_BASE_URL);
  const webhookUrl = new URL(env.WEBHOOK_PUBLIC_URL);
  if (baseUrl.protocol !== 'https:') throw new Error('TOT_STOREFRONT_BASE_URL must be https');
  if (webhookUrl.protocol !== 'https:') throw new Error('WEBHOOK_PUBLIC_URL must be https');
  return {
    clientId: env.TOT_APP_CLIENT_ID,
    clientSecret: env.TOT_APP_CLIENT_SECRET,
    baseUrl: baseUrl.origin,
    webhookUrl: webhookUrl.toString(),
    port: Number(env.PORT || 8787),
    reconcileIntervalSeconds: Number(env.RECONCILE_INTERVAL_SECONDS || 300),
  };
}

export function parseSimulationFlags(argv = process.argv.slice(2)) {
  const simulate = { unknownLabelOutcome: false, forceRetry: false, conflictingKeyReuse: false };
  for (const arg of argv) {
    if (arg === '--label-outcome=unknown') simulate.unknownLabelOutcome = true;
    else if (arg === '--force-retry') simulate.forceRetry = true;
    else if (arg === '--conflicting-key-reuse') simulate.conflictingKeyReuse = true;
    else throw new Error(`unknown flag ${arg} (expected --label-outcome=unknown, --force-retry, --conflicting-key-reuse)`);
  }
  return simulate;
}
