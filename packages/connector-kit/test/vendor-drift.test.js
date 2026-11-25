// Every app that vendors the kit must hold a byte-identical copy of packages/connector-kit/src,
// and no app may carry its own signature or token code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAll, diffCopy, vendorTargets } from '../scripts/vendor.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(ROOT, 'packages/connector-kit/src');

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test('every recipe and example vendors the kit', () => {
  assert.equal(vendorTargets().length, 6);
});

test('every vendored copy equals packages/connector-kit/src', () => {
  assert.deepEqual(checkAll(), []);
});

test('a drifted copy is reported by file', () => {
  const copy = mkdtempSync(join(tmpdir(), 'kit-copy-'));
  for (const f of readdirSync(SRC)) writeFileSync(join(copy, f), readFileSync(join(SRC, f)));
  assert.deepEqual(diffCopy(copy), []);
  writeFileSync(join(copy, 'api.js'), `${readFileSync(join(SRC, 'api.js'), 'utf8')}\n// edited`);
  writeFileSync(join(copy, 'extra.js'), '');
  assert.deepEqual(diffCopy(copy).sort(), ['differs api.js', 'extra extra.js']);
});

test('recipe and example sources hold no token, signature or digest code of their own', () => {
  const own = vendorTargets().flatMap((copy) => {
    const app = join(copy, '..', '..');
    return files(app).filter((f) => f.endsWith('.mjs') && !f.includes('/vendor/') && !f.includes('/test/'));
  });
  assert.equal(own.length, 20);
  for (const file of own) {
    const code = readFileSync(file, 'utf8');
    assert.doesNotMatch(code, /grant_type|signature-input|content-digest|createHmac|createSign|createVerify|subtle\./i, relative(ROOT, file));
  }
});
