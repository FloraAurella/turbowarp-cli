'use strict';

const {compileProject} = require('./compiler');
const {generateRuntime} = require('./runtime-source');
const {Script} = require('node:vm');
const fs = require('node:fs');
const licenseNotices = fs.readFileSync(require.resolve('@turbowarp/packager/dist/scaffolding/scaffolding-full.js.LICENSE.txt'), 'utf8');

const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

async function buildHTML(bytes, {title = '我的 Scratch 作品'} = {}, internal = {}) {
  const compiled = await compileProject(bytes, {title});
  const runtime = generateRuntime(compiled, {exposeDebug: internal.exposeDebug === true});
  // Asset strings and generated literals must remain data inside the enclosing
  // script even when an author's project contains HTML closing tags.
  const safeRuntime = runtime.replace(/<\/script/gi, '<\\/script');
  new Script(safeRuntime, {filename: 'compiled-player.js'});
  const safeTitle = escapeHTML(title);
  const stageSize = compiled.manifest.stageSize || {width: 480, height: 360};
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src data: blob:; font-src data:; base-uri 'none'; object-src 'none'">
<title>${safeTitle}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#e8edf1;color:#243346;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.player{display:flex;flex-direction:column;max-height:calc(100dvh - 48px);width:min(100%,900px);background:#fff;border:1px solid #d6dee6;border-radius:16px;overflow:hidden;box-shadow:0 12px 50px #263a4c14}.toolbar{flex-shrink:0;min-height:64px;display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid #e8edf1}h1{font-size:15px;margin:0;flex:1;overflow-wrap:anywhere}button{border:1px solid #d6dee6;background:#fff;border-radius:8px;padding:9px 12px;color:#243346;cursor:pointer;font:inherit}button:focus-visible{outline:3px solid #356ea7;outline-offset:3px}button:disabled{opacity:.4;cursor:wait}#green-flag{background:#f0f8ed;border-color:#c2dcbc}#project{flex:1;min-height:0;width:100%;aspect-ratio:4/3;position:relative;overflow:hidden;background:#fff}#project>.scaffolding{width:100%;height:100%}.footer{flex-shrink:0;padding:12px 18px;font-size:12px;color:#687989;border-top:1px solid #e8edf1;display:flex;justify-content:space-between;gap:12px}.player:fullscreen{border:0;border-radius:0;background:#131c27;display:flex;flex-direction:column;width:100%}.player:fullscreen #project{flex:1;min-height:0}.player:fullscreen .footer{background:white}@media(max-width:550px){body{padding:10px}.toolbar{flex-wrap:wrap;padding:10px}h1{flex-basis:100%}.footer{flex-wrap:wrap}}</style>
</head><body><main class="player" id="player"><div class="toolbar"><h1>${safeTitle}</h1><button id="green-flag" disabled aria-label="点击绿旗开始">▶ 开始</button><button id="stop" disabled>■ 停止</button><button id="full-screen">⛶ 全屏</button></div><div id="project"></div><div class="footer"><span id="status" role="status">正在加载…</span><span>离线编译播放器</span></div></main>
<script>${safeRuntime}</script>
<script>document.getElementById('project').style.aspectRatio=${JSON.stringify(`${stageSize.width}/${stageSize.height}`)};document.getElementById('full-screen').addEventListener('click',async(event)=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.getElementById('player').requestFullscreen()}catch(e){document.getElementById('status').textContent='此浏览器不支持全屏'}finally{event.target.blur()}});if(window.parent!==window&&window.protectedPlayer){window.protectedPlayer.ready.then(()=>window.parent.postMessage({type:'scratch-player-ready'},'*'),error=>window.parent.postMessage({type:'scratch-player-error',message:error.message},'*'));}</script>
</body></html>`;
  const closingTag = html.lastIndexOf('</body>');
  const licensedHTML = html.slice(0, closingTag) + `<script type="text/plain" id="third-party-notices">${licenseNotices.replace(/<\/script/gi, '<\\/script')}</script>` + html.slice(closingTag);
  return {html: licensedHTML, report: {...compiled.report, protection: 'aot-no-block-graph', format: 1, offline: true}};
}

module.exports = {buildHTML};
