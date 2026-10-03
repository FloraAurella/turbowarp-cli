const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('@turbowarp/jszip');
const {spawnSync} = require('node:child_process');
const {CommandSession} = require('../src/commands');
const {RuntimeController} = require('../src/runtime-controller');
const runtimeCommands = require('../src/runtime-commands');
const {blankProject} = require('../src/project');

const call = (session, action, ...args) => session.execute(['runtime', action, ...args]);
const withSession = async operation => {
  const session = new CommandSession(), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tw-runtime-'));
  try {await session.execute(['new']); await operation(session, dir);}
  finally {runtimeCommands.dispose(session); await session.runtimeController?.closePromise; session.dispose(); await fs.rm(dir, {recursive: true, force: true});}
};
const score = result => result.targets.find(target => target.name === 'Sprite1').variables.find(variable => variable.name === 'score').value;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const poll = async (operation, predicate, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  for (;;) {const value = await operation(); if (predicate(value)) return value; assert.ok(Date.now() < deadline, JSON.stringify(value)); await sleep(10);}
};
const add = (session, opcode, options = []) => session.execute(['block', 'add', opcode, ...options]);
const linear = async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const hat = await add(session, 'event_whenflagclicked');
  const first = await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":1}', '--after', hat.id]);
  const second = await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":10}', '--after', first.id]);
  return {hat: hat.id, first: first.id, second: second.id};
};
const forever = async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const hat = await add(session, 'event_whenflagclicked');
  const loop = await add(session, 'control_forever', ['--after', hat.id]);
  const change = await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":1}', '--parent', loop.id, '--input', 'SUBSTACK']);
  return {hat: hat.id, loop: loop.id, change: change.id};
};

test('runtime contract routes through real CommandSession and block steps mutate only fork copy', async () => withSession(async (session, dir) => {
  const script = await linear(session), file = path.join(dir, 'editor.sb3'); await session.execute(['save', file]);
  const original = await fs.readFile(file), history = await session.execute(['history']);
  assert.equal(runtimeCommands.mutates, false); assert.equal(runtimeCommands.requiresProject('runtime', ['start']), true);
  const started = await call(session, 'start', '--paused', '--seed', '0');
  assert.equal(started.state, 'paused'); assert.equal(started.threads[0].blockId, script.first);
  assert.ok(session.runtimeController.child.pid !== process.pid); assert.equal(started.noDOM, true);
  await call(session, 'trace', 'on', '--limit', '10'); await call(session, 'watch', 'add', 'score');
  const first = await call(session, 'step'); assert.equal(first.steppedBlocks, 1); assert.equal(score(first), 1);
  assert.equal(first.threads[0].blockId, script.second);
  const second = await call(session, 'step'); assert.equal(score(second), 11); assert.equal(second.threads.length, 0);
  const trace = await call(session, 'trace'); assert.deepEqual(trace.entries.map(entry => entry.blockId), [script.first, script.second]);
  const watch = await call(session, 'watch', 'samples'); assert.deepEqual(watch.watches[0].entries.map(entry => entry.value), [0, 1, 11]);
  assert.equal(score(await session.execute(['info'])), 0); assert.equal(session.dirty, false);
  await session.execute(['sprite', 'set', 'x', '50']);
  assert.equal((await call(session, 'status')).targets[1].x, 0);
  await session.execute(['undo']); await session.execute(['save']);
  assert.deepEqual(await session.execute(['history']), {undo: history.undo, redo: ['sprite set x 50']});
  const originalZip = await JSZip.loadAsync(original), savedZip = await JSZip.loadAsync(await fs.readFile(file));
  assert.deepEqual(JSON.parse(await savedZip.file('project.json').async('string')), JSON.parse(await originalZip.file('project.json').async('string')));
  const stopped = await call(session, 'stop'); assert.equal(stopped.state, 'stopped'); assert.ok(session.runtimeController.closed);
  assert.equal((await call(session, 'status')).state, 'stopped');
  await call(session, 'start', '--paused'); assert.equal(score(await call(session, 'status')), 0);
}));

test('block-ID breakpoints pause before execution, record hits and bypass once on stepping/resume', async () => withSession(async session => {
  const script = await linear(session);
  await call(session, 'start', '--paused', '--seed', '4');
  await call(session, 'breakpoint', 'add', script.second);
  await assert.rejects(call(session, 'breakpoint', 'add', 'missing'), /not found/);
  const status = await call(session, 'step', '--frames', '1');
  assert.equal(status.state, 'paused'); assert.equal(score(status), 1); assert.equal(status.breakpoint.blockId, script.second);
  const hits = await call(session, 'breakpoint', 'hits'); assert.equal(hits.entries.length, 1); assert.equal(hits.entries[0].blockId, script.second);
  const stepped = await call(session, 'step'); assert.equal(score(stepped), 11); assert.equal(stepped.steppedBlocks, 1);
  await call(session, 'breakpoint', 'clear'); assert.deepEqual((await call(session, 'breakpoint')).breakpoints, []);
  await call(session, 'resume'); await call(session, 'pause'); assert.equal(score(await call(session, 'status')), 11);
}));

test('pause freezes virtual frames and waits, resume progresses without editing shared VM', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const hat = await add(session, 'event_whenflagclicked');
  const wait = await add(session, 'control_wait', ['--inputs', '{"DURATION":0.1}', '--after', hat.id]);
  await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":7}', '--after', wait.id]);
  await call(session, 'start', '--paused', '--fps', '30', '--seed', '1');
  await call(session, 'step', '--frames', '1');
  const paused = await call(session, 'status'); await sleep(150);
  assert.deepEqual(await call(session, 'status'), paused);
  assert.equal(score(await call(session, 'step', '--frames', '2')), 0);
  assert.equal(score(await call(session, 'step', '--frames', '2')), 7);
  assert.equal(score(await session.execute(['info'])), 0);
}));

test('scheduled keyboard/mouse input occurs at exact frames, request errors leave runtime usable', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const keyHat = await add(session, 'event_whenkeypressed', ['--fields', '{"KEY_OPTION":"space"}']);
  await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":5}', '--after', keyHat.id]);
  const mouseHat = await add(session, 'event_whenthisspriteclicked');
  await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":9}', '--after', mouseHat.id]);
  await call(session, 'start', '--paused', '--seed', '1');
  await call(session, 'input', 'key', 'space', 'down', '--frame', '2');
  await call(session, 'input', 'mouse', '0', '0', 'down', '--frame', '3', '--button', '0');
  assert.equal(score(await call(session, 'step', '--frames', '2')), 0);
  assert.equal(score(await call(session, 'step', '--frames', '1')), 5);
  assert.equal(score(await call(session, 'step', '--frames', '1')), 14);
  await assert.rejects(call(session, 'input', 'key', 'space', 'down', '--frame', '0'), /past/);
  await assert.rejects(call(session, 'input', '{"device":"camera","data":{"url":"https://example.invalid"}}'), /denied/);
  await assert.rejects(session.runtimeController.request('input', {event: {device: 'fetch', data: {url: 'https://example.invalid'}}}), /denied/);
  assert.equal(score(await call(session, 'status')), 14);
}));

test('ask blocks remain pending until immediate or frame-scheduled answer and trace shows reporter boundaries', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const hat = await add(session, 'event_whenflagclicked');
  const ask = await add(session, 'sensing_askandwait', ['--inputs', '{"QUESTION":"Your name?"}', '--after', hat.id]);
  const set = await add(session, 'data_setvariableto', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":""}', '--after', ask.id]);
  const answer = await add(session, 'sensing_answer'); await session.execute(['block', 'input', set.id, 'VALUE', answer.id]);
  await call(session, 'start', '--paused', '--trace', '20');
  await call(session, 'step', '--frames', '1');
  const pending = await call(session, 'status'); assert.equal(pending.pendingQuestion.text, 'Your name?'); assert.equal(score(pending), 0);
  await assert.rejects(call(session, 'answer', 'bad', '--question', String(pending.pendingQuestion.id + 1)), /Question ID/);
  await call(session, 'answer', 'Alice', '--question', String(pending.pendingQuestion.id));
  assert.equal(score(await call(session, 'step', '--frames', '1')), 'Alice');
  const trace = await call(session, 'trace'); assert.ok(trace.entries.some(entry => entry.blockId === ask.id));
  assert.ok(trace.entries.some(entry => entry.blockId === answer.id)); assert.ok(trace.entries.some(entry => entry.blockId === set.id));
  await call(session, 'stop'); await call(session, 'start', '--paused');
  await call(session, 'answer', 'Bob', '--frame', '2');
  assert.equal(score(await call(session, 'step', '--frames', '2')), 0);
  assert.equal(score(await call(session, 'step', '--frames', '2')), 'Bob');
}));

test('compiled runtime supports pause/frame step but explicitly rejects block stepping, breakpoints and primitive trace', async () => withSession(async session => {
  const script = await linear(session); session.runtimeSettings = {compiler: true, warpTimer: true, volume: 50};
  const start = await call(session, 'start', '--paused'); assert.equal(start.compiled, true);
  await assert.rejects(call(session, 'step'), /Compiled single-step/);
  await assert.rejects(call(session, 'breakpoint', 'add', script.second), /interpreter/);
  await assert.rejects(call(session, 'trace', 'on'), /interpreter/);
  assert.equal(score(await call(session, 'step', '--frames', '1')), 11);
  await call(session, 'resume'); await call(session, 'pause'); await call(session, 'stop');
  const interpreted = await call(session, 'start', '--paused', '--no-compile'); assert.equal(interpreted.compiled, false);
  assert.equal(score(await call(session, 'step')), 1);
}));

test('trace/watch bounded rings retain immutable samples, clones are reported and stop removes them', async () => withSession(async session => {
  await session.execute(['list', 'add', 'items', '[]']);
  const hat = await add(session, 'event_whenflagclicked');
  const loop = await add(session, 'control_forever', ['--after', hat.id]);
  await add(session, 'data_addtolist', ['--fields', '{"LIST":"items"}', '--inputs', '{"ITEM":"coin"}', '--parent', loop.id, '--input', 'SUBSTACK']);
  const cloneHat = await add(session, 'event_whenkeypressed', ['--fields', '{"KEY_OPTION":"c"}']);
  const create = await add(session, 'control_create_clone_of', ['--inputs', '{"CLONE_OPTION":"_myself_"}', '--after', cloneHat.id]);
  await call(session, 'start', '--paused', '--seed', '0', '--trace', '3', '--watch', 'items');
  await call(session, 'step', '--frames', '5');
  const trace = await call(session, 'trace'); assert.equal(trace.entries.length, 3); assert.ok(trace.dropped > 0);
  const watch = await call(session, 'watch'); assert.deepEqual(watch.watches[0].entries[0].value, []);
  assert.deepEqual(watch.watches[0].entries[1].value, ['coin']); assert.equal(watch.watches[0].entries.at(-1).value.length, 5);
  await call(session, 'input', 'key', 'c', 'down'); await call(session, 'step', '--frames', '1');
  const clones = await call(session, 'clones'); assert.equal(clones.clones.length, 1); assert.equal(clones.limit, 300);
  assert.equal(clones.clones[0].originalId, (await call(session, 'status')).targets[1].id);
  assert.equal((await call(session, 'stop')).cloneCount, 0);
  assert.equal((await session.execute(['info'])).targets.length, 2);
}));

test('runtime startup fails closed on denied extensions and IPC death/timeout disposes a real worker', async () => {
  const zip = await JSZip.loadAsync(await blankProject()), json = JSON.parse(await zip.file('project.json').async('string'));
  json.extensionURLs = {evil: 'https://example.invalid/x.js'}; zip.file('project.json', JSON.stringify(json));
  const denied = new RuntimeController();
  await assert.rejects(denied.start(await zip.generateAsync({type: 'nodebuffer'})), /denied/); assert.equal(denied.closed, true);
  const timeout = new RuntimeController({requestTimeoutMS: 100});
  try {
    await timeout.start(await blankProject(), {paused: true}); timeout.child.kill('SIGSTOP');
    await assert.rejects(timeout.request('status'), /timed out/); await timeout.closePromise;
    assert.equal(timeout.closed, true); assert.equal(timeout.child.signalCode, 'SIGKILL'); assert.equal(timeout.pending.size, 0);
  } finally {timeout.dispose();}
  const death = new RuntimeController();
  try {await death.start(await blankProject(), {paused: true}); death.child.kill('SIGKILL'); await death.closePromise;
    await assert.rejects(death.request('status'), /stopped|disposed/); assert.equal(death.pending.size, 0);
  } finally {death.dispose();}
});

test('controller sync dispose kills fork, lifetime expires even when paused and limits reject unsafe commands', async () => withSession(async session => {
  await forever(session); await call(session, 'start', '--paused', '--seed', '0', '--max-frames', '2');
  await assert.rejects(call(session, 'start'), /already/);
  await assert.rejects(call(session, 'step', '--frames', '10001'), /integer/);
  await call(session, 'step', '--frames', '2'); await assert.rejects(call(session, 'resume'), /frame limit/);
  await call(session, 'stop'); await call(session, 'start', '--paused');
  const controller = session.runtimeController; runtimeCommands.dispose(session); await controller.closePromise;
  assert.equal(controller.closed, true); assert.equal(controller.child.signalCode, 'SIGKILL');
  const expiring = new RuntimeController();
  try {await expiring.start(await blankProject(), {paused: true, lifetimeMS: 100}); await expiring.closePromise; assert.equal(expiring.lastStatus.state, 'expired');}
  finally {expiring.dispose();}
}));

test('reporter block breakpoints and single steps preserve cached operands without re-running random reporters', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const hat = await add(session, 'event_whenflagclicked');
  const set = await add(session, 'data_setvariableto', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":1}', '--after', hat.id]);
  const random = await add(session, 'operator_random', ['--inputs', '{"FROM":1,"TO":1000000}']);
  await session.execute(['block', 'input', set.id, 'VALUE', random.id]);
  await call(session, 'start', '--paused', '--seed', '1234', '--trace', '20');
  await call(session, 'breakpoint', 'add', set.id); await call(session, 'breakpoint', 'add', random.id);
  const hit = await call(session, 'step'); assert.equal(hit.steppedBlocks, 0); assert.equal(hit.breakpoint.blockId, random.id);
  const reporter = await call(session, 'step'); assert.equal(reporter.steppedBlocks, 1); assert.equal(score(reporter), 0);
  assert.equal(reporter.breakpoint.blockId, set.id);
  assert.equal(score(await call(session, 'step')), 73295);
  assert.deepEqual((await call(session, 'trace')).entries.map(entry => entry.blockId), [random.id, set.id]);
}));

test('block stepping through waits and loops advances virtual frames instead of getting stuck on a yielded block', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const hat = await add(session, 'event_whenflagclicked');
  const loop = await add(session, 'control_forever', ['--after', hat.id]);
  const wait = await add(session, 'control_wait', ['--inputs', '{"DURATION":0.1}', '--parent', loop.id, '--input', 'SUBSTACK']);
  await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":1}', '--after', wait.id]);
  await call(session, 'start', '--paused', '--seed', '0');
  const stepped = await call(session, 'step', '20');
  assert.ok(score(stepped) >= 2, JSON.stringify(stepped)); assert.ok(stepped.frame >= 6);
  assert.equal(stepped.state, 'paused');
}));

test('continuous resume reaches a real breakpoint, pause is stable and repeated loop hits are recorded', async () => withSession(async session => {
  const script = await forever(session); await call(session, 'start', '--paused', '--seed', '0');
  await call(session, 'breakpoint', 'add', script.change); await call(session, 'resume');
  const hit = await poll(() => call(session, 'status'), status => status.breakpoint !== null);
  assert.equal(score(hit), 0); assert.equal(hit.state, 'paused');
  await call(session, 'resume');
  await poll(() => call(session, 'breakpoint', 'hits'), result => result.entries.length >= 2);
  assert.equal(score(await call(session, 'status')), 1);
  await call(session, 'breakpoint', 'clear'); await call(session, 'resume');
  await poll(() => call(session, 'status'), result => score(result) >= 2);
  const paused = await call(session, 'pause'); await sleep(80); assert.deepEqual(await call(session, 'status'), paused);
}));

test('persistent seeded random runs reproduce exact samples and bounded watch rings retire old frames', async () => withSession(async session => {
  const script = await forever(session), random = await add(session, 'operator_random', ['--inputs', '{"FROM":1,"TO":1000000}']);
  await session.execute(['block', 'input', script.change, 'VALUE', random.id]);
  const execute = async seed => {
    await call(session, 'start', '--paused', '--seed', String(seed), '--watch', 'score');
    await call(session, 'step', '--frames', '6'); const samples = (await call(session, 'watch')).watches[0].entries;
    await call(session, 'stop'); return samples;
  };
  const first = await execute(1234), second = await execute(1234);
  assert.deepEqual(first, second); assert.deepEqual(first.slice(1).map(entry => entry.value), [73295, 776707, 1679564, 2650114, 2691078, 2808842]);
  assert.notDeepEqual(await execute(1235), first);
  await call(session, 'start', '--paused', '--seed', '0', '--watch', 'score');
  await call(session, 'step', '--frames', '300');
  const watch = (await call(session, 'watch')).watches[0]; assert.equal(watch.entries.length, 256); assert.ok(watch.dropped > 0);
  assert.equal(score(await session.execute(['info'])), 0);
}));

test('JSONL runtime errors are request-scoped, batch protocols stay separate and quit disposes persistent worker', async () => withSession(async (session, dir) => {
  await linear(session); const file = path.join(dir, 'session.sb3'); await session.execute(['save', file]);
  const requests = [{id: 1, command: 'open', args: [file]}, {id: 2, command: 'runtime', args: ['start', '--paused']},
    {id: 3, command: 'runtime', args: ['input', '{"device":"tcp","data":{}}']}, {id: 4, command: 'runtime', args: ['step']},
    {id: 5, command: 'runtime', args: ['status']}, {id: 6, command: 'info', args: []}, {id: 7, command: 'quit', args: []}];
  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/tw.js'), 'session', '--jsonl'],
    {input: requests.map(request => JSON.stringify(request)).join('\n') + '\n', encoding: 'utf8', timeout: 15000});
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line)); assert.equal(replies.length, requests.length);
  assert.equal(replies[2].ok, false); assert.match(replies[2].error, /denied/);
  assert.equal(score(replies[4].result), 1); assert.equal(score(replies[5].result), 0); assert.equal(replies[6].result.closed, true);
}));

test('custom procedure calls, branches and repeated waits retain interpreter stack across single steps', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const procedure = await session.execute(['proc', 'define', 'increment']);
  await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":3}', '--after', procedure.id]);
  const hat = await add(session, 'event_whenflagclicked');
  const callBlock = await session.execute(['proc', 'call', 'increment', '--after', hat.id]);
  const repeat = await add(session, 'control_repeat', ['--inputs', '{"TIMES":3}', '--after', callBlock.id]);
  await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":1}', '--parent', repeat.id, '--input', 'SUBSTACK']);
  await call(session, 'start', '--paused', '--seed', '0', '--trace', '30');
  const result = await call(session, 'step', '20'); assert.equal(score(result), 6); assert.equal(result.threads.length, 0);
  assert.ok((await call(session, 'trace')).entries.some(entry => entry.opcode === 'procedures_call'));
}));

test('clone execution hits original block breakpoint with clone identity and stop frees all clones', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const hat = await add(session, 'event_whenflagclicked');
  await add(session, 'control_create_clone_of', ['--inputs', '{"CLONE_OPTION":"_myself_"}', '--after', hat.id]);
  const cloneHat = await add(session, 'control_start_as_clone');
  const change = await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":9}', '--after', cloneHat.id]);
  await call(session, 'start', '--paused', '--seed', '0');
  await call(session, 'breakpoint', 'add', change.id);
  const status = await call(session, 'step', '--frames', '1');
  assert.equal(status.cloneCount, 1); assert.equal(status.breakpoint.blockId, change.id);
  assert.notEqual(status.breakpoint.targetId, status.targets[1].id); assert.equal(status.breakpoint.originalTargetId, status.targets[1].id);
  const clone = (await call(session, 'clones')).clones[0]; assert.equal(clone.variables[0].value, 0);
  await call(session, 'step'); assert.equal((await call(session, 'clones')).clones[0].variables[0].value, 9);
  assert.ok((await call(session, 'trace', 'events')).entries.some(entry => entry.type === 'clone-created'));
  assert.equal((await call(session, 'stop')).cloneCount, 0);
}));

test('automatic heartbeat kills an unresponsive worker without waiting for the next user command', async () => {
  const controller = new RuntimeController({requestTimeoutMS: 100});
  try {
    await controller.start(await blankProject(), {paused: true}); controller.child.kill('SIGSTOP');
    const closed = await Promise.race([controller.closePromise, sleep(2000).then(() => {throw new Error('Heartbeat failed to dispose stopped worker');})]);
    assert.equal(closed.signal, 'SIGKILL'); assert.equal(controller.pending.size, 0); assert.match(controller.lastStatus.error, /timed out/);
  } finally {controller.dispose();}
});

test('runtime fork drops inherited preload flags and queued dispose rejects pending operations', async () => {
  const controller = new RuntimeController(); const prior = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require /does-not-exist-runtime-preload.js';
  try {
    await controller.start(await blankProject(), {paused: true});
    assert.deepEqual(controller.child.spawnargs.slice(1), [path.join(__dirname, '../src/runtime-worker.js')]);
    controller.child.kill('SIGSTOP');
    const pending = controller.request('status'); const rejected = assert.rejects(pending, /disposed|stopped/);
    controller.dispose(); await rejected; await controller.closePromise; assert.equal(controller.pending.size, 0);
  } finally {controller.dispose(); if (prior === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prior;}
});

test('worker rejects over-capacity answer and watch requests without abandoning paused runtime', async () => withSession(async session => {
  await linear(session); await call(session, 'start', '--paused');
  const controller = session.runtimeController;
  await assert.rejects(controller.request('answer', {text: 'x'.repeat(10001), frame: 0}), /10000/);
  for (let i = 0; i < 209; i++) await controller.request('answer', {text: '😀'.repeat(5000), frame: 99});
  await assert.rejects(controller.request('answer', {text: '😀'.repeat(5000), frame: 99}), /4 MiB/);
  assert.equal((await call(session, 'status')).state, 'paused');
  await assert.rejects(controller.request('watch', {action: 'add', selector: 'missing'}), /not found/);
  await assert.rejects(controller.request('trace', {action: 'on', limit: 10001}), /capacity/);
  assert.equal((await call(session, 'trace')).enabled, false);
  assert.equal(score(await call(session, 'step')), 1);
}));

test('trace resizing preserves monotonic cursors and validation does not mutate existing debug state', async () => withSession(async session => {
  await forever(session); await call(session, 'start', '--paused', '--seed', '0', '--trace', '3');
  await call(session, 'step', '--frames', '3'); const before = await call(session, 'trace');
  await call(session, 'trace', 'off'); await call(session, 'trace', 'on', '--limit', '2');
  const resized = await call(session, 'trace'); assert.equal(resized.entries.length, 2); assert.equal(resized.sequence, before.sequence);
  await call(session, 'step', '--frames', '1'); const later = await call(session, 'trace', 'get', '--since', String(before.sequence));
  assert.ok(later.entries.length > 0); assert.ok(later.entries.every(entry => entry.sequence > before.sequence));
  await call(session, 'trace', 'clear'); assert.equal((await call(session, 'trace')).entries.length, 0);
  assert.equal((await call(session, 'trace')).sequence, later.sequence);
}));

test('compiled virtual wait survives wall-clock pause', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const hat = await add(session, 'event_whenflagclicked');
  const wait = await add(session, 'control_wait', ['--inputs', '{"DURATION":0.1}', '--after', hat.id]);
  await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":7}', '--after', wait.id]);
  await call(session, 'start', '--paused', '--compile', '--seed', '0'); await call(session, 'step', '--frames', '1');
  await sleep(150); assert.equal(score(await call(session, 'status')), 0);
  assert.equal(score(await call(session, 'step', '--frames', '1')), 0);
  assert.equal(score(await call(session, 'step', '--frames', '4')), 7);
}));

test('batch run --trace records exact interpreter primitive locations and preserves untraced seed/watch results', async () => withSession(async session => {
  const script = await forever(session), random = await add(session, 'operator_random', ['--inputs', '{"FROM":1,"TO":1000000}']);
  await session.execute(['block', 'input', script.change, 'VALUE', random.id]);
  const editor = await session.execute(['info']);
  const untraced = await session.execute(['run', '--frames', '6', '--seed', '1234', '--watch', 'score']);
  assert.equal(Object.hasOwn(untraced, 'trace'), false);
  const traced = await session.execute(['run', '--frames', '6', '--seed', '1234', '--watch', 'score', '--trace', '100']);
  const {trace, ...legacy} = traced; assert.deepEqual(legacy, untraced);
  assert.equal(trace.mode, 'interpreter-primitives'); assert.equal(trace.capacity, 100); assert.equal(trace.dropped, 0);
  const targetId = editor.targets[1].id;
  assert.equal(trace.entries.length, 18); assert.equal(trace.sequence, 18);
  for (let frame = 0; frame < 6; frame++) {
    const entries = trace.entries.filter(entry => entry.frame === frame);
    assert.deepEqual(entries.map(entry => entry.blockId), [script.loop, random.id, script.change]);
    assert.deepEqual(entries.map(entry => entry.opcode), ['control_forever', 'operator_random', 'data_changevariableby']);
    assert.ok(entries.every(entry => entry.targetId === targetId && entry.originalTargetId === targetId &&
      entry.threadId === `${targetId}&${script.hat}` && entry.timeMS === frame * 1000 / 30));
  }
  assert.deepEqual(trace.entries.map(entry => entry.sequence), Array.from({length: 18}, (_, index) => index + 1));
  const again = await session.execute(['run', '--frames', '6', '--seed', '1234', '--watch', 'score', '--trace', '100']);
  assert.deepEqual(again, traced); assert.deepEqual(await session.execute(['info']), editor);
  const bounded = await session.execute(['run', '--frames', '6', '--seed', '1234', '--trace', '2']);
  assert.equal(bounded.trace.entries.length, 2); assert.equal(bounded.trace.dropped, 16);
  assert.deepEqual(bounded.trace.entries.map(entry => entry.blockId), [random.id, script.change]);
}));

test('batch trace validates capacities and refuses explicit or inherited compiled mode without damaging session', async () => withSession(async session => {
  await linear(session);
  for (const value of ['0', '10001', '-1', '1.5', 'NaN']) await assert.rejects(session.execute(['run', '--frames', '1', '--trace', value]), /integer|capacity|trace/i);
  await assert.rejects(session.execute(['run', '--frames', '1', '--compile', '--trace', '10']), /interpreter/);
  session.runtimeSettings.compiler = true;
  await assert.rejects(session.execute(['run', '--frames', '1', '--trace', '10']), /interpreter/);
  assert.equal(score(await session.execute(['info'])), 0);
  assert.equal(score(await session.execute(['run', '--frames', '1'])), 11);
  session.runtimeSettings.compiler = false;
  const trace = (await session.execute(['run', '--frames', '1', '--trace', '1'])).trace;
  assert.equal(trace.entries.length, 1); assert.equal(trace.capacity, 1); assert.equal(trace.dropped, 1);
}));

test('batch trace identifies scheduled key hat threads and clone primitive targets accurately', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const keyHat = await add(session, 'event_whenkeypressed', ['--fields', '{"KEY_OPTION":"c"}']);
  const create = await add(session, 'control_create_clone_of', ['--inputs', '{"CLONE_OPTION":"_myself_"}', '--after', keyHat.id]);
  const cloneHat = await add(session, 'control_start_as_clone');
  const change = await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":9}', '--after', cloneHat.id]);
  session.inputs = [{frame: 2, device: 'keyboard', data: {key: 'c', isDown: true}}];
  const result = await session.execute(['run', '--frames', '4', '--seed', '0', '--trace', '100']);
  const original = result.targets[1].id, entries = result.trace.entries;
  const creation = entries.find(entry => entry.blockId === create.id), clone = entries.find(entry => entry.blockId === change.id);
  assert.equal(creation.frame, 2); assert.equal(creation.targetId, original); assert.equal(creation.threadId, `${original}&${keyHat.id}`);
  assert.equal(clone.frame, 2); assert.notEqual(clone.targetId, original); assert.equal(clone.originalTargetId, original);
  assert.equal(clone.threadId, `${clone.targetId}&${cloneHat.id}`);
  assert.equal(score(result), 0); assert.equal(score(await session.execute(['info'])), 0);
}));

test('batch trace byte budget evicts oversized accumulated locations and total response fails closed at 8 MiB', async () => withSession(async session => {
  await session.execute(['var', 'add', 'score', '0']);
  const hat = await add(session, 'event_whenflagclicked'), repeat = await add(session, 'control_repeat', ['--inputs', '{"TIMES":60}', '--after', hat.id]);
  const first = await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":1}', '--parent', repeat.id, '--input', 'SUBSTACK']);
  const second = await add(session, 'data_changevariableby', ['--fields', '{"VARIABLE":"score"}', '--inputs', '{"VALUE":1}', '--after', first.id]);
  // Genuine SB3 IDs may be large. Inflate the hat and command IDs in an archive,
  // not the logger implementation, to exercise the actual IPC trace byte bound.
  const zip = await JSZip.loadAsync(await session.project.bytes()), json = JSON.parse(await zip.file('project.json').async('string'));
  const rename = new Map([[hat.id, 'hat-' + 'h'.repeat(20000)], [first.id, 'first-' + 'a'.repeat(20000)], [second.id, 'second-' + 'b'.repeat(20000)]]);
  const blocks = json.targets[1].blocks;
  json.targets[1].blocks = Object.fromEntries(Object.entries(blocks).map(([id, block]) => {
    if (Array.isArray(block)) return [rename.get(id) || id, block];
    block.parent = rename.get(block.parent) || block.parent; block.next = rename.get(block.next) || block.next;
    for (const input of Object.values(block.inputs || {})) for (let index = 1; index < input.length; index++) if (typeof input[index] === 'string' && rename.has(input[index])) input[index] = rename.get(input[index]);
    return [rename.get(id) || id, block];
  }));
  zip.file('project.json', JSON.stringify(json));
  await session.project.load(await zip.generateAsync({type: 'nodebuffer'}));
  const result = await session.execute(['run', '--frames', '61', '--seed', '0', '--trace', '10000']);
  assert.equal(score(result), 120); assert.ok(result.trace.dropped > 0); assert.ok(result.trace.entries.length < 10000);
  assert.ok(result.trace.bytes <= 4 * 1024 * 1024);
  assert.equal(result.trace.bytes, result.trace.entries.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0));
  // Keep input metadata below its independent 8 MiB guard: a 5 MiB final list
  // plus the real ~4 MiB trace exceeds the total response limit, not a parser
  // or watch limit. Do not loosen either safety boundary to exercise this path.
  await session.execute(['list', 'add', 'huge', JSON.stringify(['x'.repeat(5 * 1024 * 1024)])]);
  await assert.rejects(session.execute(['run', '--frames', '61', '--seed', '0', '--trace', '10000']), /response exceeds 8 MiB/);
  assert.equal((await session.execute(['list', 'get', 'huge'])).value[0].length, 5 * 1024 * 1024);
  await session.execute(['list', 'delete', 'huge']);
  assert.ok((await session.execute(['run', '--frames', '1', '--trace', '1'])).trace);
}));

test('runtime start preflight rejects live-copy conflicts and invalid options before --project replaces editor state', async () => withSession(async (session, dir) => {
  const alpha = path.join(dir, 'alpha.sb3'), beta = path.join(dir, 'beta.sb3');
  await linear(session); await session.execute(['save', alpha]);
  await fs.writeFile(beta, await blankProject());
  await session.execute(['sprite', 'rename', 'Alpha']); await session.execute(['save']);
  session.runtimeSettings = {compiler: false, warpTimer: true, volume: 42};
  session.inputs = [{frame: 0, device: 'keyboard', data: {key: 'space', isDown: true}}];
  const before = {info: await session.execute(['info']), history: await session.execute(['history']),
    settings: structuredClone(session.runtimeSettings), inputs: structuredClone(session.inputs)};
  await call(session, 'start', '--paused'); const controller = session.runtimeController;
  await assert.rejects(call(session, 'start', '--project', beta, '--paused'), /already exists/);
  assert.deepEqual(await session.execute(['info']), before.info); assert.deepEqual(await session.execute(['history']), before.history);
  assert.deepEqual(session.runtimeSettings, before.settings); assert.deepEqual(session.inputs, before.inputs);
  assert.equal(session.runtimeController, controller); await call(session, 'stop');
  for (const invalid of [['--seed', '-1'], ['--fps', '0'], ['--trace', '10001'], ['--max-frames', '0'], ['--lifetime', '0'],
    ['--compile', '--no-compile'], ['--compile', '--trace', '10'], ['--target', 'Sprite1'], ['--answer', 'x'.repeat(10001)]]) {
    await assert.rejects(call(session, 'start', '--project', beta, ...invalid));
    assert.deepEqual(await session.execute(['info']), before.info); assert.deepEqual(await session.execute(['history']), before.history);
    assert.deepEqual(session.runtimeSettings, before.settings); assert.deepEqual(session.inputs, before.inputs);
  }
}));

test('legacy batch run and per-frame scheduled input stay compatible with persistent worker protocol', async () => withSession(async session => {
  await session.execute(['script', 'demo', '25']);
  for (const compile of [[], ['--compile']]) {
    const result = await session.execute(['run', '--frames', '2', '--seed', '123', ...compile]);
    assert.equal(result.targets[1].x, 25); assert.equal(result.frames, 2); assert.equal(result.noDOM, true);
  }
  assert.equal((await session.execute(['info'])).targets[1].x, 0);
}));
