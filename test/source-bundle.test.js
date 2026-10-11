'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('@turbowarp/jszip');
const {listPublicFiles, buildSourceBundle} = require('../scripts/build-source-bundle');
const {assertPublicPath, assertNoProjectJSON, sha256} = require('../scripts/source-release-policy');

test('public inclusion uses explicit paths and refuses project/private data', async () => {
  const files = await listPublicFiles();
  assert.ok(files.includes('test/helpers/demo-project.js'));
  assert.ok(files.includes('scripts/audit-release.js'));
  for (const name of files) assert.doesNotMatch(name, /^(games|edit|examples|\.zcode|docs\/verification|test\/fixtures)\//);
  for (const name of ['games/user.js', 'docs/verification/log.json', 'edit/project.sb3', 'test/fixtures/demo.sb3', 'sample.SPRITE3', 'test/project.json', '../outside', '.git/config']) {
    assert.throws(() => assertPublicPath(name), /forbidden/);
  }
  assert.throws(() => assertNoProjectJSON('sample.json', Buffer.from('{"targets":[]}')), /forbidden/);
  assert.throws(() => assertNoProjectJSON('sample.json', Buffer.from('{"objName":"Stage"}')), /forbidden/);
});

test('source bundle has an exact manifest and nested upstream archives contain code only', {timeout: 120000}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-public-bundle-'));
  try {
    const output = path.join(dir, 'source.zip'), result = await buildSourceBundle({output});
    assert.equal(result.projectDataIncluded, false); assert.equal(result.excludedUpstreamProjects, 16);
    const zip = await JSZip.loadAsync(await fs.readFile(output));
    const manifest = JSON.parse(await zip.file('tw-cli/SOURCE-BUNDLE.json').async('string'));
    assert.equal(Object.keys(manifest.files).length, result.files);
    for (const [filename, info] of Object.entries(manifest.files)) {
      assertPublicPath(filename);
      const bytes = await zip.file('tw-cli/' + filename).async('nodebuffer');
      assert.equal(sha256(bytes), info.sha256);
      if (filename.startsWith('upstream/') && filename.endsWith('.zip')) {
        const upstream = await JSZip.loadAsync(bytes);
        for (const entry of Object.values(upstream.files)) if (!entry.dir) assertPublicPath(entry.name);
      }
    }
    assert.equal(zip.file('tw-cli/test/fixtures/demo.sb3'), null);
    assert.equal(zip.file('tw-cli/docs/verification/agent-full-tests.log'), null);
    assert.notEqual(manifest.upstream['upstream/extensions-source.zip'].sha256, manifest.upstream['upstream/extensions-source.zip'].originalSha256);
    await assert.rejects(buildSourceBundle({output}), {code: 'EEXIST'});
  } finally {await fs.rm(dir, {recursive: true, force: true});}
});
