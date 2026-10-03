'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const {runExample} = require('../scripts/agent-example');
for (const mode of ['basic', 'input', 'debug']) test(`agent ${mode} example discovers, authors, reloads and verifies a real project`, async () => {
  const result = await runExample(mode);
  try {
    assert.equal(result.verified, true);
    const transcript = JSON.parse(await fs.readFile(result.directory + '/transcript.json'));
    assert.equal(transcript.length, result.commands);
    assert.equal(result.expectedErrors, mode === 'debug' ? 1 : 0);
    assert.equal(result.image.width, 480); assert.equal(result.image.height, 360);
    assert.equal(result.image.pixels, 480 * 360); assert.match(result.image.pixelsSha256, /^[a-f0-9]{64}$/);
    assert.ok((await fs.stat(result.directory + '/result.png')).size > 1000);
  } finally {await fs.rm(result.directory, {recursive: true, force: true});}
});
