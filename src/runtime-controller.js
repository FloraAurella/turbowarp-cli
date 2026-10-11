const path = require('node:path');
const {fork} = require('node:child_process');
const {CommandError} = require('./errors');
const {MAX_PROJECT_BYTES} = require('./project-limits');

const PROTOCOL = 'tw-runtime-v1';
const ACTIONS = new Set(['pause', 'resume', 'stop', 'step', 'status', 'input', 'answer', 'watch', 'trace', 'breakpoint', 'clones']);
const finiteInteger = (value, name, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
};

// This controller owns exactly one process. It never receives an editor VM and
// never evaluates code or accepts worker/executable paths from command input.
class RuntimeController {
  constructor({requestTimeoutMS = 5000, startupTimeoutMS = 30000} = {}) {
    this.requestTimeoutMS = finiteInteger(requestTimeoutMS, 'IPC timeout', 50, 30000);
    this.startupTimeoutMS = finiteInteger(startupTimeoutMS, 'startup timeout', 50, 30000);
    this.child = null;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.closing = false;
    this.stderr = '';
    this.lastStatus = {state: 'not-started'};
    this.tail = Promise.resolve();
    this.closePromise = Promise.resolve();
  }
  async start(bytes, options = {}) {
    if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Persistent runtime requires Node.js 24');
    if (this.child || this.closed) throw new Error('RuntimeController cannot be restarted; create a new controller');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_PROJECT_BYTES) throw new Error(`Runtime project must be a nonempty SB3 buffer, max ${MAX_PROJECT_BYTES / 1024 / 1024} MiB`);
    const env = {...process.env};
    // Do not inherit preload scripts, alternate module resolution or inspector
    // flags into the isolated copy. Project extensions still fail closed there.
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    this.child = fork(path.join(__dirname, 'runtime-worker.js'), [], {
      execPath: process.execPath, execArgv: [], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json'
    });
    const child = this.child;
    this.closePromise = new Promise(resolve => {
      child.once('close', (code, signal) => {
        this.closed = true; clearInterval(this.heartbeat);
        this.rejectPending(new Error(`Runtime worker closed (${code ?? signal}): ${this.stderr}`));
        if (!['stopped', 'expired', 'error', 'disposed'].includes(this.lastStatus.state)) {
          this.lastStatus = {...this.lastStatus, state: this.closing ? 'stopped' : 'error', exitCode: code, signal};
        }
        child.removeAllListeners('message');
        child.stderr?.removeAllListeners('data');
        resolve({code, signal});
      });
    });
    child.stderr.on('data', data => {this.stderr = (this.stderr + data).slice(-4000);});
    child.on('message', message => this.receive(message));
    child.on('error', error => this.terminate(error));
    try {
      const result = await this.send('init', {...options, project: bytes.toString('base64')}, this.startupTimeoutMS);
      this.lastStatus = result;
      this.heartbeat = setInterval(() => {
        if (!this.closing && !this.closed && this.pending.size === 0 && !this.queued) this.request('status').catch(() => {});
      }, Math.min(1000, this.requestTimeoutMS));
      return result;
    } catch (error) {
      this.terminate(error);
      await this.closePromise;
      throw error;
    }
  }
  receive(message) {
    if (!message || message.protocol !== PROTOCOL) {
      this.terminate(new Error('Invalid runtime IPC protocol')); return;
    }
    if (message.event) {
      if (message.status) this.lastStatus = message.status;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return; // A timed-out request cannot resurrect a closed run.
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.ok === true) {
      if (message.result?.state) this.lastStatus = message.result;
      pending.resolve(message.result);
    } else {
      const info = message.errorInfo;
      pending.reject(info ? new CommandError(info.code, message.error || info.message, info.hint, info.details) :
        new Error(message.error || 'Runtime request failed'));
    }
  }
  send(action, data = {}, timeout = this.requestTimeoutMS) {
    if (!this.child || this.closed || !this.child.connected) return Promise.reject(new Error('Runtime worker is not connected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.terminate(new Error(`Runtime IPC ${action} timed out after ${timeout} ms`)), timeout);
      this.pending.set(id, {resolve, reject, timer});
      this.child.send({protocol: PROTOCOL, id, action, data}, error => {if (error) this.terminate(error);});
    });
  }
  request(action, data = {}) {
    if (!ACTIONS.has(action)) return Promise.reject(new Error(`Unknown runtime action ${action}`));
    if (!data || Array.isArray(data) || typeof data !== 'object') return Promise.reject(new Error('Runtime request data must be an object'));
    if (this.closing || this.closed) return Promise.reject(new Error('Runtime worker is stopped or disposed'));
    // One outstanding IPC command; queue is bounded as well as the worker logs.
    if ((this.queued || 0) >= 64) return Promise.reject(new Error('Runtime command queue exceeds 64 requests'));
    this.queued = (this.queued || 0) + 1;
    const operation = this.tail.then(() => {
      if (this.closing || this.closed) throw new Error('Runtime worker is stopped or disposed');
      return this.send(action, data);
    });
    this.tail = operation.catch(() => {});
    return operation.finally(() => {this.queued--;});
  }
  async stop() {
    if (!this.child) return {state: 'stopped'};
    if (this.closed) return this.lastStatus;
    this.closing = true; clearInterval(this.heartbeat);
    try {
      await this.tail;
      const status = await this.send('stop');
      this.lastStatus = status;
      // The worker sends stop only after disposing VM/replay. Its exit must also
      // be observed before another runtime can be started in this session.
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
      try {await this.closePromise;} finally {clearTimeout(timer);}
      return status;
    } catch (error) {
      this.terminate(error); await this.closePromise; throw error;
    }
  }
  rejectPending(error) {
    for (const {reject, timer} of this.pending.values()) {clearTimeout(timer); reject(error);}
    this.pending.clear();
  }
  terminate(error) {
    this.closing = true; clearInterval(this.heartbeat);
    this.lastStatus = {...this.lastStatus, state: 'error', error: error.message};
    this.rejectPending(error);
    if (this.child && !this.closed) this.child.kill('SIGKILL');
  }
  dispose() {
    if (this.closed) return;
    this.closing = true; clearInterval(this.heartbeat);
    this.lastStatus = {...this.lastStatus, state: 'disposed'};
    this.rejectPending(new Error('Runtime controller disposed'));
    if (this.child) this.child.kill('SIGKILL');
    else this.closed = true;
  }
}

module.exports = {RuntimeController, PROTOCOL};
