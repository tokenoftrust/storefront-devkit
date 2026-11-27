#!/usr/bin/env node
// Synthetic preview orders, via the tot CLI 7.7.0 or later (you must be signed in: `tot login`).
//   npm run order -- <app> bind            bind this install as the preview processor for STARTER_LOCATION_ID (needs a webhook endpoint)
//   npm run order -- <app> create          create one synthetic order (2 units) at STARTER_LOCATION_ID (preview data only, never live)
//   npm run order -- <app> release <id>    release it to the bound install (or lift an active hold and resume the assignment)
//   npm run order -- <app> go              create + release in one step
//   npm run order -- <app> hold <id>       hold it: your app gets fulfillment.assignment.updated state "held"
//   npm run order -- <app> cancel <id>     cancel it: your app gets fulfillment.assignment.updated state "cancelled"
// Every order uses your own location, so other developers on the same store preview never get yours.
// Retries the CLI's intermittent "identity check failed (mcp_http_error)" a few times.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { APPS, loadConfig } from '../core/config.mjs';

export const ACTIONS = ['bind', 'create', 'release', 'go', 'hold', 'cancel'];

/** The tot CLI argument list for one step (without --tenant/--json). */
export function cliArgs(action, cfg, orderId) {
  const location = ['--location', cfg.locationId];
  switch (action) {
    case 'bind':
      return ['app', 'test-order', 'bind', cfg.installId, ...location];
    case 'create':
      return ['app', 'test-order', 'create', ...location, '--quantity', '2'];
    case 'release':
    case 'hold':
    case 'cancel':
      if (!orderId) throw new Error(`${action} needs an orderId (from create)`);
      return ['app', 'test-order', action, orderId];
    default:
      throw new Error(`unknown action ${action}`);
  }
}

const IS_WIN = process.platform === 'win32';
const TOT_CMD = IS_WIN ? 'tot.cmd' : 'tot';
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Parse the JSON object from `tot ... --json` stdout alone, ignoring any stderr update nudge
 * (`▸ Update available for \`tot\`: ...`) that follows on stderr.
 */
export function parseTotJson(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function tot(cfg, args) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = spawnSync(TOT_CMD, [...args, '--tenant', cfg.tenant, '--json'], { encoding: 'utf8', shell: IS_WIN });
    if (r.error) {
      console.error(`could not run tot (${r.error.code ?? r.error.message}). Install it: npm i -g @tokenoftrust/cli`);
      process.exit(1);
    }
    const stdout = (r.stdout ?? '').trim();
    const stderr = (r.stderr ?? '').trim();
    const combined = `${stdout}\n${stderr}`.trim();
    if (/mcp_http_error|mcp_unreachable/.test(combined) && attempt < 5) {
      console.error(`  (tot: identity check failed, retry ${attempt}/4 in 20s)`);
      sleepMs(20_000);
      continue;
    }
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    if (r.status !== 0) process.exit(r.status ?? 1);
    return parseTotJson(r.stdout);
  }
  process.exit(1);
}

function main() {
  const [app, action, orderId] = process.argv.slice(2);
  if (!APPS.includes(app) || !ACTIONS.includes(action)) {
    console.error('usage: npm run order -- <label-station|dropship|inventory-sync> <bind|create|go|release <orderId>|hold <orderId>|cancel <orderId>>');
    process.exit(2);
  }
  const cfg = loadConfig(app);
  if (!cfg.tenant || !cfg.installId) {
    console.error(`set TOT_TENANT and TOT_INSTALL_ID in ${cfg.envPath} first (npm run doctor -- ${app})`);
    process.exit(2);
  }
  if (action === 'go') {
    const created = tot(cfg, cliArgs('create', cfg));
    const id = created?.order?.orderId;
    if (!id) {
      console.error('create did not return an orderId');
      process.exit(1);
    }
    const released = tot(cfg, cliArgs('release', cfg, id));
    if (released?.order?.assignedInstallId !== cfg.installId) {
      console.error(`\nreleased, but assigned to ${released?.order?.assignedInstallId ?? 'nobody'}, not this install. Run: npm run order -- ${app} bind`);
      process.exit(1);
    }
    console.error(`\norder ${id} released to this install. Next: npm run order -- ${app} hold ${id}   (or cancel ${id})`);
    return;
  }
  try {
    tot(cfg, cliArgs(action, cfg, orderId));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
