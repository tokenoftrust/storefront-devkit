// Configuration comes from the environment only; simulation switches come
// from command-line flags so they can never be left on by a deploy config.
//
// The deployed connector talks to the storefront's preview stage. The preview
// capability arrives inside the private TOT_STOREFRONT_BASE_URL as its one
// `__preview` query parameter; it is taken out here, before the URL is reduced
// to its origin, and handed only to the scoped transport. A refusal names the
// variable, never its value.
import { Buffer } from 'node:buffer';
import { ConnectorError } from './log.js';

const REQUIRED = ['TOT_APP_CLIENT_ID', 'TOT_APP_CLIENT_SECRET', 'TOT_STOREFRONT_BASE_URL', 'WEBHOOK_PUBLIC_URL'];
// Exactly one nonempty __preview of two base64url segments, and nothing else.
const PREVIEW_QUERY = /^\?__preview=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/** Initialization refused. The message names the variable only, so it is safe to log. */
export class ConfigRefused extends ConnectorError {
  constructor(variable) {
    super('config_invalid');
    this.name = 'ConfigRefused';
    this.variable = variable;
    this.message = `configuration refused: ${variable}`;
  }
}

function parseUrl(raw, variable) {
  if (typeof raw !== 'string' || raw.includes('#') || raw.includes('@')) throw new ConfigRefused(variable);
  try {
    return new URL(raw);
  } catch {
    throw new ConfigRefused(variable);
  }
}

/** The storefront origin and the preview capability with its own expiry claim. */
function parseStorefrontBaseUrl(raw) {
  const variable = 'TOT_STOREFRONT_BASE_URL';
  const url = parseUrl(raw, variable);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '' || url.pathname !== '/') {
    throw new ConfigRefused(variable);
  }
  const match = PREVIEW_QUERY.exec(url.search);
  if (!match) throw new ConfigRefused(variable);
  let claims;
  try {
    claims = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  } catch {
    throw new ConfigRefused(variable);
  }
  if (!claims || typeof claims !== 'object' || claims.env !== 'test' || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new ConfigRefused(variable);
  }
  return { origin: url.origin, capability: `${match[1]}.${match[2]}`, expiresAtMs: claims.exp * 1000 };
}

/**
 * Everything the deployed app needs: the public `config` plus the two private
 * values only the app's closures receive. Callers return `config` alone.
 */
export function loadConfig(env = process.env) {
  for (const key of REQUIRED) if (typeof env[key] !== 'string' || env[key] === '') throw new ConfigRefused(key);
  const storefront = parseStorefrontBaseUrl(env.TOT_STOREFRONT_BASE_URL);
  const webhookUrl = parseUrl(env.WEBHOOK_PUBLIC_URL, 'WEBHOOK_PUBLIC_URL');
  if (webhookUrl.protocol !== 'https:') throw new ConfigRefused('WEBHOOK_PUBLIC_URL');
  return {
    config: {
      clientId: env.TOT_APP_CLIENT_ID,
      baseUrl: storefront.origin,
      // The signature covers @target-uri as the registered endpoint string, so it is kept verbatim.
      webhookUrl: env.WEBHOOK_PUBLIC_URL,
      port: Number(env.PORT || 8787),
      reconcileIntervalSeconds: Number(env.RECONCILE_INTERVAL_SECONDS || 300),
    },
    clientSecret: env.TOT_APP_CLIENT_SECRET,
    preview: { capability: storefront.capability, expiresAtMs: storefront.expiresAtMs },
  };
}

/** The public configuration: no client secret, no preview capability. */
export function readConfig(env = process.env) {
  return loadConfig(env).config;
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
