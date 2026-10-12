const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EngineError } = require('../../src/engine/errors');
const { createEmit } = require('../../src/engine/events');
const manager = require('../../src/engine/process-manager');
const engine = require('../../src/engine');
const { freePort, isAlive, waitDead } = require('../helpers');

const root = path.resolve(__dirname, '../..');
const options = { timeout: 10000 };

// Base64 keeps JavaScript's quotes out of both POSIX shells and Windows cmd.
function nodeCommand(source) {
  const encoded = Buffer.from(source).toString('base64');
  return `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

function service(name, source, overrides = {}) {
  return { name, command: nodeCommand(source), cwd: root, env: {}, ...overrides };
}

async function waitUntil(predicate, description) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function history() {
  const emitter = new EventEmitter();
  const events = [];
  for (const name of ['service:starting', 'service:log', 'service:exited']) {
    emitter.on(name, payload => events.push({ name, payload }));
  }
  return { emit: createEmit(emitter), events };
}

async function start(t, spec, level = 0, records = history()) {
  const handle = await manager.spawnService(spec, { level, emit: records.emit });
  t.after(() => manager.terminate(handle, { graceMs: 50 }));
  return { handle, events: records.events };
}

test('EngineError carries every engine reason and service name', () => {
  for (const reason of ['spawn', 'timeout', 'crash', 'aborted']) {
    const error = new EngineError('example', { reason, serviceName: 'api' });
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'EngineError');
    assert.equal(error.message, 'example');
    assert.equal(error.reason, reason);
    assert.equal(error.serviceName, 'api');
  }
});

test('createEmit stamps a copied payload and contains a throwing UI listener', t => {
  const emitter = new EventEmitter();
  const emit = createEmit(emitter);
  const payload = { name: 'api', ts: -1 };
  let received;
  const startTime = performance.now();
  emitter.on('sample', value => { received = value; });
  emit('sample', payload);
  assert.notEqual(received, payload);
  assert.equal(payload.ts, -1);
  assert.ok(received.ts >= startTime && received.ts <= performance.now());
  const failure = new Error('broken UI');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  emitter.on('sample', () => { throw failure; });
  assert.doesNotThrow(() => emit('sample', payload));
  assert.match(errors[0][0], /listener error.*sample/);
  assert.equal(errors[0][1], failure);
});

test('createLineSplitter buffers chunks, split CRLF, empty lines and final partial lines', () => {
  const lines = [];
  const splitter = manager.createLineSplitter(line => lines.push(line));
  splitter.write('one\r');
  assert.deepEqual(lines, []);
  splitter.write('\n\ntw');
  splitter.write('o\nthree');
  assert.deepEqual(lines, ['one', '', 'two']);
  splitter.end();
  splitter.end();
  splitter.write('ignored\n');
  assert.deepEqual(lines, ['one', '', 'two', 'three']);
});

test('createLineSplitter avoids extra trailing lines and preserves lone carriage returns', () => {
  for (const [input, expected] of [
    ['', []], ['\n', ['']], ['a\n', ['a']], ['a\r\nb\r\n', ['a', 'b']],
    ['a\rb\r', ['a\rb\r']]
  ]) {
    const lines = [];
    const splitter = manager.createLineSplitter(line => lines.push(line));
    splitter.write(input);
    splitter.end();
    assert.deepEqual(lines, expected);
  }
});

test('spawned service is alive, registered, then dead after concurrent terminate calls', options, async t => {
  const { handle, events } = await start(t, service('alive', 'setInterval(() => {}, 1000);'), 2);
  assert.ok(isAlive(handle.pid));
  assert.ok(manager.isGroupAlive(handle.pid));
  assert.equal(handle.hasExited, false);
  assert.equal(handle.stopping, false);
  assert.deepEqual(engine.getRunning(), [{ name: 'alive', pid: handle.pid, level: 2 }]);
  assert.deepEqual(events.map(event => event.name), ['service:starting']);
  await Promise.all([
    manager.terminate(handle, { graceMs: 100 }),
    manager.terminate(handle, { graceMs: 100 })
  ]);
  assert.equal(isAlive(handle.pid), false);
  assert.equal(manager.isGroupAlive(handle.pid), false);
  assert.equal(handle.hasExited, true);
  assert.equal(handle.stopping, true);
  assert.deepEqual(engine.getRunning(), []);
  assert.equal(events.filter(event => event.name === 'service:exited').length, 1);
  const exited = await handle.exited;
  assert.deepEqual(Object.keys(exited), ['code', 'signal']);
  assert.ok(events.every(event => Number.isFinite(event.payload.ts)));
});

test('stdout/stderr log lines stay ordered per stream and flush partial UTF-8 lines on close', options, async t => {
  const source = `process.stdout.write('one\\r');
    setTimeout(() => {
      process.stdout.write('\\ntwo\\n');
      const bytes = Buffer.from('last \\u2603');
      process.stdout.write(bytes.subarray(0, bytes.length - 1));
      setTimeout(() => process.stdout.write(bytes.subarray(bytes.length - 1)), 20);
      process.stderr.write('error\\r\\npartial error');
    }, 20);`;
  const { handle, events } = await start(t, service('logs', source));
  await new Promise(resolve => handle.child.once('close', resolve));
  assert.deepEqual(events.filter(event => event.name === 'service:log' && event.payload.stream === 'stdout')
    .map(event => event.payload.line), ['one', 'two', 'last \u2603']);
  assert.deepEqual(events.filter(event => event.name === 'service:log' && event.payload.stream === 'stderr')
    .map(event => event.payload.line), ['error', 'partial error']);
  assert.deepEqual(handle.tail.sort(), ['one', 'two', 'last \u2603', 'error', 'partial error'].sort());
  assert.equal(handle.child.stdout.listenerCount('data'), 0);
  assert.equal(handle.child.stderr.listenerCount('data'), 0);
  assert.equal(handle.child.listenerCount('error'), 0);
});

test('log tail keeps only the last twenty lines', options, async t => {
  const { handle } = await start(t, service('tail',
    `for (let i = 0; i < 25; i++) process.stdout.write(i + '\\n');`));
  await new Promise(resolve => handle.child.once('close', resolve));
  assert.deepEqual(handle.tail, Array.from({ length: 20 }, (_, i) => String(i + 5)));
});

test('spawn inherits environment and honors overrides and a cwd containing spaces', options, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot engine cwd '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = `console.log(JSON.stringify({ cwd: process.cwd(),
    override: process.env.SERVICEBOOT_TEST_ENV, inherited: process.env.SERVICEBOOT_TEST_PARENT }));`;
  const original = process.env.SERVICEBOOT_TEST_PARENT;
  process.env.SERVICEBOOT_TEST_PARENT = 'parent value';
  t.after(() => {
    if (original === undefined) delete process.env.SERVICEBOOT_TEST_PARENT;
    else process.env.SERVICEBOOT_TEST_PARENT = original;
  });
  const { handle, events } = await start(t, service('cwd', source, {
    cwd: directory, env: { SERVICEBOOT_TEST_ENV: 'child value' }
  }));
  await new Promise(resolve => handle.child.once('close', resolve));
  const line = events.find(event => event.name === 'service:log').payload.line;
  assert.deepEqual(JSON.parse(line), {
    cwd: fs.realpathSync(directory), override: 'child value', inherited: 'parent value'
  });
});

test('terminate kills an ordinary grandchild as part of the service tree', options, async t => {
  const source = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: false, stdio: 'ignore', windowsHide: true
    });
    console.log('GC=' + child.pid);
    setInterval(() => {}, 1000);`;
  const { handle, events } = await start(t, service('tree', source));
  await waitUntil(() => events.some(event => /^GC=/.test(event.payload.line || '')), 'grandchild PID');
  const pid = Number(events.find(event => /^GC=/.test(event.payload.line || '')).payload.line.slice(3));
  t.after(async () => {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    await waitDead([pid], 1000);
  });
  assert.ok(isAlive(pid));
  await manager.terminate(handle, { graceMs: 100 });
  assert.ok(await waitDead([handle.pid, pid], 1000));
});

test('POSIX termination escalates when the leader exits but a grandchild ignores SIGTERM', {
  ...options, skip: os.platform() === 'win32'
}, async t => {
  const childSource = `process.on('SIGTERM', () => {});
    process.stdout.write('CHILD_READY\\n'); setInterval(() => {}, 1000);`;
  const source = `const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', Buffer.from('${Buffer.from(childSource).toString('base64')}', 'base64').toString()], {
      detached: false, stdio: ['ignore', 'pipe', 'ignore']
    });
    child.stdout.once('data', () => console.log('GC=' + child.pid));
    setInterval(() => {}, 1000);`;
  const { handle, events } = await start(t, service('stubborn-tree', source));
  await waitUntil(() => events.some(event => /^GC=/.test(event.payload.line || '')), 'ready grandchild');
  const pid = Number(events.find(event => /^GC=/.test(event.payload.line || '')).payload.line.slice(3));
  t.after(async () => {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    await waitDead([pid], 1000);
  });
  await manager.terminate(handle, { graceMs: 100 });
  assert.ok(await waitDead([handle.pid, pid], 1000));
});

test('mock ignoring SIGTERM dies within 1.5 seconds of terminate with a 300 ms grace', options, async t => {
  const port = await freePort();
  const spec = { name: 'stubborn', cwd: root, env: {},
    command: `"${process.execPath}" "${path.join(root, 'mock', 'mock-service.js')}" --port ${port} --ignore-sigterm --never-ready` };
  const { handle, events } = await start(t, spec);
  await waitUntil(() => events.some(event => event.payload.line === '[mock] starting'), 'mock startup');
  const started = performance.now();
  await manager.terminate(handle, { graceMs: 300 });
  assert.equal(isAlive(handle.pid), false);
  assert.ok(performance.now() - started < 1500);
});

test('bad cwd rejects with EngineError reason spawn and emits no start', options, async () => {
  const records = history();
  await assert.rejects(manager.spawnService(service('bad-cwd', '', {
    cwd: path.join(root, 'does-not-exist-serviceboot-cwd')
  }), { level: 0, emit: records.emit }), {
    name: 'EngineError', reason: 'spawn', serviceName: 'bad-cwd'
  });
  assert.deepEqual(records.events, []);
  assert.deepEqual(engine.getRunning(), []);
});

test('a nonexistent shell command spawns successfully then exits nonzero quickly', options, async t => {
  const started = performance.now();
  const { handle, events } = await start(t, {
    name: 'missing-command', command: 'serviceboot_nonexistent_command_01a13036', cwd: root, env: {}
  });
  const result = await handle.exited;
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.ok(performance.now() - started < 1500);
  assert.equal(events.filter(event => event.name === 'service:starting').length, 1);
  assert.equal(events.filter(event => event.name === 'service:exited').length, 1);
});

test('terminatePid stops a service by raw PID', options, async t => {
  const { handle } = await start(t, service('raw', 'setInterval(() => {}, 1000);'));
  await manager.terminatePid(handle.pid, { graceMs: 100 });
  assert.equal(handle.stopping, true);
  assert.equal(isAlive(handle.pid), false);
});

test('terminatePid stops an unregistered process group created by another engine process', options, async t => {
  const source = `const { spawnService } = require(${JSON.stringify(path.join(root, 'src', 'engine', 'process-manager.js'))});
    spawnService(${JSON.stringify(service('external', 'setInterval(() => {}, 1000);'))}, {
      level: 0, emit: () => {}
    }).then(handle => console.log('PID=' + handle.pid));`;
  const parent = spawn(process.execPath, ['-e', source], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  let errors = '';
  parent.stdout.setEncoding('utf8');
  parent.stderr.setEncoding('utf8');
  parent.stdout.on('data', chunk => { output += chunk; });
  parent.stderr.on('data', chunk => { errors += chunk; });
  const completion = new Promise((resolve, reject) => {
    parent.once('error', reject);
    parent.once('close', code => resolve(code));
  });
  let pid;
  t.after(async () => {
    if (pid && isAlive(pid)) await manager.terminatePid(pid, { graceMs: 0 });
    if (parent.exitCode === null) parent.kill('SIGKILL');
    await completion;
  });
  await waitUntil(() => /PID=\d+/.test(output), 'external service PID');
  pid = Number(/PID=(\d+)/.exec(output)[1]);
  assert.deepEqual(engine.getRunning(), []);
  assert.ok(isAlive(pid));
  await manager.terminatePid(pid, { graceMs: 100 });
  assert.equal(isAlive(pid), false);
  assert.equal(await completion, 0, errors);
  assert.equal(errors, '');
});

test('stopAll stops peers concurrently and tolerates repeated shutdown', options, async t => {
  const peers = [];
  for (let level = 0; level < 3; level++) {
    const { handle } = await start(t, service(`peer${level}`, 'setInterval(() => {}, 1000);'), level);
    peers.push(handle);
  }
  await Promise.all([engine.stopAll({ graceMs: 100 }), engine.stopAll({ graceMs: 100 })]);
  assert.ok(peers.every(handle => handle.stopping && handle.hasExited && !isAlive(handle.pid)));
  assert.deepEqual(engine.getRunning(), []);
  await engine.stopAll();
});

test('normal engine process exit synchronously kills its registered service tree', options, async t => {
  const treeSource = `const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: false, stdio: 'ignore', windowsHide: true
    });
    console.log('TREE=' + process.pid + ',' + grandchild.pid);
    setInterval(() => {}, 1000);`;
  const source = `const manager = require(${JSON.stringify(path.join(root, 'src', 'engine', 'process-manager.js'))});
    const { createEmit } = require(${JSON.stringify(path.join(root, 'src', 'engine', 'events.js'))});
    const { EventEmitter } = require('node:events');
    const emitter = new EventEmitter();
    emitter.on('service:log', ({ line }) => {
      if (line.startsWith('TREE=')) { console.log(line); process.exit(0); }
    });
    manager.spawnService(${JSON.stringify(service('exit-cleanup', treeSource))}, {
      level: 0, emit: createEmit(emitter)
    }).then(handle => console.log('PID=' + handle.pid));`;
  const child = spawn(process.execPath, ['-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: root
  });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  assert.equal(await completion, 0, errors);
  assert.equal(errors, '');
  const pid = Number(/PID=(\d+)/.exec(output)?.[1]);
  assert.ok(Number.isInteger(pid) && pid > 0, output);
  const tree = /TREE=(\d+),(\d+)/.exec(output);
  assert.ok(tree, output);
  const pids = [pid, Number(tree[1]), Number(tree[2])];
  t.after(async () => {
    if (isAlive(pid)) await manager.terminatePid(pid, { graceMs: 0 });
    for (const remaining of pids) {
      if (isAlive(remaining)) process.kill(remaining, 'SIGKILL');
    }
    await waitDead(pids, 1000);
  });
  assert.ok(await waitDead(pids, 1000));
});
