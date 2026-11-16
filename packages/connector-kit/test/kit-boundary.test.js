// The kit is vendored into other projects: it must stay self-contained,
// dependency-free, runtime-neutral and free of integration-vendor names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = fileURLToPath(new URL('..', import.meta.url));
// Assembled from fragments so this file does not itself contain the names a grep looks for.
const VENDOR_NAMES = new RegExp(['ship' + 'station', 'sku' + 'vault', 'duo' + 'plane'].join('|'), 'i');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test('no vendor names anywhere in the kit', () => {
  const hits = files(KIT).filter((f) => VENDOR_NAMES.test(readFileSync(f, 'utf8')) || VENDOR_NAMES.test(relative(KIT, f)));
  assert.deepEqual(hits.map((f) => relative(KIT, f)), []);
});

test('kit source imports only its own modules (no node: built-ins, no packages)', () => {
  for (const file of files(join(KIT, 'src'))) {
    const specifiers = [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const s of specifiers) assert.match(s, /^\.\/[a-z-]+\.js$/, `${relative(KIT, file)} imports ${s}`);
    const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\bBuffer\b|\bprocess\./, `${relative(KIT, file)} uses a Node-only global`);
  }
});

test('the kit is private, unpublished and has no dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.publishConfig, undefined);
});
