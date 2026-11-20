import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as kit from 'storefront-connector-kit';

test('the public declaration entry point names every public runtime export', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const types = pkg.exports['.'].types ?? pkg.types;
  assert.equal(types, './src/index.d.ts');
  const declarations = readFileSync(new URL(types, new URL('../', import.meta.url)), 'utf8');
  const valueExports = [...declarations.matchAll(/^export\s+(?:declare\s+)?(?:const|class|function)\s+(\w+)/gm)]
    .map(([, name]) => name);
  assert.deepEqual([...new Set(valueExports)].sort(), Object.keys(kit).sort());
});
