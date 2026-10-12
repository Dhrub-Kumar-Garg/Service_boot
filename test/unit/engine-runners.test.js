const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const path = require('node:path');
const engine = require('../../src/engine');
const processes = require('../../src/engine/process-manager');
const readiness = require('../../src/engine/readiness');
const { startOne } = require('../../src/engine/runners');
const { EngineError } = require('../../src/engine/errors');
const { analyze } = require('../../src/graph/adaptive');
const { makeServices, record, isAlive, waitDead } = require('../helpers');

const options = { timeout: 10000 };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Runner did not reach the expected state');
}

function fakeSpawns(t) {
  let pid = 100;
  t.mock.method(readiness, 'preflightPort', async () => {});
  return t.mock.method(processes, 'spawnService', async (service, { level, emit }) => {
    const handle = { name: service.name, pid: ++pid, level,
      hasExited: false, tail: [], exited: new Promise(() => {}) };
    emit('service:starting', { name: service.name, pid: handle.pid, level });
    return handle;
  });
}

test('runEngine rejects invalid algorithms, caps and group names before spawning or emitting', options, async t => {
  const emitter = new EventEmitter();
  const history = record(emitter);
  const spawn = t.mock.method(processes, 'spawnService', () => {
    throw new Error('validation must prevent spawning');
  });
  const valid = { services: { a: { name: 'a' } }, groups: [['a']], algorithm: 'parallel', emitter };
  for (const algorithm of ['fast', 'PARALLEL', undefined]) {
    await assert.rejects(engine.runEngine({ ...valid, algorithm }), TypeError);
  }
  for (const maxParallel of [0, -1, 1.5, NaN, '2', -Infinity]) {
    await assert.rejects(engine.runEngine({ ...valid, maxParallel }), TypeError);
  }
  for (const groups of [[['a'], ['missing']], [['toString']], [['a', 'a']], [null], null]) {
    await assert.rejects(engine.runEngine({ ...valid, groups }), TypeError);
  }
  assert.equal(spawn.mock.callCount(), 0);
  assert.deepEqual(history.events, []);
});

test('empty plans work with default emitter and supported cap values', options, async () => {
  for (const algorithm of ['sequential', 'parallel']) {
    for (const maxParallel of [1, 2, Infinity]) {
      const result = await engine.runEngine({ services: {}, groups: [], algorithm, maxParallel });
      assert.equal(result.algorithm, algorithm);
      assert.equal(result.effectiveAlgorithm, algorithm);
      assert.ok(result.totalMs >= 0);
      assert.deepEqual(Object.keys(result.readyMs), []);
      assert.deepEqual(Object.keys(result.pids), []);
    }
  }
});

test('adaptive empty plan announces the exact decision before completing', options, async () => {
  const emitter = new EventEmitter();
  const history = record(emitter);
  const result = await engine.runEngine({ services: {}, groups: [], algorithm: 'adaptive', emitter });
  assert.equal(result.algorithm, 'adaptive');
  assert.equal(result.effectiveAlgorithm, 'sequential');
  const { width, depth, chosen, reason } = analyze([]);
  assert.deepEqual(history.find('adaptive:decision').payload, {
    width, depth, chosen, reason, ts: history.find('adaptive:decision').payload.ts
  });
  assert.deepEqual(history.events.map(event => event.name), ['run:start', 'adaptive:decision', 'run:done']);
  assert.ok(history.events.every(event => Number.isFinite(event.payload.ts)));
});

test('parallel startup slots last until ready and enforce the complete level barrier', options, async t => {
  fakeSpawns(t);
  const gates = new Map();
  t.mock.method(readiness, 'waitForReady', service => {
    const gate = deferred();
    gates.set(service.name, gate);
    return gate.promise;
  });
  t.after(async () => {
    for (const gate of gates.values()) gate.resolve(1);
    await engine.stopAll();
  });
  const emitter = new EventEmitter();
  const history = record(emitter);
  const services = Object.freeze(Object.fromEntries(['a', 'b', 'c', 'd']
    .map(name => [name, Object.freeze({ name })])));
  const groups = Object.freeze([Object.freeze(['a', 'b', 'c']), Object.freeze(['d'])]);
  const run = engine.runEngine({ services, groups, algorithm: 'parallel', maxParallel: 2, emitter });
  await until(() => gates.size === 2);
  assert.deepEqual(history.filter('service:starting').map(event => event.payload.name), ['a', 'b']);
  gates.get('b').resolve(20);
  await until(() => gates.has('c'));
  assert.equal(gates.has('d'), false);
  gates.get('c').resolve(30);
  await until(() => history.filter('service:ready', 'c').length === 1);
  assert.equal(gates.has('d'), false, 'a still blocks the next level');
  gates.get('a').resolve(40);
  await until(() => gates.has('d'));
  gates.get('d').resolve(10);
  const result = await run;
  assert.equal(history.maxInFlight(), 2);
  assert.equal(history.find('service:starting', 'd').payload.level, 1);
  assert.deepEqual({ ...result.readyMs }, { a: 40, b: 20, c: 30, d: 10 });
  assert.deepEqual(Object.keys(result.pids).sort(), ['a', 'b', 'c', 'd']);
});

test('parallel first failure aborts peers, skips queued starts and emits no aborted service failure', options, async t => {
  fakeSpawns(t);
  let peerSignal;
  const failure = new EngineError('bad readiness', { reason: 'timeout', serviceName: 'bad' });
  t.mock.method(readiness, 'waitForReady', (service, { signal }) => {
    if (service.name === 'bad') return Promise.reject(failure);
    peerSignal = signal;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new EngineError('peer canceled', { reason: 'aborted', serviceName: service.name }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  });
  const emitter = new EventEmitter();
  const history = record(emitter);
  const services = Object.fromEntries(['bad', 'peer', 'queued', 'dependent'].map(name => [name, { name }]));
  await assert.rejects(engine.runEngine({ services, groups: [['bad', 'peer', 'queued'], ['dependent']],
    algorithm: 'parallel', maxParallel: 2, emitter }), error => error === failure);
  assert.deepEqual(history.filter('service:starting').map(event => event.payload.name), ['bad', 'peer']);
  assert.deepEqual(history.filter('service:failed').map(event => event.payload), [{
    name: 'bad', reason: 'timeout', error: 'bad readiness', ts: history.find('service:failed').payload.ts
  }]);
  assert.equal(history.filter('run:failed').length, 1);
  assert.equal(history.find('run:failed').payload.error, failure.message);
  assert.equal(history.filter('run:done').length, 0);
  assert.equal(getEventListeners(peerSignal, 'abort').length, 0);
});

test('simultaneous real worker failures report only the first rejection, regardless of declaration order', options, async t => {
  fakeSpawns(t);
  const gates = new Map();
  t.mock.method(readiness, 'waitForReady', service => {
    const gate = deferred();
    gates.set(service.name, gate);
    return gate.promise;
  });
  t.after(async () => {
    for (const gate of gates.values()) gate.resolve(0);
    await engine.stopAll();
  });
  const emitter = new EventEmitter();
  const history = record(emitter);
  const services = Object.fromEntries(['peer', 'root', 'queued', 'dependent'].map(name => [name, { name }]));
  const root = new EngineError('root crashed', { reason: 'crash', serviceName: 'root' });
  const run = engine.runEngine({ services, groups: [['peer', 'root', 'queued'], ['dependent']],
    algorithm: 'parallel', maxParallel: 2, emitter });
  const rejected = assert.rejects(run, error => error === root);
  await until(() => gates.size === 2);
  gates.get('root').reject(root);
  gates.get('peer').reject(new EngineError('peer timeout', { reason: 'timeout', serviceName: 'peer' }));
  await rejected;
  assert.deepEqual(history.filter('service:starting').map(event => event.payload.name), ['peer', 'root']);
  assert.equal(history.filter('service:failed').length, 1);
  assert.equal(history.find('service:failed').payload.name, 'root');
  assert.equal(history.find('service:failed').payload.reason, 'crash');
  assert.equal(history.filter('run:failed').length, 1);
  assert.equal(history.find('run:failed').payload.error, 'root crashed');
  assert.equal(history.filter('run:done').length, 0);
});

test('a first preflight failure cancels a peer still checking its port before spawn', options, async t => {
  const peerPreflight = deferred();
  const failure = new EngineError('busy port', { reason: 'spawn', serviceName: 'bad' });
  t.mock.method(readiness, 'preflightPort', service => service.name === 'bad'
    ? Promise.reject(failure) : peerPreflight.promise);
  const spawn = t.mock.method(processes, 'spawnService', () => assert.fail('must not spawn after failure'));
  t.after(() => { peerPreflight.resolve(); return engine.stopAll(); });
  const emitter = new EventEmitter();
  const history = record(emitter);
  const services = { bad: { name: 'bad' }, peer: { name: 'peer' } };
  const run = engine.runEngine({ services, groups: [['bad', 'peer']], algorithm: 'parallel', emitter });
  const rejected = assert.rejects(run, error => error === failure);
  await until(() => history.filter('service:failed').length === 1);
  peerPreflight.resolve();
  await rejected;
  assert.equal(spawn.mock.callCount(), 0);
  assert.deepEqual(history.events.map(event => event.name), ['run:start', 'service:failed', 'run:failed']);
  assert.equal(history.find('run:failed').payload.error, 'busy port');
});

test('startOne skips preflight and spawn when already aborted', options, async t => {
  const preflight = t.mock.method(readiness, 'preflightPort', () => assert.fail('must not preflight'));
  const spawn = t.mock.method(processes, 'spawnService', () => assert.fail('must not spawn'));
  const events = [];
  await assert.rejects(startOne({ name: 'queued' }, {
    aborted: true, emit: (...args) => events.push(args)
  }), { name: 'EngineError', reason: 'aborted', serviceName: 'queued' });
  assert.equal(preflight.mock.callCount(), 0);
  assert.equal(spawn.mock.callCount(), 0);
  assert.deepEqual(events, []);
});

test('startup guard and stopAll cover preflight before any process has spawned', options, async t => {
  const preflight = deferred();
  t.mock.method(readiness, 'preflightPort', () => preflight.promise);
  const spawn = t.mock.method(processes, 'spawnService', () => assert.fail('canceled preflight must not spawn'));
  t.after(() => { preflight.resolve(); return engine.stopAll(); });
  const emitter = new EventEmitter();
  const history = record(emitter);
  const plan = { services: { a: { name: 'a' } }, groups: [['a']], algorithm: 'sequential', emitter };
  const startup = engine.runEngine(plan);
  const rejected = assert.rejects(startup, { reason: 'aborted' });
  await assert.rejects(engine.runEngine(plan), { message: 'Engine already running; call stopAll() first' });
  const stopped = engine.stopAll({ graceMs: 50 });
  preflight.resolve();
  await stopped;
  // Once stopAll resolves, a fresh run may begin even if the old rejection's
  // consumer has not resumed yet. Its later finally cannot erase the new run.
  await engine.runEngine({ services: {}, groups: [], algorithm: 'parallel' });
  await rejected;
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(history.filter('service:failed').length, 0);
  assert.equal(history.filter('run:failed').length, 1);
});

test('special service names safely populate readiness and PID maps', options, async t => {
  fakeSpawns(t);
  t.mock.method(readiness, 'waitForReady', async () => 0);
  const names = ['__proto__', 'constructor', '2', '1'];
  const services = Object.fromEntries(names.map(name => [name, { name }]));
  const emitter = new EventEmitter();
  const history = record(emitter);
  const result = await engine.runEngine({ services, groups: [names], algorithm: 'sequential', emitter });
  assert.deepEqual(history.filter('service:starting').map(event => event.payload.name), names);
  assert.deepEqual(Object.keys(result.pids).sort(), [...names].sort());
  assert.equal(Object.hasOwn(result.readyMs, '__proto__'), true);
  assert.equal(result.readyMs.__proto__, 0);
});

test('running service guard rejects a second run without stopping the first service', options, async t => {
  const plan = await makeServices([{ name: 'guarded', delay: 0 }]);
  t.after(() => engine.stopAll({ graceMs: 100 }));
  const first = await engine.runEngine({ ...plan, algorithm: 'sequential' });
  const emitter = new EventEmitter();
  const history = record(emitter);
  await assert.rejects(engine.runEngine({ ...plan, algorithm: 'parallel', emitter }), {
    message: 'Engine already running; call stopAll() first'
  });
  assert.ok(isAlive(first.pids.guarded));
  assert.deepEqual(history.events, []);
  await engine.stopAll({ graceMs: 100 });
  assert.ok(await waitDead(first.pids));
});

test('a sequential spawn error cleans a ready predecessor and prevents later starts', options, async t => {
  const plan = await makeServices([
    { name: 'healthy', delay: 0 }, { name: 'bad', delay: 0 }, { name: 'later', delay: 0 }
  ]);
  plan.services.bad.cwd = path.join(__dirname, 'nonexistent-runner-cwd');
  t.after(() => engine.stopAll({ graceMs: 100 }));
  const emitter = new EventEmitter();
  const history = record(emitter);
  await assert.rejects(engine.runEngine({ ...plan, algorithm: 'sequential', emitter }), {
    name: 'EngineError', reason: 'spawn', serviceName: 'bad'
  });
  assert.deepEqual(history.filter('service:starting').map(event => event.payload.name), ['healthy']);
  assert.equal(history.filter('service:failed').length, 1);
  assert.equal(typeof history.find('service:failed', 'bad').payload.error, 'string');
  const pid = history.find('service:starting', 'healthy').payload.pid;
  assert.equal(isAlive(pid), false, 'cleanup completes before runEngine rejects');
  const exitedIndex = history.events.findIndex(event => event.name === 'service:exited');
  const failedIndex = history.events.findIndex(event => event.name === 'run:failed');
  assert.ok(exitedIndex >= 0 && failedIndex > exitedIndex, 'run:failed follows process cleanup');
  assert.equal(typeof history.find('run:failed').payload.error, 'string');
  assert.deepEqual(engine.getRunning(), []);
});

test('parallel engine combines HTTP and none readiness while leaving services running', options, async t => {
  const plan = await makeServices([{ name: 'web', delay: 0, extraArgs: ['--http'] }]);
  const port = plan.services.web.readyCheck.port;
  plan.services.web.readyCheck = { type: 'http', url: `http://127.0.0.1:${port}/health` };
  const code = Buffer.from('setInterval(() => {}, 1000);').toString('base64');
  plan.services.none = { ...plan.services.web, name: 'none', readyCheck: { type: 'none' },
    command: `"${process.execPath}" -e "eval(Buffer.from('${code}','base64').toString())"` };
  plan.groups = [['web', 'none']];
  t.after(() => engine.stopAll({ graceMs: 100 }));
  const result = await engine.runEngine({ ...plan, algorithm: 'parallel' });
  assert.equal(result.readyMs.none, 0);
  assert.ok(result.readyMs.web > 0);
  assert.ok(Object.values(result.pids).every(isAlive));
  assert.equal(engine.getRunning().length, 2);
  await engine.stopAll({ graceMs: 100 });
  assert.ok(await waitDead(result.pids));
});
