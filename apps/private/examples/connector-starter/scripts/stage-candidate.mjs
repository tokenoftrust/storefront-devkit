#!/usr/bin/env node
// Stage your app as a production candidate for the store owner to approve (tot CLI 7.7.0 or later).
//   npm run stage-candidate -- <app> --jwks <public-jwks.json>          print the command (dry run)
//   npm run stage-candidate -- <app> --generate-keys [dir]              print the command; the CLI makes an ES256 key pair
//   npm run stage-candidate -- <app> --jwks <public-jwks.json> --yes    run it
//
// It wraps: tot app candidate --app apps/<app> --jwks <file> --request-consent --tenant <store>
// Staging asks the store OWNER to approve a production install. Only run it with --yes on a store
// where you were asked to; on anyone else's store, show the dry run instead.
// The JWKS holds your PUBLIC key only. Never commit or share the private key.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { APPS, loadConfig } from '../core/config.mjs';

/** The tot CLI argument list, or throws with a usage message. */
export function candidateArgs(app, argv, tenant) {
  if (!APPS.includes(app)) throw new Error(`usage: npm run stage-candidate -- <${APPS.join('|')}> (--jwks <public-jwks.json> | --generate-keys [dir]) [--yes]`);
  if (!tenant) throw new Error('set TOT_TENANT in your .env first');
  const args = ['app', 'candidate', '--app', `apps/${app}`];
  const jwksAt = argv.indexOf('--jwks');
  const genAt = argv.indexOf('--generate-keys');
  if (jwksAt >= 0) {
    const file = argv[jwksAt + 1];
    if (!file || file.startsWith('--')) throw new Error('--jwks needs a file');
    args.push('--jwks', file);
  } else if (genAt >= 0) {
    const dir = argv[genAt + 1];
    args.push('--generate-keys', ...(dir && !dir.startsWith('--') ? [dir] : []));
  } else {
    throw new Error('pass --jwks <public-jwks.json> or --generate-keys [dir]');
  }
  args.push('--request-consent', '--tenant', tenant);
  return args;
}

function main() {
  const [app, ...rest] = process.argv.slice(2);
  let args;
  try {
    args = candidateArgs(app, rest, APPS.includes(app) ? loadConfig(app).tenant : '');
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const jwks = args[args.indexOf('--jwks') + 1];
  if (args.includes('--jwks') && !existsSync(jwks)) {
    console.error(`no such file: ${jwks}`);
    process.exit(2);
  }
  console.log(`tot ${args.join(' ')}`);
  if (!rest.includes('--yes')) {
    console.log('\ndry run: nothing was staged. Add --yes to stage it (the store owner is asked to approve).');
    return;
  }
  const isWin = process.platform === 'win32';
  const r = spawnSync(isWin ? 'tot.cmd' : 'tot', args, { stdio: 'inherit', shell: isWin });
  process.exit(r.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
