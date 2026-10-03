const assert = require('node:assert/strict');
const {test} = require('node:test');
const {spawnSync} = require('node:child_process');
const path = require('node:path');

const probe = source => {
  const result = spawnSync(process.execPath, ['-e', source], {encoding: 'utf8', timeout: 10000,
    env: {...process.env, DISABLE_SYSTEM_FONTS_LOAD: ''}});
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('production native bootstrap prevents host-font discovery before first canvas import', () => {
  for (const file of ['native-renderer', 'font-commands', 'project', 'device-adapters', 'package-commands', 'asset-commands', 'editor-commands', 'record-worker']) {
    const module = path.resolve(__dirname, '../src/' + file);
    const result = probe(`require(${JSON.stringify(module)});
      const {GlobalFonts}=require(${JSON.stringify(require.resolve('@napi-rs/canvas'))});
      process.stdout.write(JSON.stringify({disabled:process.env.DISABLE_SYSTEM_FONTS_LOAD,families:GlobalFonts.families.length}));`);
    assert.equal(result.disabled, '1', file); assert.equal(result.families, 0, file);
  }
});

test('pinned renderer registers and releases only seven frozen faces plus their aliases', () => {
  const result = probe(`const {NativeRenderer}=require(${JSON.stringify(path.resolve(__dirname, '../src/native-renderer'))});
    const {GlobalFonts}=require(${JSON.stringify(require.resolve('@napi-rs/canvas'))});
    const count=()=>GlobalFonts.families.length;
    const before=count(),renderer=new NativeRenderer(),during=count();
    const metrics=renderer.measureFontText('Sans Serif','Hello WWW iii',24);
    renderer.dispose();process.stdout.write(JSON.stringify({before,during,after:count(),metrics}));`);
  assert.equal(result.before, 0); assert.equal(result.during, 14); assert.equal(result.after, 0);
  assert.ok(Math.abs(result.metrics.width - 159.1699981689453) < 0.00001);
  assert.equal(result.metrics.hostFonts, false);
});
