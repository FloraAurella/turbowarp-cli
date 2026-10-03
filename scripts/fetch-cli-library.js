const https = require('node:https');
const {brotliCompressSync, brotliDecompressSync} = require('node:zlib');
const fs = require('node:fs/promises');
const os = require('node:os');
const {spawn} = require('node:child_process');
const {promisify} = require('node:util');
const {LibraryStore, assetName, verifyAsset, sha256} = require('../src/library-store');
const {md5, readLocalFile, checkedZip} = require('../src/project');
const {atomicWrite} = require('../src/project');
const path = require('node:path');

const integer = (value, label, min, max) => {
  const n = Number(value); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be ${min}..${max}`); return n;
};
const download = (url, timeout) => new Promise((resolve, reject) => {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['assets.scratch.mit.edu', 'cdn.assets.scratch.mit.edu'].includes(parsed.hostname) || parsed.port || parsed.username || parsed.password) {
    reject(new Error('Only HTTPS official Scratch asset hosts are allowed')); return;
  }
  let finished = false;
  const finish = (error, data) => {
    if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(data);
  };
  const request = https.get(parsed, {headers: {'User-Agent': 'tw-cli-frozen-library/1', 'Accept-Encoding': 'identity'}}, response => {
    if (response.statusCode !== 200) {response.resume(); finish(new Error(`HTTP ${response.statusCode}; redirects are not followed`)); request.destroy(); return;}
    const chunks = []; let size = 0;
    response.on('data', data => {size += data.length; if (size > 32 * 1024 * 1024) {request.destroy(new Error('Asset exceeds 32 MiB')); return;} chunks.push(data);});
    response.on('error', error => finish(error));
    response.on('end', () => finish(null, Buffer.concat(chunks)));
  });
  const timer = setTimeout(() => request.destroy(new Error(`Request timed out after ${timeout} ms`)), timeout);
  request.on('error', error => finish(error));
});
const recoverRelease = async (store, records, version, budget, localArchive) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Official desktop release must be a numeric version');
  const exec = promisify(require('node:child_process').execFile);
  const url = `https://github.com/TurboWarp/desktop/releases/download/v${version}/TurboWarp-linux-armv7l-${version}.tar.gz`;
  const headers = localArchive ? {stdout: `content-length: ${(await fs.stat(localArchive)).size}`} : await exec('curl', ['--fail', '--silent', '--show-error', '--head', '--location', '--connect-timeout', '4', '--max-time', '12',
    '--proto', '=https', '--proto-redir', '=https', '--retry', '1', '--retry-delay', '0', '--retry-max-time', '15', url], {timeout: 20000, maxBuffer: 1024 * 1024});
  const lengths = [...headers.stdout.matchAll(/content-length:\s*(\d+)/gi)];
  const size = Number(lengths.at(-1)?.[1]);
  if (!size || size > 200 * 1024 * 1024) throw new Error('Official archive must have confirmed size <= 200 MiB');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-cli-release-'));
  const file = localArchive ? path.resolve(localArchive) : path.join(dir, 'release.tar.gz');
  const deadline = Date.now() + budget;
  try {
    if (!localArchive) await exec('curl', ['--fail', '--silent', '--show-error', '--location', '--connect-timeout', '4', '--max-time', String(Math.floor(budget / 1000)),
      '--max-filesize', String(200 * 1024 * 1024), '--proto', '=https', '--proto-redir', '=https', '--output', file, url],
    {timeout: budget + 3000, maxBuffer: 1024 * 1024});
    if ((await fs.stat(file)).size !== size) throw new Error('Release archive size differs from HEAD');
    const listing = await exec('tar', ['-tzf', file], {timeout: 15000, maxBuffer: 4 * 1024 * 1024});
    const paths = listing.stdout.trim().split('\n').filter(name => name.endsWith('/resources/app.asar'));
    if (paths.length !== 1 || paths[0].includes('..') || path.isAbsolute(paths[0])) throw new Error('Release must contain one safe resources/app.asar path');
    const asarFile = path.join(dir, 'app.asar');
    // Stream a single archive member to a private file; never unpack arbitrary
    // paths, symlinks, executable binaries, or start the packaged app.
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xOzf', file, paths[0]], {stdio: ['ignore', 'pipe', 'pipe']});
      const output = require('node:fs').createWriteStream(asarFile, {flags: 'wx', mode: 0o600});
      const timer = setTimeout(() => {child.kill(); reject(new Error('Release extraction budget exhausted'));}, Math.max(1000, deadline - Date.now()));
      let stderr = '', bytes = 0;
      child.stderr.on('data', data => {stderr = (stderr + data).slice(-1000);});
      child.stdout.on('data', data => {bytes += data.length; if (bytes > 400 * 1024 * 1024) {child.kill(); output.destroy(); reject(new Error('ASAR exceeds 400 MiB'));}});
      child.stdout.pipe(output); output.on('error', reject); child.on('error', reject);
      child.on('close', code => {clearTimeout(timer); code === 0 ? output.on('finish', resolve) : reject(new Error(`tar failed: ${stderr}`)); if (code === 0 && output.writableFinished) resolve();});
    });
    const asar = require('../../desktop-master/node_modules/@electron/asar');
    const files = asar.listPackage(asarFile).filter(name => /(?:^|\/)dist-library-files\/[a-f0-9]{32}\.[a-z]+\.br$/.test(name));
    const result = {source: url, releaseBytes: size, downloaded: 0, recoveredRelease: 0, alreadyVerified: 0, failed: []};
    for (const record of records) {
      const name = assetName(record);
      try {await store.readAsset(name); result.alreadyVerified++; continue;} catch (error) {
        if (!error.message.startsWith('Missing frozen library asset:')) {result.failed.push({name, error: error.message}); continue;}
      }
      const candidates = files.filter(file => file.endsWith(`/${name}.br`));
      if (candidates.length !== 1) continue;
      try {
        const compressed = asar.extractFile(asarFile, candidates[0].replace(/^\//, ''));
        verifyAsset(brotliDecompressSync(compressed, {maxOutputLength: 32 * 1024 * 1024}), record);
        await atomicWrite(path.join(store.directory, `${name}.br`), compressed);
        await store.readAsset(name); result.recoveredRelease++;
      } catch (error) {result.failed.push({name, error: error.message});}
    }
    const status = await store.status();
    return {...result, directory: store.directory, expectedTotal: status.expected, availableTotal: status.available, missingTotal: status.missing, invalid: status.invalid};
  } finally {await fs.rm(dir, {recursive: true, force: true});}
};
const run = async argv => {
  const options = {};
  const allowed = new Set(['asset', 'kind', 'name', 'dir', 'limit', 'timeout-ms', 'retries', 'concurrency', 'budget-ms', 'local-archive', 'desktop-release', 'release-archive']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Use --asset ID.ext, --kind KIND --name NAME, or --limit N, with optional --dir/--timeout-ms/--retries/--concurrency/--budget-ms');
    options[key] = argv[i + 1];
  }
  const timeout = integer(options['timeout-ms'] || 4000, 'timeout-ms', 100, 30000);
  const retries = integer(options.retries || 1, 'retries', 1, 3);
  const concurrency = integer(options.concurrency || 4, 'concurrency', 1, 8);
  const budget = integer(options['budget-ms'] || 90000, 'budget-ms', 1000, 540000);
  const limit = integer(options.limit || 1304, 'limit', 1, 1304);
  if (options.asset && (options.kind || options.name) || options.name && !options.kind || options.kind && !options.name) throw new Error('Choose --asset or --kind with --name');
  if (options['release-archive'] && !options['desktop-release']) throw new Error('--release-archive requires --desktop-release VERSION');
  if (options['desktop-release'] && options['local-archive']) throw new Error('Choose one explicit recovery source');
  const store = new LibraryStore(options.dir);
  let records = await store.manifest();
  if (options.asset) records = [await store.record(options.asset)];
  else if (options.kind) {
    const entry = await store.select(options.kind, options.name);
    const names = entry.md5ext ? [entry.md5ext] : [...entry.costumes, ...entry.sounds].map(asset => asset.md5ext);
    records = await Promise.all([...new Set(names)].map(name => store.record(name)));
  }
  records = records.slice(0, limit);
  if (options['desktop-release']) return recoverRelease(store, records, options['desktop-release'], budget, options['release-archive']);
  if (options['local-archive']) {
    const zip = await checkedZip(await readLocalFile(options['local-archive']));
    const result = {directory: store.directory, source: path.resolve(options['local-archive']), downloaded: 0, recoveredLocal: 0, alreadyVerified: 0, failed: []};
    for (const entry of Object.values(zip.files)) {
      if (entry.dir || entry._data.uncompressedSize > 32 * 1024 * 1024) continue;
      const data = await entry.async('nodebuffer');
      const record = records.find(record => record.md5 === md5(data) && record.sha256 === sha256(data));
      if (!record) continue;
      const name = assetName(record);
      try {await store.readAsset(name); result.alreadyVerified++;} catch (error) {
        if (!error.message.startsWith('Missing frozen library asset:')) {result.failed.push({name, error: error.message}); continue;}
        verifyAsset(data, record);
        await atomicWrite(path.join(store.directory, `${name}.br`), brotliCompressSync(data));
        await store.readAsset(name); result.recoveredLocal++;
      }
    }
    const status = await store.status();
    return {...result, expectedTotal: status.expected, availableTotal: status.available, missingTotal: status.missing, invalid: status.invalid};
  }
  const deadline = Date.now() + budget;
  const result = {directory: store.directory, selected: records.length, downloaded: 0, alreadyVerified: 0, failed: [], skippedByBudget: 0, attempts: 0};
  let cursor = 0;
  await Promise.all(Array.from({length: concurrency}, async () => {
    while (cursor < records.length) {
      const record = records[cursor++], name = assetName(record);
      try {await store.readAsset(name); result.alreadyVerified++; continue;} catch (error) {
        if (!error.message.startsWith('Missing frozen library asset:')) {result.failed.push({name, error: error.message}); continue;}
      }
      if (Date.now() >= deadline) {result.skippedByBudget++; continue;}
      let lastError;
      let done = false;
      for (let retry = 0; retry < retries && !done; retry++) for (const host of ['assets.scratch.mit.edu', 'cdn.assets.scratch.mit.edu']) {
        if (Date.now() >= deadline) break;
        result.attempts++;
        try {
          const url = new URL(record.src); url.hostname = host;
          const data = verifyAsset(await download(url, Math.min(timeout, deadline - Date.now())), record);
          await atomicWrite(path.join(store.directory, `${name}.br`), brotliCompressSync(data));
          await store.readAsset(name); result.downloaded++; done = true; break;
        } catch (error) {lastError = error.message;}
      }
      if (!done) result.failed.push({name, error: lastError || 'Total download budget exhausted'});
    }
  }));
  const status = await store.status();
  return {...result, expectedTotal: status.expected, availableTotal: status.available, missingTotal: status.missing, invalid: status.invalid};
};
if (require.main === module) run(process.argv.slice(2)).then(result => {
  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length || result.skippedByBudget || result.invalid.length) process.exitCode = 1;
}).catch(error => {console.error(error.message); process.exitCode = 1;});
module.exports = {run, download};
