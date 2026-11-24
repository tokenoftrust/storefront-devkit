#!/usr/bin/env node
// Preflight: `npm run doctor -- <label-station|dropship|inventory-sync>`
// Checks every link in the chain and prints the next step for the first one that fails.
// Read-only: it never writes to the store.
import { existsSync } from 'node:fs';
import { APPS, loadConfig } from '../core/config.mjs';
import { createTot } from '../core/tot.mjs';

const app = process.argv[2];
if (!APPS.includes(app)) {
  console.error(`usage: npm run doctor -- <${APPS.join('|')}>`);
  process.exit(2);
}

let failed = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const warn = (msg, next) => console.log(`  WARN  ${msg}${next ? `\n        next: ${next}` : ''}`);
const fail = (msg, next) => {
  failed++;
  console.log(`  FAIL  ${msg}${next ? `\n        next: ${next}` : ''}`);
};

console.log(`doctor: ${app}`);

const [major] = process.versions.node.split('.').map(Number);
major >= 20 ? pass(`node ${process.versions.node}`) : fail(`node ${process.versions.node} is too old`, 'install Node 20 or newer');

const cfg = loadConfig(app);
if (!cfg.envFound) fail(`no ${cfg.envPath}`, `cp apps/${app}/.env.example apps/${app}/.env, then fill it from your \`tot app install\` output`);
else if (cfg.missing.length) fail(`${cfg.envPath} is missing ${cfg.missing.join(', ')}`, 'copy them from your `tot app install` output (the secret is printed once)');
else pass(`.env has tenant ${cfg.tenant}, install ${cfg.installId}`);
if (!existsSync(new URL('../.gitignore', import.meta.url))) warn('no .gitignore: make sure apps/*/.env is never committed');

if (failed) finish();

const tot = createTot(cfg);

// 1. Token
let granted = [];
try {
  const token = await tot.auth.getToken({ forceRefresh: true });
  granted = Array.isArray(token.scope) ? token.scope : String(token.scope ?? '').split(/\s+/).filter(Boolean);
  pass(`token OK (${granted.length} scopes)`);
} catch (err) {
  fail(`token refused: ${err.code ?? err.message}${err.status ? ` (HTTP ${err.status})` : ''}`,
    err.code === 'invalid_client'
      ? 'check TOT_TENANT / TOT_CLIENT_ID / TOT_CLIENT_SECRET. Lost the secret? `tot app rotate <installId> --tenant <tenant>` prints a new one (the old one stops working)'
      : 'retry in a minute; if it persists, report it');
  finish();
}

// 2. Scopes match the manifest
const missingScopes = cfg.manifest.scopes.filter((s) => !granted.includes(s));
missingScopes.length
  ? fail(`install lacks ${missingScopes.join(', ')} from apps/${app}/tot-app.json`, `tot app update ${cfg.installId} --app apps/${app} --tenant ${cfg.tenant}`)
  : pass('install scopes match tot-app.json');

// 3. App-specific reads
const reads = app === 'inventory-sync' ? ['/catalog/products', '/inventory/locations'] : ['/fulfillment/carriers', '/fulfillment/assignments'];
for (const path of reads) {
  const r = await tot.call('GET', path, { query: path === '/catalog/products' ? { limit: 1 } : undefined });
  r.ok ? pass(`GET ${path} ${r.status}`) : fail(`GET ${path} ${r.status} ${r.body?.code}`, `report it with the request id ${r.requestId ?? '(none)'}`);
}

// 4. Webhook signing keys are published
try {
  (await tot.keys.load()).keys.size > 0 ? pass('webhook signing keys published') : fail('no webhook signing keys published', 'report it');
} catch (err) {
  fail(`webhook signing keys unavailable: ${err.code}`, 'retry in a minute; if it persists, report it');
}

// 5. Tunnel + local server
if (!cfg.webhookPublicUrl) {
  warn('WEBHOOK_PUBLIC_URL not set: no webhooks, and `tot app test-order bind` needs an endpoint', 'see README "Tunnel"');
} else {
  try {
    const res = await fetch(`${cfg.webhookPublicUrl}/health`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    res.ok && body.app === app
      ? pass(`tunnel reaches your ${app} server (${cfg.webhookPublicUrl})`)
      : fail(`${cfg.webhookPublicUrl}/health answered ${res.status}`, `start the server (npm run ${app}) and check the tunnel points at port ${cfg.port}`);
  } catch (err) {
    fail(`cannot reach ${cfg.webhookPublicUrl}/health (${err.name})`, `start the tunnel and the server (npm run ${app}); quick-tunnel URLs change on every restart`);
  }
  console.log(`        registered endpoint must be exactly: ${cfg.webhookEndpoint}\n        (tot app update ${cfg.installId} --app apps/${app} --webhook-endpoint ${cfg.webhookEndpoint} --tenant ${cfg.tenant})`);
  if (app !== 'inventory-sync') {
    console.log(`        then bind the preview processor: npm run order -- ${app} bind   (--webhook-endpoint none unbinds it)`);
  }
}

finish();

function finish() {
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}
