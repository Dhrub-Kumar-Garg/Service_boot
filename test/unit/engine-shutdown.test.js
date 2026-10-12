const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const engine = require('../../src/engine');
const processes = require('../../src/engine/process-manager');
const { makeServices, record, isAlive } = require('../helpers');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let tries = 0; tries < 200; tries++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Shutdown did not reach the expected state');
}

test('stopAll shares one promise, starts peers together and drains deeper levels first', async t => {
  const handles = [
    { name: 'root', level: 0 }, { name: 'left', level: 2 },
    { name: 'middle', level: 1 }, { name: 'right', level: 2 }
  ];
  const gates = Object.fromEntries(handles.map(handle => [handle.name, deferred()]));
  const starts = [];
  let registered = handles;
  t.mock.method(processes, 'getManagedHandles', () => registered);
  t.mock.method(processes, 'terminate', (handle, options) => {
    assert.equal(options.graceMs, 75, 'the first caller owns the grace period');
    starts.push(handle.name);
    return gates[handle.name].promise;
  });
  t.after(async () => {
    for (const gate of Object.values(gates)) gate.resolve();
    await engine.stopAll();
  });
  const first = engine.stopAll({ graceMs: 75 });
  const second = engine.stopAll({ graceMs: 500 });
  assert.strictEqual(first, second);
  await until(() => starts.length === 2);
  assert.deepEqual(starts, ['left', 'right']);
  gates.left.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(starts, ['left', 'right'], 'one unfinished peer blocks the next level');
  gates.right.resolve();
  await until(() => starts.length === 3);
  assert.deepEqual(starts, ['left', 'right', 'middle']);
  gates.middle.resolve();
  await until(() => starts.length === 4);
  gates.root.resolve();
  await first;
  registered = [];
  await engine.stopAll();
  assert.equal(starts.length, 4);
});

test('stopAll drains peers and attempts shallower levels after a termination error', async t => {
  const root = { name: 'root', level: 0 };
  const bad = { name: 'bad', level: 1 };
  const peer = { name: 'peer', level: 1 };
  const gate = deferred();
  const starts = [];
  const failure = new Error('OS termination failed');
  t.mock.method(processes, 'getManagedHandles', () => [root, bad, peer]);
  t.mock.method(processes, 'terminate', handle => {
    starts.push(handle.name);
    if (handle === bad) return Promise.reject(failure);
    if (handle === peer) return gate.promise;
    return Promise.resolve();
  });
  t.after(() => { gate.resolve(); });
  const rejected = assert.rejects(engine.stopAll(), error => error === failure);
  await until(() => starts.length === 2);
  assert.deepEqual(starts, ['bad', 'peer']);
  gate.resolve();
  await rejected;
  assert.deepEqual(starts, ['bad', 'peer', 'root']);
});

test('stopAll includes not-ready services, aborts startup and emits one exit per process', { timeout: 10000 }, async t => {
  const plan = await makeServices([
    { name: 'root', delay: 0 },
    { name: 'pending', deps: ['root'], extraArgs: ['--never-ready'] },
    { name: 'queued', deps: ['pending'], delay: 0 }
  ]);
  t.after(() => engine.stopAll({ graceMs: 100 }));
  const emitter = new EventEmitter();
  const history = record(emitter);
  const run = engine.runEngine({ ...plan, algorithm: 'parallel', emitter });
  const rejected = assert.rejects(run, { name: 'EngineError', reason: 'aborted' });
  await until(() => history.filter('service:starting', 'pending').length === 1);
  assert.equal(history.filter('service:ready', 'pending').length, 0);
  const first = engine.stopAll({ graceMs: 100 });
  assert.strictEqual(engine.stopAll({ graceMs: 3000 }), first);
  await first;
  await rejected;
  assert.equal(history.filter('service:starting', 'queued').length, 0);
  assert.equal(history.filter('service:failed').length, 0);
  const names = history.filter('service:starting').map(event => event.payload.name);
  assert.deepEqual(names, ['root', 'pending']);
  for (const name of names) {
    assert.equal(history.filter('service:exited', name).length, 1);
    assert.equal(isAlive(history.find('service:starting', name).payload.pid), false);
  }
  assert.ok(history.find('service:exited', 'pending').i < history.find('service:exited', 'root').i);
  assert.deepEqual(engine.getRunning(), []);
  await engine.stopAll();
  assert.equal(history.filter('service:exited').length, 2);
});
