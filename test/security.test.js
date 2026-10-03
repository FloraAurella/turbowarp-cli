const assert = require('node:assert/strict');
const {test} = require('node:test');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const JSZip = require('@turbowarp/jszip');
const {blankProject} = require('../src/project');
const {NativeRenderer} = require('../src/native-renderer');

test('default network policy rejects TCP, UDP and fetch', () => {
  const script = `require(${JSON.stringify(path.join(__dirname, '../src/network-policy'))}).install();
    const assert=require('node:assert/strict');
    assert.throws(()=>require('node:net').connect(12345,'127.0.0.1'),/denied/);
    assert.throws(()=>require('node:dgram').createSocket('udp4'),/denied/);
    assert.rejects(fetch('https://example.invalid'),/denied/).then(()=>process.stdout.write('denied'));`;
  const result = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 5000});
  assert.equal(result.status, 0); assert.equal(result.stdout, 'denied');
});

test('SVG rejects active/external XML resources without a DOM shim', () => {
  const renderer = new NativeRenderer();
  try {
    for (const svg of [
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="file:///etc/passwd"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
      '<!DOCTYPE svg SYSTEM "https://example.invalid/x"><svg/>'
    ]) assert.throws(() => renderer.createSVGSkin(svg), /denied/);
    assert.equal(typeof document, 'undefined'); assert.equal(typeof window, 'undefined');
  } finally {renderer.dispose();}
});

test('CLI fails closed on sanitized ZIP traversal and executable extensions without losing the open project', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-cli-security-'));
  try {
    const safe = path.join(dir, 'safe.sb3'); await fs.writeFile(safe, await blankProject());
    const bad = [];
    for (const entry of ['../escaped.txt', 'C:\\escaped.txt', 'folder\\escaped.txt']) {
      const zip = await JSZip.loadAsync(await blankProject()); zip.file(entry, 'denied');
      const file = path.join(dir, `traversal-${bad.length}.sb3`); await fs.writeFile(file, await zip.generateAsync({type: 'nodebuffer'})); bad.push(file);
    }
    const zip = await JSZip.loadAsync(await blankProject()); const json = JSON.parse(await zip.file('project.json').async('string'));
    json.extensionURLs = {evil: 'file:///not-approved.js'}; zip.file('project.json', JSON.stringify(json));
    const file = path.join(dir, 'extension.sb3'); await fs.writeFile(file, await zip.generateAsync({type: 'nodebuffer'})); bad.push(file);
    const requests = [{command: 'open', args: [safe]}, {command: 'info', args: []},
      ...bad.flatMap(file => [{command: 'open', args: [file, '--force']}, {command: 'info', args: []}]), {command: 'quit', args: []}];
    const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), 'session', '--jsonl'],
      {input: requests.map(item => JSON.stringify(item)).join('\n') + '\n', encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 0, result.stderr);
    const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    for (let index = 0; index < bad.length; index++) {
      assert.equal(replies[2 + index * 2].ok, false);
      assert.match(replies[2 + index * 2].error, /Unsafe archive|denied/);
      assert.deepEqual(replies[3 + index * 2].result, replies[1].result);
    }
    assert.equal(replies.at(-1).result.closed, true);
  } finally {await fs.rm(dir, {recursive: true, force: true});}
});
