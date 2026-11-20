// Offline checks for e2e.mjs: argument parsing, settings, and that --help needs no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTS, loadEnv, missingFor, parseArgs } from '../e2e.mjs';

const E2E = fileURLToPath(new URL('../e2e.mjs', import.meta.url));

test('e2e: parseArgs takes --only, --pause and --help, and refuses an unknown part', () => {
  assert.deepEqual(parseArgs([]), { only: null, pauseMs: 4000, help: false });
  assert.deepEqual(parseArgs(['--only', 'hold', '--pause', '0']), { only: 'hold', pauseMs: 0, help: false });
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--only', 'labels']), /inventory-api, inventory-sync, fulfilment, hold/);
  assert.throws(() => parseArgs(['--pause', 'soon']), /seconds/);
  assert.deepEqual(PARTS, ['inventory-api', 'inventory-sync', 'fulfilment', 'hold']);
});

test('e2e: loadEnv reads .env, the environment wins, empty values are ignored', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, '.env');
  writeFileSync(path, '# comment\nTOT_TENANT=from-file\nTOT_CLIENT_ID="quoted"\nWEBHOOK_PUBLIC_URL=https://x.example\n');
  const env = loadEnv(path, { TOT_TENANT: 'from-env', WEBHOOK_PUBLIC_URL: '' });
  assert.equal(env.TOT_TENANT, 'from-env');
  assert.equal(env.TOT_CLIENT_ID, 'quoted');
  assert.equal(env.WEBHOOK_PUBLIC_URL, 'https://x.example');
});

test('e2e: each part names only the settings it needs', () => {
  assert.deepEqual(missingFor(['inventory-api'], {}), ['TOT_TENANT', 'TOT_CLIENT_ID', 'TOT_CLIENT_SECRET']);
  assert.deepEqual(missingFor(['hold'], { TOT_TENANT: 't' }), ['WEBHOOK_PUBLIC_URL']);
  assert.deepEqual(missingFor(PARTS, { TOT_TENANT: 't', TOT_CLIENT_ID: 'c', TOT_CLIENT_SECRET: 's', WEBHOOK_PUBLIC_URL: 'u' }), []);
});

test('e2e: --help prints usage and exits 0; a run without settings stops before any network call', () => {
  const help = spawnSync(process.execPath, [E2E, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npm run e2e/);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TOT_|WEBHOOK_|E2E_)/.test(k))), E2E_ENV_FILE: join(tmpdir(), 'no-such-e2e.env') };
  const run = spawnSync(process.execPath, [E2E, '--only', 'hold'], { encoding: 'utf8', env, cwd: tmpdir() });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /missing TOT_TENANT, WEBHOOK_PUBLIC_URL/);
});
