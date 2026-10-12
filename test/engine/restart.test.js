const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const engine = require('../../src/engine');
const manager = require('../../src/engine/process-manager');
const { loadPlan } = require('../../src/plan');
const { makeServices, record, isAlive, waitDead } = require('../helpers');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'expected recovery event before deadline');
    await pause(25);
  }
}
function observe(t) {
  const emitter = new EventEmitter();
  const history = record(emitter);
  const restarting = [];
  emitter.on('service:restarting', event => restarting.push(event));
  t.after(async () => {
    await engine.stopAll({ graceMs: 100 });
    assert.ok(await waitDead(history.filter('service:starting').map(event => event.payload.pid)));
  });
  return { emitter, history, restarting };
}

test('RESTART: sample retries twice, keeps its healthy sibling, then leaves only the failed service down', { timeout: 20000 }, async t => {
  const o = observe(t);
  const plan = loadPlan(path.resolve(__dirname, '../../samples/restart.yml'));
  const result = await engine.runEngine({ ...plan, algorithm: 'parallel', emitter: o.emitter });
  await until(() => o.history.filter('service:ready', 'crashing').length === 2);
  const current = engine.getRunning().find(service => service.name === 'crashing');
  assert.notEqual(current.pid, result.pids.crashing);
  assert.equal(o.history.filter('service:starting', 'crashing')[0].payload.pid, result.pids.crashing);
  await until(() => o.history.find('service:failed', 'crashing'));
  assert.equal(o.history.filter('service:starting', 'crashing').length, 3);
  assert.equal(o.history.filter('service:ready', 'crashing').length, 3);
  assert.equal(o.history.filter('service:failed', 'crashing').length, 1);
  assert.equal(o.history.find('service:failed', 'crashing').payload.reason, 'crash');
  assert.deepEqual(o.restarting.map(({ name, attempt, maxRetries, code, signal }) =>
    ({ name, attempt, maxRetries, code, signal })), [1, 2].map(attempt =>
    ({ name: 'crashing', attempt, maxRetries: 2, code: 1, signal: null })));
  assert.ok(o.restarting.every(event => Number.isFinite(event.ts)));
  assert.deepEqual(engine.getRunning().map(service => service.name), ['healthy']);
  assert.ok(isAlive(result.pids.healthy));
  assert.equal(o.history.filter('service:starting', 'healthy').length, 1);
  assert.equal(o.history.filter('run:failed').length, 0);
  assert.equal(o.history.filter('run:done').length, 1);
});

test('RESTART: early startup crashes use the retry budget before terminal failure blocks dependents', { timeout: 15000 }, async t => {
  const o = observe(t);
  const plan = await makeServices([
    { name: 'crashing', delay: 2000, extraArgs: ['--exit-after', 100, '--exit-code', 1] },
    { name: 'dependent', deps: ['crashing'], delay: 0 }
  ]);
  Object.assign(plan.services.crashing, { restart: 'on-failure', maxRetries: 2 });
  await assert.rejects(engine.runEngine({ ...plan, algorithm: 'parallel', emitter: o.emitter }),
    error => error.reason === 'crash' && error.serviceName === 'crashing');
  assert.equal(o.history.filter('service:starting', 'crashing').length, 3);
  assert.deepEqual(o.restarting.map(event => event.attempt), [1, 2]);
  assert.equal(o.history.filter('service:failed', 'crashing').length, 1);
  assert.equal(o.history.filter('service:starting', 'dependent').length, 0);
  assert.deepEqual(engine.getRunning(), []);
});

test('RESTART: startup succeeds after two crashes and then starts its dependent', { timeout: 15000 }, async t => {
  const o = observe(t);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-retry-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const plan = await makeServices([{ name: 'recovering', delay: 0 }, { name: 'dependent', deps: ['recovering'], delay: 0 }]);
  const source = `
    const fs = require('node:fs');
    const attempt = fs.existsSync('attempt') ? Number(fs.readFileSync('attempt', 'utf8')) + 1 : 1;
    fs.writeFileSync('attempt', String(attempt));
    if (attempt < 3) setTimeout(() => process.exit(1), 100);
    else require('node:net').createServer(socket => socket.end()).listen(${plan.services.recovering.readyCheck.port}, '127.0.0.1');
  `;
  Object.assign(plan.services.recovering, { cwd, restart: 'on-failure', maxRetries: 2,
    command: `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(source).toString('base64')}','base64').toString())"` });
  const result = await engine.runEngine({ ...plan, algorithm: 'parallel', emitter: o.emitter });
  assert.equal(o.history.filter('service:starting', 'recovering').length, 3);
  assert.equal(o.history.filter('service:ready', 'recovering').length, 1);
  assert.equal(o.history.filter('service:failed').length, 0);
  assert.equal(o.history.filter('service:ready', 'recovering')[0].payload.pid, result.pids.recovering);
  assert.ok(o.history.find('service:starting', 'dependent').i > o.history.find('service:ready', 'recovering').i);
});

test('RESTART: unexpected signal restarts once without preflight and exhaustion leaves dependents running', { timeout: 20000 }, async t => {
  const o = observe(t);
  const plan = await makeServices([{ name: 'signalled', delay: 0 }, { name: 'dependent', deps: ['signalled'], delay: 0 }]);
  Object.assign(plan.services.signalled, { restart: 'on-failure', maxRetries: 1 });
  const result = await engine.runEngine({ ...plan, algorithm: 'parallel', emitter: o.emitter });
  const first = manager.getManagedHandles().find(handle => handle.name === 'signalled');
  const originalTree = await engine.getTreePids(first.pid);
  first.child.kill('SIGKILL');
  await until(() => o.history.filter('service:ready', 'signalled').length === 2);
  assert.ok(await waitDead(originalTree), 'old descendants are dead before the replacement is ready');
  const replacement = manager.getManagedHandles().find(handle => handle.name === 'signalled');
  const replacementTree = await engine.getTreePids(replacement.pid);
  replacement.child.kill('SIGKILL');
  await until(() => o.history.find('service:failed', 'signalled'));
  assert.equal(o.restarting.length, 1);
  assert.equal(o.restarting[0].signal, 'SIGKILL');
  assert.equal(o.history.find('service:failed', 'signalled').payload.reason, 'crash');
  assert.equal(o.history.filter('service:starting', 'dependent').length, 1);
  assert.ok(isAlive(result.pids.dependent));
  assert.ok(await waitDead(replacementTree));
});

test('RESTART: maxRetries zero leaves a post-ready crash down without replacements', { timeout: 10000 }, async t => {
  const o = observe(t);
  const plan = await makeServices([{ name: 'crashing', delay: 0, extraArgs: ['--exit-after', 500, '--exit-code', 1] }]);
  Object.assign(plan.services.crashing, { restart: 'on-failure', maxRetries: 0 });
  await engine.runEngine({ ...plan, algorithm: 'parallel', emitter: o.emitter });
  await until(() => o.history.find('service:failed', 'crashing'));
  assert.equal(o.history.filter('service:starting').length, 1);
  assert.equal(o.history.find('service:failed', 'crashing').payload.reason, 'crash');
  assert.equal(o.restarting.length, 0);
  assert.deepEqual(engine.getRunning(), []);
});

test('RESTART: a clean code-zero exit is not restarted', { timeout: 10000 }, async t => {
  const o = observe(t);
  const plan = await makeServices([{ name: 'normal', delay: 0, extraArgs: ['--exit-after', 500, '--exit-code', 0] }]);
  Object.assign(plan.services.normal, { restart: 'on-failure', maxRetries: 2 });
  await engine.runEngine({ ...plan, algorithm: 'sequential', emitter: o.emitter });
  await until(() => o.history.find('service:exited', 'normal'));
  await pause(600);
  assert.equal(o.history.filter('service:starting').length, 1);
  assert.equal(o.restarting.length, 0);
  assert.equal(o.history.filter('service:failed').length, 0);
  assert.deepEqual(engine.getRunning(), []);
});

test('RESTART: stopAll interrupts backoff without a late respawn', { timeout: 10000 }, async t => {
  const o = observe(t);
  const plan = await makeServices([{ name: 'crashing', delay: 0, extraArgs: ['--exit-after', 500, '--exit-code', 1] }]);
  Object.assign(plan.services.crashing, { restart: 'on-failure', maxRetries: 2 });
  await engine.runEngine({ ...plan, algorithm: 'parallel', emitter: o.emitter });
  await until(() => o.restarting.length === 1);
  await pause(100);
  const started = Date.now();
  await engine.stopAll({ graceMs: 100 });
  assert.ok(Date.now() - started < 400, 'shutdown wakes the 500 ms backoff');
  await pause(600);
  assert.equal(o.history.filter('service:starting').length, 1);
  assert.equal(o.history.filter('service:failed').length, 0);
  assert.deepEqual(engine.getRunning(), []);
});
