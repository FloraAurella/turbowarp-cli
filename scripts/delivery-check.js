const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const steps = [
  ['resources', [path.join(root, 'scripts/check-resources.js')], 0],
  ['tutorial', [path.join(root, 'scripts/tutorial-smoke.js')], 0],
  ['release', [path.join(root, 'scripts/release-check.js')], 2]
];
const results = [];
for (const [name, argv, expected] of steps) {
  const child = spawnSync(process.execPath, argv, {cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024});
  let result; try {result = JSON.parse(child.stdout);} catch {result = {stdout: child.stdout, stderr: child.stderr};}
  results.push({name, exitCode: child.status, expected, result, error: child.error?.message});
}
const passed = results.every(step => step.exitCode === step.expected && !step.error) && results.find(step => step.name === 'release')?.result.releaseReady === false;
const report = {experimentalDeliveryVerified: passed, fullParityReady: false, node: process.versions.node, platform: process.platform,
  arch: process.arch, steps: results, note: 'Exit 2 from the release gate is required while full GUI parity is not accepted; this is not a full-parity release.'};
const directory = path.join(root, 'docs/verification'); fs.mkdirSync(directory, {recursive: true});
fs.writeFileSync(path.join(directory, 'delivery-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = passed ? 0 : 1;
