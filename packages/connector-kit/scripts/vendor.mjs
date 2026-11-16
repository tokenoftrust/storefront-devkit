#!/usr/bin/env node
// Keeps every vendored copy of connector-kit identical to packages/connector-kit/src.
//
//   node packages/connector-kit/scripts/vendor.mjs          copy the kit into every app
//   node packages/connector-kit/scripts/vendor.mjs --check  exit 1 when a copy differs
//
// An app is any directory directly under apps/private/recipes or apps/private/examples
// that has a package.json. Its copy lives at <app>/vendor/connector-kit/.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const KIT_SRC = join(ROOT, 'packages/connector-kit/src');
const APP_PARENTS = ['apps/private/recipes', 'apps/private/examples'];
export const VENDOR_DIR = 'vendor/connector-kit';

export function vendorTargets(root = ROOT) {
  return APP_PARENTS.flatMap((parent) => {
    const dir = join(root, parent);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((app) => statSync(app).isDirectory() && existsSync(join(app, 'package.json')))
      .map((app) => join(app, VENDOR_DIR));
  });
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).filter((p) => statSync(join(dir, p)).isFile()).sort();
}

/** Human-readable differences between the kit source and one vendored copy; empty when identical. */
export function diffCopy(copyDir, srcDir = KIT_SRC) {
  const want = listFiles(srcDir);
  const have = listFiles(copyDir);
  const problems = [];
  for (const f of want) {
    if (!have.includes(f)) problems.push(`missing ${f}`);
    else if (!readFileSync(join(srcDir, f)).equals(readFileSync(join(copyDir, f)))) problems.push(`differs ${f}`);
  }
  for (const f of have) if (!want.includes(f)) problems.push(`extra ${f}`);
  return problems;
}

export function checkAll(root = ROOT) {
  return vendorTargets(root).flatMap((copy) => diffCopy(copy).map((p) => `${relative(root, copy)}: ${p}`));
}

export function syncAll(root = ROOT) {
  const targets = vendorTargets(root);
  for (const copy of targets) {
    rmSync(copy, { recursive: true, force: true });
    mkdirSync(copy, { recursive: true });
    cpSync(KIT_SRC, copy, { recursive: true });
  }
  return targets;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const problems = checkAll();
    if (problems.length > 0) {
      console.error(`vendored connector-kit differs from packages/connector-kit/src:\n${problems.map((p) => `  ${p}`).join('\n')}`);
      console.error('run: node packages/connector-kit/scripts/vendor.mjs');
      process.exit(1);
    }
    console.log(`vendored connector-kit is in sync (${vendorTargets().length} apps)`);
  } else {
    for (const t of syncAll()) console.log(`vendored ${relative(ROOT, t)}`);
  }
}
