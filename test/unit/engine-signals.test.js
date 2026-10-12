const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const engine = require('../../src/engine');
const { main } = require('../../src/cli');
const { EngineError } = require('../../src/engine/errors');

const root = path.resolve(__dirname, '../..');
const config = path.join(root, 'samples', 'small.yml');
const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];

test('signal cancellation during startup prints no failure and removes all CLI handlers', async t => {
  const lines = [];
  const errors = [];
  const counts = events.map(event => process.listenerCount(event));
  t.mock.method(console, 'log', line => lines.push(line));
  t.mock.method(console, 'error', line => errors.push(line));
  t.mock.method(engine, 'stopAll', async () => {
    await new Promise(resolve => setImmediate(resolve));
  });
  t.mock.method(engine, 'runEngine', ({ emitter }) => new Promise((resolve, reject) => {
    queueMicrotask(() => {
      process.emit('SIGINT');
      emitter.emit('run:failed', { error: 'startup aborted', ts: 1 });
      reject(new EngineError('startup aborted', { reason: 'aborted' }));
    });
  }));
  assert.equal(await main(['up', '--config', config]), 130);
  assert.deepEqual(errors, []);
  assert.deepEqual(lines, []);
  assert.deepEqual(events.map(event => process.listenerCount(event)), counts);
});

// Fatal process events and process.exit must run in a separate plain Node
// process. Emitting them in node:test would damage the parent test runner.
function runChild(action, { cleanupFails = false, force = false } = {}) {
  const source = `
    const engine = require('./src/engine');
    const manager = require('./src/engine/process-manager');
    const { main } = require('./src/cli');
    engine.runEngine = async () => {
      setImmediate(() => { ${action} });
      return { algorithm: 'adaptive', effectiveAlgorithm: 'sequential', totalMs: 0 };
    };
    engine.stopAll = async () => {
      console.log('STOP:begin');
      ${force ? 'await new Promise(() => {});' : 'await new Promise(resolve => setImmediate(resolve));'}
      ${cleanupFails ? "throw new Error('cleanup failed');" : "console.log('STOP:done');"}
    };
    manager.killAllSync = () => console.log('FORCE:kill');
    // An unrelated handle proves a fatal/forced exit does not wait forever.
    setInterval(() => {}, 1000);
    main(['up', '--config', ${JSON.stringify(config)}]).then(code => { process.exitCode = code; });
  `;
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', source], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 5000
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('CLI second signal exits immediately even when stopAll cannot finish', () => {
  const result = runChild("process.emit('SIGINT'); process.emit('SIGTERM');", { force: true });
  assert.equal(result.status, 130, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /STOP:begin\r?\nFORCE:kill/);
  assert.ok(!result.stdout.includes('STOP:done'));
});

for (const [name, action] of [
  ['uncaughtException', "throw new Error('fatal boom');"],
  ['unhandledRejection', "Promise.reject(new Error('fatal boom'));"],
  ['non-Error rejection', "Promise.reject('fatal boom');"]
]) {
  test(`CLI ${name} prints once, waits for best-effort cleanup and exits 3`, () => {
    const result = runChild(action);
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /fatal boom/);
    assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
    assert.match(result.stdout, /STOP:begin\r?\nSTOP:done/);
    assert.ok(!result.stdout.includes('FORCE:kill'));
  });
}

test('CLI fatal cleanup failure forces owned trees down and still exits 3', () => {
  const result = runChild("throw new Error('fatal boom');", { cleanupFails: true });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /fatal boom/);
  assert.match(result.stderr, /cleanup failed/);
  assert.match(result.stdout, /STOP:begin\r?\nFORCE:kill/);
});
