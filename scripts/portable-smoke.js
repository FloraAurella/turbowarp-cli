'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const JSZip = require('@turbowarp/jszip');
const main = async () => {
  const archive = path.resolve(process.argv[2]);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-portable-clean-smoke-'));
  const zip = await JSZip.loadAsync(await fs.readFile(archive));
  for (const [name, entry] of Object.entries(zip.files)) {
    assert(!/\.(?:sb|sb2|sb3|sprite2|sprite3|blend)$/i.test(name), 'Project leaked into portable: ' + name);
    assert(!name.split('/').includes('..') && !path.isAbsolute(name));
    const filename = path.join(workspace, name);
    if (entry.dir) {await fs.mkdir(filename, {recursive: true}); continue;}
    await fs.mkdir(path.dirname(filename), {recursive: true});
    await fs.writeFile(filename, await entry.async('nodebuffer'), {mode: Number(entry.unixPermissions) & 0o777 || 0o444});
  }
  const folder = Object.keys(zip.files).find(name => name.endsWith('/tw')).split('/')[0];
  const portable = path.join(workspace, folder), launcher = path.join(portable, 'tw');
  const env = {...process.env, PATH: '/usr/bin:/bin', TW_NODE: '/missing/tw-node', NODE_PATH: '/missing/node-modules', NODE_OPTIONS: '--invalid-portable-guard-test'};
  const checks = [];
  const command = (args, {json = true, expected = 0} = {}) => {
    const result = spawnSync(launcher, args, {cwd: workspace, env, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024});
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expected, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    checks.push(args.join(' '));
    return json ? JSON.parse(result.stdout) : result;
  };
  const doctor = command(['doctor', '--json']);
  assert.equal(doctor.ok, true); assert.equal(doctor.selected.path, await fs.realpath(path.join(portable, 'runtime/node')));
  const original = path.join(workspace, 'original.sb3'), initial = path.join(workspace, 'initial.sb3');
  command(['new', original]);
  command(['script', 'demo', '17', '--project', original, '--out', initial]);
  const view = command(['project', 'read', '--project', initial, '--target', 'Sprite1']);
  const matches = command(['project', 'find', 'motion_movesteps', '--project', initial, '--target', 'Sprite1']);
  assert.equal(matches.length, 1);
  const edit = path.join(workspace, 'edit.json'), applied = path.join(workspace, 'applied.sb3');
  await fs.writeFile(edit, JSON.stringify({version: 1, baseRevision: view.revision, operations: [
    {op: 'block.update', target: 'Sprite1', id: matches[0].id, inputs: {STEPS: 33}}
  ]}));
  assert.equal(command(['project', 'validate', edit, '--project', initial]).valid, true);
  assert.equal(command(['project', 'apply', edit, '--project', initial, '--out', applied]).changed, true);
  command(['project', 'read', '--project', applied, '--target', 'Sprite1']);
  assert.equal(command(['run', '--project', applied, '--frames', '2', '--seed', '19']).targets.find(target => target.name === 'Sprite1').x, 33);
  const script = path.join(workspace, 'edit.cjs'), executed = path.join(workspace, 'executed.sb3');
  await fs.writeFile(script, "module.exports = async project => { console.log('portable exec running'); const [block] = await project.find('motion_movesteps'); await project.target(block.target).blocks.update(block.id, {inputs: {STEPS: 41}}); };\n");
  const report = command(['project', 'exec', script, '--project', applied, '--out', executed]);
  assert.equal(report.changed, true);
  command(['project', 'read', '--project', executed, '--target', 'Sprite1']);
  assert.equal(command(['run', '--project', executed, '--frames', '2', '--seed', '19']).targets.find(target => target.name === 'Sprite1').x, 41);
  const image = path.join(workspace, 'render.png');
  command(['render', image, '--project', executed]);
  const png = await fs.readFile(image);
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a'); assert.equal(png.readUInt32BE(16), 480); assert.equal(png.readUInt32BE(20), 360);
  // Native payload must resolve without the original checkout or Homebrew.
  const addon = path.join(portable, 'dist/node_modules/node-gles-webgl2/build/Release/nodejs_gl_binding.node');
  const commands = spawnSync('/usr/bin/otool', ['-l', addon], {encoding: 'utf8'}).stdout;
  assert.match(commands, /@loader_path\/\.\.\/\.\.\/\.\.\/@dsafdsaf132\/node-gles-webgl2-darwin-arm64/);
  const sdk = spawnSync(path.join(portable, 'runtime/node'), ['-e', `const {openProject}=require(${JSON.stringify(portable)}); (async()=>{const project=await openProject(${JSON.stringify(executed)});try{console.log(JSON.stringify(await project.read()));}finally{project.dispose();}})().catch(error=>{console.error(error);process.exitCode=1;});`],
    {cwd: workspace, env: {...env, NODE_OPTIONS: '', NODE_PATH: ''}, encoding: 'utf8', timeout: 30000});
  assert.equal(sdk.status, 0, sdk.stderr); assert.equal(JSON.parse(sdk.stdout).targets.length, 2); checks.push('SDK package entry read/reopen');
  const tampered = path.join(portable, 'dist/src/sdk.js'), intact = await fs.readFile(tampered);
  await fs.chmod(tampered, 0o644); await fs.appendFile(tampered, '\n// smoke tamper\n');
  const rejected = command(['doctor', '--json'], {json: false, expected: 1});
  assert.match(rejected.stderr, /Portable integrity mismatch/);
  await fs.writeFile(tampered, intact); await fs.chmod(tampered, 0o444);
  const result = {ok: true, archive, workspace, platform: process.platform, arch: process.arch, checks, image,
    noProjectsInArchive: true, hostNodeAndNpmNotRequired: true, homebrewNotRequiredForCore: true};
  await fs.writeFile(path.join(workspace, 'smoke-report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
};
main().catch(error => {console.error(error); process.exitCode = 1;});
