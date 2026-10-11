'use strict';

const {spawn} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launchBrowser() {
  const executable = process.env.PROTECTED_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'scratch-aot-browser-'));
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1200,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  let output = '';
  let spawnError;
  child.once('error', error => {spawnError = error;});
  child.stderr.on('data', chunk => {output += chunk.toString();});
  let socket;
  const close = async () => {
    socket?.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    for (let i = 0; i < 30 && child.exitCode === null; i++) await pause(50);
    if (child.exitCode === null) {child.kill('SIGKILL'); await pause(200);}
    await fs.rm(profile, {recursive: true, force: true});
  };
  try {
    let endpoint;
    for (let i = 0; i < 200; i++) {
      if (spawnError) throw spawnError;
      endpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
      if (endpoint) break;
      if (child.exitCode !== null) throw new Error('Chrome exited before test: ' + output.slice(-1000));
      await pause(50);
    }
    if (!endpoint) throw new Error('Chrome DevTools endpoint did not become ready');
    const host = new URL(endpoint).host;
    const target = await (await fetch(`http://${host}/json/new?about:blank`, {method: 'PUT'})).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once: true}); socket.addEventListener('error', reject, {once: true});});
    let sequence = 0;
    const pending = new Map();
    const events = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const {resolve, reject, timer} = pending.get(message.id);
        pending.delete(message.id); clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
      } else if (message.method) events.push(message);
    });
    socket.addEventListener('close', () => {for (const item of pending.values()) {clearTimeout(item.timer); item.reject(new Error('Browser closed'));} pending.clear();});
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Browser command timed out: ${method}`));}, 30000);
      pending.set(id, {resolve, reject, timer});
      socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, userGesture: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (expression, timeout = 15000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        if (await evaluate(expression)) return;
        await pause(100);
      }
      throw new Error(`Browser wait timed out: ${expression}; ${JSON.stringify(events.filter(event => event.method === 'Runtime.exceptionThrown').slice(-3))}`);
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    return {send, evaluate, waitFor, events, close, pid: child.pid};
  } catch (error) {await close(); throw error;}
}

module.exports = {launchBrowser};
