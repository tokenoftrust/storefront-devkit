// Loads apps/<app>/.env (KEY=VALUE lines) on top of process.env.
// Secrets live only in that gitignored file. Never print them.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const APPS = ['label-station', 'dropship', 'inventory-sync'];

export function appDir(app) {
  if (!APPS.includes(app)) throw new Error(`unknown app "${app}" (expected one of: ${APPS.join(', ')})`);
  return join(ROOT, 'apps', app);
}

function parseEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

/** Returns { app, dir, envPath, envFound, tenant, host, clientId, clientSecret, installId, webhookPublicUrl, webhookEndpoint, port, mockPort, manifest, missing[] }. */
export function loadConfig(app) {
  const dir = appDir(app);
  const envPath = join(dir, '.env');
  const envFound = existsSync(envPath);
  const env = { ...(envFound ? parseEnvFile(envPath) : {}), ...pickDefined(process.env) };
  const manifest = JSON.parse(readFileSync(join(dir, 'tot-app.json'), 'utf8'));
  const host = (env.TOT_HOST || 'https://storefront.tokenoftrust.store').replace(/\/+$/, '');
  const webhookPublicUrl = (env.WEBHOOK_PUBLIC_URL || '').replace(/\/+$/, '');
  const cfg = {
    app,
    dir,
    envPath,
    envFound,
    tenant: env.TOT_TENANT || '',
    host,
    installId: env.TOT_INSTALL_ID || '',
    clientId: env.TOT_CLIENT_ID || '',
    clientSecret: env.TOT_CLIENT_SECRET || '',
    webhookPublicUrl,
    // The exact string registered with `tot app update --webhook-endpoint`. Signatures cover it character for character.
    webhookEndpoint: webhookPublicUrl ? `${webhookPublicUrl}/webhooks` : '',
    port: Number(env.PORT || 8787),
    mockPort: Number(env.MOCK_PORT || 9100 + APPS.indexOf(app) + 1),
    env,
    manifest,
  };
  cfg.missing = ['TOT_TENANT', 'TOT_INSTALL_ID', 'TOT_CLIENT_ID', 'TOT_CLIENT_SECRET'].filter((k) => !env[k]);
  return cfg;
}

function pickDefined(obj) {
  // Only TOT_*, WEBHOOK_*, PORT, MOCK_* and app tuning vars may override the .env file.
  return Object.fromEntries(Object.entries(obj).filter(([k, v]) => v !== undefined && /^(TOT_|WEBHOOK_|PORT$|MOCK_|SYNC_|POLL_)/.test(k)));
}
