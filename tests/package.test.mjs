import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('package metadata: typebox is declared as peerDependency only', () => {
  // Pi host injects typebox into extensions at runtime (extension loader).
  // An installed copy under dependencies can bypass the loader and create
  // duplicate runtime modules — host-provided packages must be peerDependencies with a "*" range.
  assert.equal(pkg.peerDependencies?.typebox, '*');
  assert.equal(pkg.dependencies?.typebox, undefined, 'typebox must not be a dependency (duplicates host module)');
});

test('package metadata: integration test script is available for manual QA', () => {
  assert.equal(pkg.scripts?.['test:integration'], 'node --experimental-strip-types tests/integration-test.mjs');
});
