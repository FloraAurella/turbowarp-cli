'use strict';

require('../src/native-environment');
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {existsSync} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {once} = require('node:events');
const {createServer} = require('../protected-preview/server');
const {createDemo} = require('../src/protected/demo');
const {buildHTML} = require('../src/protected');
const {createFeatureFixture} = require('./helpers/protected-feature-fixture');
const {launchBrowser} = require('./helpers/protected-browser');

const browserAvailable = existsSync(process.env.PROTECTED_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const artifacts = path.resolve(__dirname, '../protected-preview/artifacts');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const exceptions = browser => browser.events.filter(event => event.method === 'Runtime.exceptionThrown')
  .map(event => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);

test('real upload, isolated playable preview, download, mobile layout and offline HTML', {skip: !browserAvailable, timeout: 90000}, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scratch-aot-upload-'));
  const bytes = await createDemo();
  const input = path.join(temp, '用户上传.sb3');
  await fs.writeFile(input, bytes);
  await fs.mkdir(artifacts, {recursive: true});
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchBrowser();
  try {
    await browser.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
    await browser.send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: temp});
    await browser.send('Page.navigate', {url: base});
    await browser.waitFor('document.getElementById("compile") && typeof chooseFile === "function"');
    const dom = await browser.send('DOM.getDocument');
    const fileInput = await browser.send('DOM.querySelector', {nodeId: dom.root.nodeId, selector: '#file-input'});
    await browser.send('DOM.setFileInputFiles', {nodeId: fileInput.nodeId, files: [input]});
    await browser.waitFor('!document.getElementById("compile").disabled');
    await browser.evaluate('document.getElementById("compile").click()');
    await browser.waitFor('document.getElementById("preview-state").textContent.includes("已就绪")', 40000);
    const preview = await browser.evaluate('({src:document.getElementById("player").src,download:document.getElementById("download").download})');
    assert.equal(new URL(preview.src).hostname, 'localhost');
    assert.equal(new URL(preview.src).port, String(server.address().port));
    assert.equal(preview.download, '用户上传.html');
    const frameSession = browser.events.find(event => event.method === 'Target.attachedToTarget' && event.params.targetInfo.type === 'iframe').params.sessionId;
    await browser.send('Runtime.enable', {}, frameSession);
    const evaluateFrame = async expression => {
      const result = await browser.send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true}, frameSession);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    assert.equal(await evaluateFrame('typeof window.__protectedDebug'), 'undefined');
    assert.equal(await evaluateFrame('document.querySelectorAll("canvas").length'), 1);
    const iframeRect = await browser.evaluate('(()=>{const r=document.getElementById("player").getBoundingClientRect();return {x:r.x,y:r.y}})()');
    const startRect = await evaluateFrame('(()=>{const r=document.getElementById("green-flag").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    const startPoint = {x: iframeRect.x + startRect.x, y: iframeRect.y + startRect.y};
    await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...startPoint, button: 'left', buttons: 1, clickCount: 1});
    await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...startPoint, button: 'left', buttons: 0, clickCount: 1});
    await pause(100);
    await browser.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39}, frameSession);
    await pause(250);
    await browser.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39}, frameSession);
    assert.equal(await evaluateFrame('document.getElementById("status").textContent'), '运行中');
    // OOPIF WebGL buffers can be omitted from full-page screenshots in headless
    // Chrome. Artwork and movement are asserted separately from renderer pixels.
    const after = await browser.send('Page.captureScreenshot');
    await fs.writeFile(path.join(artifacts, 'workbench.png'), Buffer.from(after.data, 'base64'));
    assert.equal(await evaluateFrame('(()=>{try{void parent.document;return false}catch(e){return e.name==="SecurityError"}})()'), true);
    await browser.evaluate('document.getElementById("download").click()');
    const download = path.join(temp, preview.download);
    for (let i = 0; i < 100 && !existsSync(download); i++) await pause(50);
    assert.ok(existsSync(download), 'real browser download completed');
    const html = await fs.readFile(download, 'utf8');
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.ok(!html.includes('EDITOR_ONLY_PROTECTED_DEMO'));
    assert.ok(!html.includes('demo_author_block_'));
    assert.ok(!html.includes('window.__protectedDebug='));
    assert.ok(html.includes('id="third-party-notices"'));
    assert.deepEqual(await fs.readFile(input), bytes, 'uploaded original is unchanged');
    await fs.copyFile(download, path.join(artifacts, 'orbit-demo.protected.html'));
    await browser.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth<=window.innerWidth'), true);
    assert.ok(await browser.evaluate('document.getElementById("player").getBoundingClientRect().height>=380'), 'narrow preview retains stage space after toolbar wraps');
    const mobile = await browser.send('Page.captureScreenshot', {captureBeyondViewport: true});
    await fs.writeFile(path.join(artifacts, 'workbench-mobile.png'), Buffer.from(mobile.data, 'base64'));
    await browser.send('Emulation.clearDeviceMetricsOverride');
    assert.deepEqual(exceptions(browser), []);
    await browser.send('Network.emulateNetworkConditions', {offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    await browser.send('Page.navigate', {url: pathToFileURL(download).href});
    await browser.waitFor('!!window.protectedPlayer');
    await browser.evaluate('protectedPlayer.ready');
    await browser.evaluate('protectedPlayer.start()');
    assert.equal(await browser.evaluate('document.getElementById("status").textContent'), '运行中');
    assert.equal(await browser.evaluate('typeof window.__protectedDebug'), 'undefined');
    assert.deepEqual(exceptions(browser), []);
    const offline = await browser.send('Page.captureScreenshot');
    await fs.writeFile(path.join(artifacts, 'offline-player.png'), Buffer.from(offline.data, 'base64'));
  } finally {
    await browser.close();
    await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
    await fs.rm(temp, {recursive: true, force: true});
  }
});

test('offline real compiled ask, music notes/drums and WAV audio run without reading blocks', {skip: !browserAvailable, timeout: 60000}, async () => {
  await fs.mkdir(artifacts, {recursive: true});
  const output = path.join(artifacts, 'features.debug.html');
  const result = await buildHTML(await createFeatureFixture(), {title: '音频与问答验证'}, {exposeDebug: true});
  await fs.writeFile(output, result.html);
  const browser = await launchBrowser();
  try {
    await browser.send('Network.emulateNetworkConditions', {offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    await browser.send('Page.navigate', {url: pathToFileURL(output).href});
    await browser.waitFor('!!window.protectedPlayer');
    await browser.evaluate('protectedPlayer.ready');
    await browser.evaluate(`window.audioStarts=[];const saved=AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start=function(...args){audioStarts.push({duration:this.buffer?.duration,channels:this.buffer?.numberOfChannels});return saved.apply(this,args)};
      for(const target of __protectedDebug.vm.runtime.targets){for(const method of ['getBlock','getScripts','getOpcode','getNextBlock','getBranch','getInputs'])target.blocks[method]=()=>{throw new Error('Unexpected source graph read')}};
      protectedPlayer.start()`);
    await browser.waitFor('document.querySelector("input")');
    await browser.evaluate('document.querySelector("input").focus()');
    await browser.send('Input.insertText', {text: 'AOT-ok'});
    await browser.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13});
    await browser.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13});
    await browser.waitFor('__protectedDebug.vm.runtime.getTargetForStage().variables.score.value===123');
    const state = await browser.evaluate(`({variables:Object.fromEntries(Object.entries(__protectedDebug.vm.runtime.getTargetForStage().variables).map(([k,v])=>[k,v.value])),
      audioStarts, audioState:__protectedDebug.scaffolding.audioEngine.audioContext.state,
      threads:__protectedDebug.vm.runtime.threads.length,sourceBlocks:__protectedDebug.vm.runtime.targets.reduce((n,t)=>n+Object.keys(t.blocks._blocks).length,0)})`);
    assert.deepEqual(state.variables, {qdone: 1, musicdone: 1, sounddone: 1, answer: 'AOT-ok', score: 123});
    assert.ok(state.audioStarts.length >= 3);
    assert.ok(state.audioStarts.every(item => item.duration > 0 && item.channels > 0));
    assert.equal(state.audioState, 'running');
    assert.equal(state.threads, 0); assert.equal(state.sourceBlocks, 0);
    assert.deepEqual(exceptions(browser), []);
    const externalRequests = browser.events.filter(event => event.method === 'Network.requestWillBeSent' && /^https?:/.test(event.params.request.url));
    assert.deepEqual(externalRequests, []);
    await fs.writeFile(path.join(artifacts, 'browser-features.json'), JSON.stringify(state, null, 2));
  } finally {await browser.close();}
});

test('offline artwork and real arrow input move compiled sprite pixels without source graph reads', {skip: !browserAvailable, timeout: 60000}, async () => {
  const {inspectOrbitPNG} = require('./helpers/protected-artwork');
  await fs.mkdir(artifacts, {recursive: true});
  const output = path.join(artifacts, 'orbit-render.debug.html');
  const compiled = await buildHTML(await createDemo(), {title: '渲染与输入验证'}, {exposeDebug: true});
  await fs.writeFile(output, compiled.html);
  const browser = await launchBrowser();
  try {
    await browser.send('Network.emulateNetworkConditions', {offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1});
    await browser.send('Page.navigate', {url: pathToFileURL(output).href});
    await browser.waitFor('!!window.protectedPlayer');
    await browser.evaluate('protectedPlayer.ready');
    await browser.evaluate(`for(const target of __protectedDebug.vm.runtime.targets){
      for(const method of ['getBlock','getScripts','getOpcode','getNextBlock','getBranch','getInputs']){
        target.blocks[method]=()=>{throw new Error('Unexpected source graph read: '+method)};
      }
    }`);
    // The renderer deliberately skips unchanged frames and WebGL discards its
    // drawing buffer after composition. Force a draw inside the same evaluation
    // as the snapshot so the test inspects real pixels rather than a blank buffer.
    const snapshot = async () => Buffer.from((await browser.evaluate(`(()=>{
      const renderer=__protectedDebug.scaffolding.renderer;
      renderer.dirty=true;renderer.draw();return renderer.canvas.toDataURL();
    })()`)).split(',')[1], 'base64');
    const readyPixels = await inspectOrbitPNG(await snapshot());
    assert.ok(readyPixels.backdropFraction > 0.25, 'initial stopped frame contains the blue Orbit artwork');
    assert.ok(readyPixels.shipPixels > 100, 'initial stopped frame contains the orange ship');
    const point = await browser.evaluate('(()=>{const r=document.getElementById("green-flag").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await browser.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1});
    await browser.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1});
    await browser.waitFor('document.getElementById("status").textContent==="运行中"');
    const before = await inspectOrbitPNG(await snapshot());
    const startX = await browser.evaluate('__protectedDebug.vm.runtime.targets[1].x');
    await browser.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39});
    await browser.waitFor('__protectedDebug.vm.runtime.targets[1].x>12');
    await browser.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39});
    const endX = await browser.evaluate('__protectedDebug.vm.runtime.targets[1].x');
    const afterPNG = await snapshot();
    const after = await inspectOrbitPNG(afterPNG);
    assert.ok(endX > startX + 5, 'real keyboard input moves the sprite state');
    assert.ok(after.shipPixels > 100 && after.backdropFraction > 0.25, 'moving frame retains valid artwork');
    assert.ok(after.shipCentroidX > before.shipCentroidX + 5, 'the rendered ship actually moves to the right');
    assert.equal(await browser.evaluate('__protectedDebug.vm.runtime.targets.reduce((n,t)=>n+Object.keys(t.blocks._blocks).length,0)'), 0);
    assert.deepEqual(exceptions(browser), []);
    await fs.writeFile(path.join(artifacts, 'orbit-render-evidence.json'), JSON.stringify({readyPixels, before, after, startX, endX,
      centroidDeltaX: after.shipCentroidX - before.shipCentroidX}, null, 2));
    await fs.writeFile(path.join(artifacts, 'orbit-runtime.png'), afterPNG);
  } finally {await browser.close();}
});
