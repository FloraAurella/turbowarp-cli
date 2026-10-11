'use strict';
// Build for the current, verified macOS architecture. No npm install or changes
// to the checkout/dependency lock occur here; provide an isolated esbuild path.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const JSZip = require('@turbowarp/jszip');
const root = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const projectSuffix = /\.(?:sb|sb2|sb3|sprite2|sprite3|blend)$/i;
const binarySuffix = /\.(?:node|dylib|dll|so(?:\.\d+)*|exe|a|o|wasm|png|jpg|jpeg|gif|webp|bmp|wav|mp3|ogg|ttf|otf|woff2?|zip|gz|br)$/i;
const excludedDirectory = new Set(['.git', '.bin', '.cache', 'test', 'tests', '__tests__', '__test__', 'fixtures', 'examples', 'benchmark', 'benchmarks', 'obj.target']);
const walk = async (base, relative = '', dependency = false) => {
  const result = [];
  for (const entry of await fs.readdir(path.join(base, relative), {withFileTypes: true})) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      if (dependency && name.split('/').includes('.bin')) continue;
      throw new Error('Portable build refuses symlinks: ' + name);
    }
    if (entry.isDirectory()) {
      if (dependency && excludedDirectory.has(entry.name)) continue;
      result.push(...await walk(base, name, dependency));
    } else if (entry.isFile()) {
      if (projectSuffix.test(name)) continue;
      if (dependency && (/\.o$/i.test(name) || /node-web-audio-api\/(?:node-web-audio-api\.(?!darwin-arm64\.node)[^/]+\.node)$/.test(name))) continue;
      result.push(name);
    } else throw new Error('Portable build refuses special files: ' + name);
  }
  return result.sort();
};
const write = async (base, filename, bytes, mode = 0o444) => {
  const full = path.join(base, filename);
  await fs.mkdir(path.dirname(full), {recursive: true});
  await fs.writeFile(full, bytes, {mode});
  await fs.chmod(full, mode);
};
const zipTree = async (base, destination, prefix = '') => {
  const files = await walk(base), zip = new JSZip();
  for (const file of files) {
    const stat = await fs.stat(path.join(base, file));
    zip.file(prefix + file, await fs.readFile(path.join(base, file)), {unixPermissions: 0o100000 | (stat.mode & 0o777)});
  }
  const bytes = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: {level: 6}, platform: 'UNIX'});
  const temporary = destination + '.partial';
  await fs.writeFile(temporary, bytes, {flag: 'wx'});
  try {await fs.link(temporary, destination);} finally {await fs.unlink(temporary);}
  return {path: destination, bytes: bytes.length, sha256: hash(bytes), files: files.length};
};
const main = async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '24') throw new Error('Portable builder currently supports macOS arm64 on Node.js 24 only');
  const esbuild = require(process.env.TW_PORTABLE_ESBUILD || 'esbuild');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version, folder = `tw-cli-v${version}-macos-arm64`;
  const output = path.resolve(process.argv[2] || path.join(root, 'releases'));
  await fs.mkdir(output, {recursive: true});
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-portable-stage-'));
  const payload = path.join(staging, folder), dependencySources = path.join(staging, 'dependency-sources');
  await fs.mkdir(payload); await fs.mkdir(dependencySources);
  try {
    const compilation = [];
    for (const directory of ['src', 'bin']) for (const name of await walk(path.join(root, directory))) {
      const file = `${directory}/${name}`, source = await fs.readFile(path.join(root, file));
      if (name.endsWith('.js')) {
        const transformed = await esbuild.transform(source.toString('utf8'), {loader: 'js', format: 'cjs', platform: 'node', target: 'node24', minifyWhitespace: true,
          legalComments: 'inline', sourcefile: file});
        await write(payload, `dist/${file}`, transformed.code);
        compilation.push({file, sourceSha256: hash(source), compiledSha256: hash(Buffer.from(transformed.code))});
      } else await write(payload, `dist/${file}`, source);
    }
    for (const directory of ['resources', 'vendor', 'LICENSES']) for (const name of await walk(path.join(root, directory))) {
      await write(payload, `dist/${directory}/${name}`, await fs.readFile(path.join(root, directory, name)));
    }
    for (const name of ['baseline.json', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
      const bytes = await fs.readFile(path.join(root, name));
      await write(payload, `dist/${name}`, bytes);
      if (name !== 'baseline.json') await write(payload, name, bytes);
    }
    for (const name of ['docs/addons-inventory.json', 'docs/census/m1-census.json', 'docs/acceptance-evidence.json']) {
      const bytes = (await fs.readFile(path.join(root, name), 'utf8')).replace(/\/Users\/[^"\s]+/g, '[local-path-redacted]');
      await write(payload, `dist/${name}`, bytes);
    }
    const packages = [], dependencyFiles = await walk(path.join(root, 'node_modules'), '', true);
    for (const name of dependencyFiles) {
      const bytes = await fs.readFile(path.join(root, 'node_modules', name));
      await write(payload, `dist/node_modules/${name}`, bytes);
      if (!binarySuffix.test(name) && !projectSuffix.test(name)) await write(dependencySources, `node_modules/${name}`, bytes);
      if (name.endsWith('/package.json')) {
        try {
          const record = JSON.parse(bytes);
          if (record.name && record.version) packages.push({path: name, name: record.name, version: record.version,
            license: record.license || record.licenses || null, repository: record.repository || null, packageSha256: hash(bytes)});
        } catch {}
      }
    }
    // Relocate ANGLE: the local node-gyp build embeds an absolute checkout path.
    const addon = path.join(payload, 'dist/node_modules/node-gles-webgl2/build/Release/nodejs_gl_binding.node');
    await fs.chmod(addon, 0o644);
    const commands = execFileSync('/usr/bin/otool', ['-l', addon], {encoding: 'utf8'});
    const oldRpath = commands.match(/cmd LC_RPATH[\s\S]*?path ([^\n]+) \(offset/)[1];
    execFileSync('/usr/bin/install_name_tool', ['-rpath', oldRpath, '@loader_path/../../../@dsafdsaf132/node-gles-webgl2-darwin-arm64', addon]);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', addon], {stdio: 'pipe'});
    await fs.chmod(addon, 0o444);
    await write(payload, 'runtime/node', await fs.readFile(process.execPath), 0o555);
    await write(payload, 'runtime/NODE-LICENSE', await fs.readFile(path.resolve(process.execPath, '../../LICENSE')));
    await write(payload, 'index.d.ts', await fs.readFile(path.join(root, 'index.d.ts')));
    await write(payload, 'dist/package.json', JSON.stringify({...pkg, main: './src/sdk-entry.js', types: '../index.d.ts', exports: undefined}, null, 2) + '\n');
    await write(payload, 'sdk.cjs', "require('./verify.cjs'); module.exports = require('./dist/src/sdk-entry.js');\n");
    await write(payload, 'package.json', JSON.stringify({name: pkg.name, version, private: true, type: 'commonjs', main: './sdk.cjs', types: './index.d.ts', exports: {'.': {types: './index.d.ts', default: './sdk.cjs'}}}, null, 2) + '\n');
    const inventory = {version: 1, node: process.versions.node, compiler: {name: 'esbuild', version: esbuild.version},
      platform: process.platform, arch: process.arch, builtOnMacOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], {encoding: 'utf8'}).trim(), compilation, packages,
      externalRequirements: {core: 'macOS system libraries only; Node and ANGLE included', optionalRecording: 'User-authorized external ffmpeg; not bundled'},
      correspondingSources: {cli: `tw-cli-v${version}-source.zip`, dependencies: `tw-cli-v${version}-dependencies-source.zip`,
        resvg: 'tw-cli-resvg-js-v2.6.2-source.zip', node: `https://nodejs.org/dist/v${process.versions.node}/node-v${process.versions.node}.tar.xz`}};
    await write(payload, 'DEPENDENCY-MANIFEST.json', JSON.stringify(inventory, null, 2) + '\n');
    await write(dependencySources, 'DEPENDENCY-MANIFEST.json', JSON.stringify(inventory, null, 2) + '\n');
    await write(payload, 'PORTABLE-README.txt', `tw-cli ${version} — macOS arm64 portable compiled distribution\n\nRun ./tw from any working directory. Node.js 24 and installed dependencies are included.\nJavaScript modules are compiled with esbuild; frozen upstream source modules remain private dependencies because the VM and renderer load/transform them dynamically.\nNo npm install or source checkout is needed. Core read/edit/run/render uses bundled ANGLE and system frameworks.\nRecording requires separately installed, explicitly authorized ffmpeg. No ffmpeg is bundled.\nNo Scratch project files or local examples are distributed. Edit your own project with:\n  ./tw project read --project /absolute/input.sb3 --target Sprite1\n  ./tw project apply /absolute/edit.json --project /absolute/input.sb3 --out /absolute/result.sb3\n\nDefault runtime files are read-only and checked against PORTABLE-MANIFEST.json on launch. Integrity protection detects changes; an owner can still replace the launcher. This is not a security sandbox or source-obfuscation promise.\nSDK: use runtime/node to run a script requiring this folder.\nCorresponding CLI/dependency/resvg source archives are published next to this download; Node source: ${inventory.correspondingSources.node}\nSee LICENSE, THIRD_PARTY_NOTICES.md, dist/LICENSES, dependency licenses in dist/node_modules, runtime/NODE-LICENSE.\n`);
    const manifest = {version: 1, name: folder, files: {}};
    for (const name of await walk(payload)) {
      const bytes = await fs.readFile(path.join(payload, name));
      manifest.files[name] = {bytes: bytes.length, sha256: hash(bytes)};
    }
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    await write(payload, 'PORTABLE-MANIFEST.json', manifestBytes);
    await write(payload, 'verify.cjs', `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const root=__dirname;const hash=b=>crypto.createHash('sha256').update(b).digest('hex');const data=fs.readFileSync(path.join(root,'PORTABLE-MANIFEST.json'));if(hash(data)!=='${hash(manifestBytes)}')throw Error('Portable manifest changed');for(const [name,expected] of Object.entries(JSON.parse(data).files)){const file=path.join(root,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expected.bytes||hash(fs.readFileSync(file))!==expected.sha256)throw Error('Portable integrity mismatch: '+name);}\n`);
    await write(payload, 'tw', '#!/bin/sh\nset -eu\nTW_PORTABLE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nunset NODE_OPTIONS NODE_PATH TW_NODE\n"$TW_PORTABLE_ROOT/runtime/node" "$TW_PORTABLE_ROOT/verify.cjs"\nexec "$TW_PORTABLE_ROOT/runtime/node" "$TW_PORTABLE_ROOT/dist/bin/tw.js" "$@"\n', 0o555);
    const sources = await zipTree(dependencySources, path.join(output, `tw-cli-v${version}-dependencies-source.zip`), 'tw-cli-dependencies-source/');
    const result = await zipTree(payload, path.join(output, folder + '.zip'), folder + '/');
    console.log(JSON.stringify({portable: result, dependencySources: sources, packages: packages.length, compiledModules: compilation.length}, null, 2));
  } finally {await fs.rm(staging, {recursive: true, force: true});}
};
main().catch(error => {console.error(error); process.exitCode = 1;});
