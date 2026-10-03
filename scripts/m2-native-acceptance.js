const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const desktop = path.resolve(root, '../desktop-master');
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error(`M2 acceptance requires Node 24; current runtime is ${process.versions.node}. No tests were started.`);
  process.exitCode = 1;
} else {
  const freezeErrors = [];
  const checks = [];
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const check = (label, operation) => {
    try {operation(); checks.push(label);} catch (error) {freezeErrors.push(`${label}: ${error.message}`);}
  };
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'baseline.json')));
  const desktopLock = JSON.parse(fs.readFileSync(path.join(desktop, 'package-lock.json')));
  const cliLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  for (const dependency of ['scratch-render', 'scratch-audio']) {
    check(`${dependency} frozen commit and source equality`, () => {
      for (const lock of [desktopLock, cliLock]) {
        if (!lock.packages[`node_modules/${dependency}`].resolved.endsWith(`#${baseline.pins[dependency]}`)) {
          throw new Error('resolved commit differs from baseline');
        }
      }
      const from = path.join(root, 'node_modules', dependency, 'src');
      const to = path.join(desktop, 'node_modules', dependency, 'src');
      const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const file = path.join(dir, entry.name); return entry.isDirectory() ? walk(file) : [file];
      });
      for (const file of walk(from)) if (hash(fs.readFileSync(file)) !== hash(fs.readFileSync(path.join(to, path.relative(from, file))))) {
        throw new Error(`source mismatch: ${file}`);
      }
    });
  }
  check('GUI audio source manifest and desktop equality', () => {
    const vendor = path.join(root, 'vendor/scratch-gui-audio');
    const manifest = JSON.parse(fs.readFileSync(path.join(vendor, 'UPSTREAM.json')));
    if (manifest.commit !== baseline.pins['scratch-gui']) throw new Error('GUI audio commit differs from baseline');
    for (const [file, expected] of Object.entries(manifest.sha256)) {
      const source = fs.readFileSync(path.join(vendor, file));
      const upstream = fs.readFileSync(path.join(desktop, 'node_modules/scratch-gui/src/lib/audio', file));
      if (hash(source) !== expected || !source.equals(upstream)) throw new Error(`GUI audio source mismatch: ${file}`);
    }
  });
  const files = fs.readdirSync(path.join(root, 'test')).filter(name => /^m2-.*\.js$/.test(name) || ['commands.test.js', 'security.test.js'].includes(name))
    .sort().map(name => path.join(root, 'test', name));
  console.log(JSON.stringify({node: process.versions.node, frozenSourceChecks: checks, freezeErrors, testFiles: files}, null, 2));
  const result = freezeErrors.length ? null : spawnSync(process.execPath, ['--require', path.join(root, 'src/native-environment.js'), '--test', ...files], {
    cwd: root, stdio: 'inherit', timeout: 180000
  });
  console.log(JSON.stringify({
    sourceAndNativeAcceptance: result?.status === 0,
    testExitCode: result?.status ?? null,
    executionError: result?.error?.message ?? null,
    oracleLevels: {
      renderer: 'Analytic RGBA fixtures plus frozen shaders/transforms/canvas geometry; not GUI screenshots',
      audio: 'Frozen GUI graph on the same native DSP, analytic gain/fade/delay checks, and GUI WAV encoder bytes',
      packager: 'Decoded standalone SB3, semantic block/asset roundtrip, script parse and output safety; no runtime execution'
    },
    guiParityClaimed: false,
    missingGuiOracles: [
      'Browser SVG normalization/getBBox for missing viewBox, fractional geometry, fonts and rasterization',
      'Browser WebGL antialiasing/filtering across rotations/effects and text shaping/font fallback',
      'Browser Web Audio compressor lookahead/makeup gain, resampling, robot/echo and automation transients',
      'Packaged HTML/ZIP browser playback, file/http loading and platform runtime behavior',
      'Full frozen library asset corpus (run scripts/check-baseline.js separately)'
    ]
  }, null, 2));
  process.exitCode = freezeErrors.length || result?.error || result?.status !== 0 ? 1 : 0;
}
