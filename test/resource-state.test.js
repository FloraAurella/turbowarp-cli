const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {inspect} = require('../src/resource-state');
const {status} = require('../src/acceptance-state');

test('bundled resource inventory verifies all 1304 assets and 301 extensions without desktop paths', () => {
  const result = inspect();
  assert.equal(result.complete, true);
  assert.equal(result.checkedFiles, 1610); assert.equal(result.extensionFiles, 301);
  assert.deepEqual(result.library, {expected: 1304, available: 1304, missing: 0, invalid: 0});
  assert.deepEqual(result.errors, []);
  const acceptance = status();
  assert.equal(acceptance.resources.complete, true);
  assert.equal(acceptance.releaseReady, false);
  assert.ok(acceptance.census.pending > 0);
  assert.ok(acceptance.missingAcceptanceGates.includes('imageDifferential'));
});

test('missing resource inventory fails closed rather than using sibling desktop files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-resource-missing-'));
  try {
    const result = inspect(dir);
    assert.equal(result.complete, false); assert.equal(result.library.available, 0);
    assert.ok(result.errors.some(error => error.includes('resource inventory')));
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});
