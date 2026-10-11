'use strict';

const util = require('node:util');
const {pathToFileURL} = require('node:url');
const {CommandSession} = require('./commands');
const {createSDK} = require('./sdk');
const {errorInfo, CommandError} = require('./errors');

// User scripts have ordinary local Node privileges. Keep their output away from
// the CLI's JSON stdout; IPC is used exclusively for the completion response.
for (const method of ['log', 'info', 'debug', 'warn', 'error']) console[method] = (...args) => {
  process.stderr.write(util.format(...args) + '\n');
};
process.stdout.write = process.stderr.write.bind(process.stderr);

const send = response => new Promise(resolve => {
  if (process.connected) process.send(response, () => resolve());
  else resolve();
});
process.once('message', async message => {
  const session = new CommandSession();
  try {
    if (!message || typeof message.bytes !== 'string' || typeof message.scriptPath !== 'string') {
      throw new CommandError('INVALID_ARGUMENT', 'Editing worker requires project bytes and scriptPath');
    }
    await session.project.load(Buffer.from(message.bytes, 'base64'));
    const namespace = await import(pathToFileURL(message.scriptPath).href);
    const edit = namespace.default;
    if (typeof edit !== 'function') throw new CommandError('INVALID_ARGUMENT', 'Editing script must export an async function as its default export or module.exports');
    const project = createSDK(session, {managed: true});
    const result = await project.batch(() => edit(project));
    await send({ok: true, bytes: (await session.project.bytes()).toString('base64'), result});
  } catch (error) {await send({ok: false, error: errorInfo(error)});}
  finally {session.dispose(); if (process.connected) process.disconnect(); process.exit();}
});
process.once('disconnect', () => process.exit());
