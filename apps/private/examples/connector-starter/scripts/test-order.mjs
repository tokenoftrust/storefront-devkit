#!/usr/bin/env node
// Synthetic preview orders, via the tot CLI (you must be signed in: `tot login`).
//   npm run order -- <app> bind            bind this app's install as the preview processor (needs a webhook endpoint)
//   npm run order -- <app> create          create one synthetic order (preview data only, never live)
//   npm run order -- <app> release <id>    release it to the bound install
//   npm run order -- <app> go              create + release in one step
// Retries the CLI's intermittent "identity check failed (mcp_http_error)" a few times.
import { spawnSync } from 'node:child_process';
import { APPS, loadConfig } from '../core/config.mjs';

const [app, action, orderId] = process.argv.slice(2);
if (!APPS.includes(app) || !['bind', 'create', 'release', 'go'].includes(action)) {
  console.error('usage: npm run order -- <label-station|dropship|inventory-sync> <bind|create|release <orderId>|go>');
  process.exit(2);
}
const cfg = loadConfig(app);
if (!cfg.tenant || !cfg.installId) {
  console.error(`set TOT_TENANT and TOT_INSTALL_ID in ${cfg.envPath} first (npm run doctor -- ${app})`);
  process.exit(2);
}

function tot(args) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = spawnSync('tot', [...args, '--tenant', cfg.tenant, '--json'], { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter((l) => !/Update available|npm i -g/.test(l)).join('\n').trim();
    if (/mcp_http_error|mcp_unreachable/.test(out) && attempt < 5) {
      console.error(`  (tot: identity check failed, retry ${attempt}/4 in 20s)`);
      spawnSync('sleep', ['20']);
      continue;
    }
    if (r.error) {
      console.error(r.error.code === 'ENOENT' ? 'tot CLI not found: npm i -g @tokenoftrust/cli' : String(r.error));
      process.exit(1);
    }
    console.log(out);
    if (r.status !== 0) process.exit(r.status ?? 1);
    try {
      return JSON.parse(out.slice(out.indexOf('{')));
    } catch {
      return null;
    }
  }
  process.exit(1);
}

if (action === 'bind') tot(['app', 'test-order', 'bind', cfg.installId]);
if (action === 'create') tot(['app', 'test-order', 'create']);
if (action === 'release') {
  if (!orderId) { console.error('release needs an orderId (from create)'); process.exit(2); }
  tot(['app', 'test-order', 'release', orderId]);
}
if (action === 'go') {
  const created = tot(['app', 'test-order', 'create']);
  const id = created?.order?.orderId;
  if (!id) { console.error('create did not return an orderId'); process.exit(1); }
  const released = tot(['app', 'test-order', 'release', id]);
  if (released?.order?.assignedInstallId !== cfg.installId) {
    console.error(`\nreleased, but assigned to ${released?.order?.assignedInstallId ?? 'nobody'}, not this install. Run: npm run order -- ${app} bind`);
    process.exit(1);
  }
}
