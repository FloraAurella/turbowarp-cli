const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {checkedPathSync} = require('./file-boundaries');

const MAX_STATE_BYTES = 2 * 1024 * 1024;
const pause = new Int32Array(new SharedArrayBuffer(4));
const validateName = name => {
  if (typeof name !== 'string' || !name || name.length > 256) throw new Error('Invalid cloud variable name');
};
const validateValue = value => {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Cloud values must be numbers or strings');
  if (typeof value === 'number' && !Number.isFinite(value) || String(value).length > 10000) throw new Error('Invalid cloud value');
};

class LocalCloud {
  constructor(filename, vm) {
    this.filename = checkedPathSync(filename, {missing: true});
    this.vm = vm;
    this.active = true;
    this.provider = {
      createVariable: (name, value) => this.updateVariable(name, value),
      updateVariable: (name, value) => this.updateVariable(name, value),
      renameVariable: (oldName, newName) => this.modify(values => {
        validateName(oldName); validateName(newName);
        if (oldName === newName) return;
        if (Object.hasOwn(values, oldName)) {values[newName] = values[oldName]; delete values[oldName];}
      }),
      deleteVariable: name => this.modify(values => {delete values[name];}),
      requestCloseConnection: () => {this.active = false;}
    };
    fs.mkdirSync(path.dirname(this.filename), {recursive: true});
    checkedPathSync(path.dirname(this.filename), {directory: true});
    this.modify(() => {});
    vm.runtime.ioDevices.cloud.setStage(vm.runtime.getTargetForStage());
    this.sync();
    // Install only after all validation succeeds; a failed replacement must not
    // detach the previously working provider.
    vm.runtime.ioDevices.cloud.setProvider(this.provider);
  }
  read() {
    let parsed, fd;
    try {
      checkedPathSync(this.filename);
      const stat = fs.lstatSync(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) throw new Error('Unsafe or oversized cloud state file');
      fd = fs.openSync(this.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const actual = fs.fstatSync(fd);
      if (!actual.isFile() || actual.size > MAX_STATE_BYTES) throw new Error('Unsafe or oversized cloud state file');
      // Bound the read even if another process grows the file after fstat.
      const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
      let size = 0, count;
      while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += count;
      if (size > MAX_STATE_BYTES) throw new Error('Oversized cloud state file exceeds the 2 MiB limit');
      parsed = JSON.parse(buffer.toString('utf8', 0, size));
    } catch (error) {if (error.code === 'ENOENT') return Object.create(null); throw error;}
    finally {if (fd !== undefined) fs.closeSync(fd);}
    if (!parsed || parsed.version !== 1 || !parsed.values || Array.isArray(parsed.values) || typeof parsed.values !== 'object') throw new Error('Invalid local cloud state');
    const values = Object.create(null);
    for (const [name, value] of Object.entries(parsed.values)) {validateName(name); validateValue(value); values[name] = value;}
    return values;
  }
  modify(operation) {
    checkedPathSync(this.filename, {missing: true});
    const lock = `${this.filename}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {fs.mkdirSync(lock); break;}
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error(`Local cloud lock timed out: ${lock}; check the owning process before removing it`);
        Atomics.wait(pause, 0, 0, 10);
      }
    }
    let temporary;
    try {
      const values = this.read();
      operation(values);
      for (const [name, value] of Object.entries(values)) {validateName(name); validateValue(value);}
      const bytes = Buffer.from(JSON.stringify({version: 1, values}, null, 2));
      if (bytes.length > MAX_STATE_BYTES) throw new Error('Cloud state exceeds the 2 MiB output limit');
      temporary = `${this.filename}.${crypto.randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
      checkedPathSync(this.filename, {missing: true});
      fs.renameSync(temporary, this.filename); temporary = null;
      return {...values};
    } finally {
      if (temporary) fs.unlinkSync(temporary);
      fs.rmdirSync(lock);
    }
  }
  updateVariable(name, value) {
    validateName(name); validateValue(value);
    return this.modify(values => {values[name] = value;});
  }
  sync() {
    if (!this.active) return;
    const values = this.read();
    const cloud = this.vm.runtime.ioDevices.cloud;
    for (const variable of Object.values(this.vm.runtime.getTargetForStage().variables)) {
      if (variable.isCloud && Object.hasOwn(values, variable.name)) cloud.postData({varUpdate: {name: variable.name, value: values[variable.name]}});
    }
    return {...values};
  }
  close() {
    this.active = false;
    const cloud = this.vm.runtime.ioDevices.cloud;
    if (cloud.provider === this.provider) cloud.setProvider(null);
  }
}

module.exports = {LocalCloud, validateName, validateValue, MAX_STATE_BYTES};
