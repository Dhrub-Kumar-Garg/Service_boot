const test = require('node:test');
const { afterEach } = test;
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { analyze } = require('../../src/graph/adaptive');
const { makeServices, record, isAlive, waitDead } = require('../helpers');

const enginePath = process.env.ENGINE_PATH
  ? path.resolve(process.env.ENGINE_PATH) : path.resolve(__dirname, '../../src/engine/index.js');
const { runEngine, stopAll } = require(enginePath);
const repoRoot = path.resolve(__dirname, '../..');
const observedPids = new Set();
const options = { timeout: 30000 };

afterEach(async () => {
  try { await stopAll({ graceMs: 500 }); } catch { /* The shipped stub throws. */ }
  // Cleanup is independent of the assertions: even a broken engine must not
  // leave processes from a failed acceptance case running in the background.
  for (const pid of observedPids) {
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* It may have just exited. */ }
    }
  }
  await waitDead([...observedPids], 1000);
  observedPids.clear();
});

function trackedEmitter() {
  const emitter = new EventEmitter();
  const history = record(emitter);
  emitter.on('service:starting', payload => {
    if (Number.isInteger(payload.pid) && payload.pid > 0) observedPids.add(payload.pid);
  });
  return { emitter, history };
}

function roots(count, delay = 80) {
  return Array.from({ length: count }, (_, i) => ({ name: `r${i + 1}`, deps: [], delay }));
}

function diamond() {
  return [
    { name: 'a', deps: [], delay: 80 },
    { name: 'b', deps: ['a'], delay: 80 },
    { name: 'c', deps: ['a'], delay: 80 },
    { name: 'd', deps: ['b', 'c'], delay: 80 }
  ];
}

function wide() {
  return [
    ...roots(8),
    { name: 'api1', deps: ['r1', 'r2', 'r3'], delay: 80 },
    { name: 'api2', deps: ['r4', 'r5', 'r6', 'r7', 'r8'], delay: 80 }
  ];
}

function linear() {
  return Array.from({ length: 5 }, (_, i) => ({
    name: `n${i + 1}`, deps: i === 0 ? [] : [`n${i}`], delay: 80
  }));
}

function assertTimestamps(history) {
  for (const event of history.events) {
    assert.ok(Number.isFinite(event.payload.ts) && event.payload.ts >= 0, `${event.name} needs a performance.now() timestamp`);
  }
}

function assertReady(plan, history, result, algorithm) {
  const names = Object.keys(plan.services);
  assert.equal(result.algorithm, algorithm);
  assert.equal(result.effectiveAlgorithm, algorithm === 'adaptive' ? analyze(plan.groups).chosen : algorithm);
  assert.ok(Number.isFinite(result.totalMs) && result.totalMs >= 0);
  assert.deepEqual(Object.keys(result.pids).sort(), [...names].sort());
  assert.deepEqual(Object.keys(result.readyMs).sort(), [...names].sort());
  assert.equal(history.filter('service:ready').length, names.length);
  const runStart = history.find('run:start');
  const runDone = history.find('run:done');
  assert.ok(runStart && runDone, 'successful runs emit run:start and run:done');
  assert.equal(runStart.payload.algorithm, algorithm);
  assert.equal(runStart.payload.total, names.length);
  assert.equal(runDone.payload.algorithm, algorithm);
  assert.equal(runDone.payload.effectiveAlgorithm, result.effectiveAlgorithm);
  assert.equal(runDone.payload.totalMs, result.totalMs);
  for (const name of names) {
    const starting = history.find('service:starting', name);
    const ready = history.find('service:ready', name);
    assert.ok(starting && ready, `${name} must start and become ready`);
    assert.ok(starting.i > runStart.i && ready.i > starting.i && ready.i < runDone.i);
    assert.equal(starting.payload.pid, result.pids[name]);
    assert.equal(ready.payload.pid, result.pids[name]);
    assert.equal(ready.payload.ms, result.readyMs[name]);
    assert.equal(starting.payload.level, plan.groups.findIndex(group => group.includes(name)));
    assert.ok(Number.isInteger(result.pids[name]) && result.pids[name] > 0);
    assert.ok(Number.isFinite(result.readyMs[name]) && result.readyMs[name] >= 0);
  }
  if (result.effectiveAlgorithm === 'sequential') {
    assert.deepEqual(history.filter('service:starting').map(event => event.payload.name), plan.groups.flat());
  }
  assertTimestamps(history);
}

async function assertFailure(plan, history, emitter, name, reason) {
  let failure;
  try { await runEngine({ ...plan, algorithm: 'parallel', emitter }); } catch (error) { failure = error; }
  assert.ok(failure instanceof Error, 'runEngine must reject an Error');
  const failed = history.find('service:failed', name);
  // Include the rejection message in diagnostics: the current stub should fail
  // these acceptance tests visibly with NOT IMPLEMENTED, never pass silently.
  assert.ok(failed, failure.message);
  assert.equal(failed.payload.reason, reason);
  assert.ok(failed.payload.error, 'service:failed must include its error');
  assert.equal(history.filter('run:failed').length, 1);
  assert.ok(history.find('run:failed').payload.error, 'run:failed must include its error');
  assert.equal(history.filter('run:done').length, 0);
  assertTimestamps(history);
  const pids = history.filter('service:starting').map(event => event.payload.pid);
  assert.ok(pids.length > 0);
  assert.ok(await waitDead(pids, 3000), 'a failed run must clean up every started process');
  return failure;
}

for (const algorithm of ['sequential', 'parallel', 'adaptive']) {
  for (const [shape, specs] of [['diamond', diamond], ['wide', wide]]) {
    test(`ORDERING: ${algorithm} on ${shape} waits for every dependency`, options, async () => {
      const plan = await makeServices(specs());
      const { emitter, history } = trackedEmitter();
      const result = await runEngine({ ...plan, algorithm, emitter });
      assertReady(plan, history, result, algorithm);
      for (const service of Object.values(plan.services)) {
        for (const dependency of service.dependsOn) {
          assert.ok(history.find('service:starting', service.name).i > history.find('service:ready', dependency).i,
            `${service.name} started before ${dependency} was ready`);
        }
      }
      // Parallel is a barrier per level, not just a check of each service's
      // direct dependencies: every previous-level service must be ready first.
      for (let level = 1; level < plan.groups.length; level++) {
        for (const name of plan.groups[level]) {
          for (const previous of plan.groups[level - 1]) {
            assert.ok(history.find('service:starting', name).i > history.find('service:ready', previous).i,
              `${name} crossed the level barrier before ${previous} was ready`);
          }
        }
      }
    });
  }
}

test('SEQUENTIAL NO OVERLAP: five independent services have at most one in flight', options, async () => {
  const plan = await makeServices(roots(5));
  const { emitter, history } = trackedEmitter();
  const result = await runEngine({ ...plan, algorithm: 'sequential', emitter });
  assertReady(plan, history, result, 'sequential');
  assert.ok(history.maxInFlight() <= 1);
});

test('PARALLEL IS CONCURRENT AND FASTER: six delayed roots beat sequential', options, async () => {
  const plan = await makeServices(roots(6, 400));
  const serial = trackedEmitter();
  const sequential = await runEngine({ ...plan, algorithm: 'sequential', emitter: serial.emitter });
  assertReady(plan, serial.history, sequential, 'sequential');
  await stopAll({ graceMs: 500 });
  assert.ok(await waitDead(sequential.pids, 3000));
  const concurrent = trackedEmitter();
  const parallel = await runEngine({ ...plan, algorithm: 'parallel', emitter: concurrent.emitter });
  assertReady(plan, concurrent.history, parallel, 'parallel');
  assert.ok(concurrent.history.maxInFlight() >= 4, `maximum in flight was ${concurrent.history.maxInFlight()}`);
  assert.ok(parallel.totalMs < 0.6 * sequential.totalMs,
    `parallel=${parallel.totalMs}ms, sequential=${sequential.totalMs}ms`);
});

test('MAX-PARALLEL: cap two allows all six services to become ready', options, async () => {
  const plan = await makeServices(roots(6));
  const { emitter, history } = trackedEmitter();
  const result = await runEngine({ ...plan, algorithm: 'parallel', maxParallel: 2, emitter });
  assertReady(plan, history, result, 'parallel');
  assert.ok(history.maxInFlight() <= 2);
});

for (const [shape, specs, chosen] of [['wide', wide, 'parallel'], ['linear', linear, 'sequential']]) {
  test(`ADAPTIVE: ${shape} selects ${chosen} and emits the exact reason`, options, async () => {
    const plan = await makeServices(specs());
    const { emitter, history } = trackedEmitter();
    const result = await runEngine({ ...plan, algorithm: 'adaptive', emitter });
    assertReady(plan, history, result, 'adaptive');
    assert.equal(history.filter('adaptive:decision').length, 1);
    const decision = history.find('adaptive:decision');
    const expected = analyze(plan.groups);
    assert.equal(decision.payload.chosen, chosen);
    assert.equal(decision.payload.reason, expected.reason);
    assert.equal(decision.payload.depth, expected.depth);
    assert.equal(decision.payload.width, expected.width);
    assert.equal(result.effectiveAlgorithm, chosen);
    assert.ok(decision.i < history.find('service:starting').i);
  });
}

test('CRASH DURING STARTUP: bad service emits crash and all started PIDs die', options, async () => {
  const plan = await makeServices([
    { name: 'bad', delay: 2000, extraArgs: ['--exit-after', '100', '--exit-code', '1'] },
    { name: 'healthy', delay: 80 }
  ]);
  const { emitter, history } = trackedEmitter();
  await assertFailure(plan, history, emitter, 'bad', 'crash');
  assert.ok(history.find('service:starting', 'healthy'));
});

test('READY TIMEOUT: never-ready rejects within four seconds and cleans up', options, async () => {
  const plan = await makeServices([{ name: 'never', extraArgs: ['--never-ready'] }]);
  plan.services.never.timeoutMs = 1000;
  const { emitter, history } = trackedEmitter();
  const started = performance.now();
  await assertFailure(plan, history, emitter, 'never', 'timeout');
  assert.ok(performance.now() - started < 4000);
});

test('DEPENDENT NOT STARTED: failing X prevents Y from spawning', options, async () => {
  const plan = await makeServices([
    { name: 'X', delay: 2000, extraArgs: ['--exit-after', '100', '--exit-code', '1'] },
    { name: 'Y', deps: ['X'], delay: 0 }
  ]);
  const { emitter, history } = trackedEmitter();
  await assertFailure(plan, history, emitter, 'X', 'crash');
  assert.equal(history.filter('service:starting', 'Y').length, 0);
});

test('STOPALL: wide graph exits once per service with dependents before dependencies', options, async () => {
  const plan = await makeServices(wide());
  const { emitter, history } = trackedEmitter();
  const result = await runEngine({ ...plan, algorithm: 'parallel', emitter });
  assertReady(plan, history, result, 'parallel');
  const started = performance.now();
  await stopAll({ graceMs: 2000 });
  assert.ok(await waitDead(result.pids, Math.max(0, 3000 - (performance.now() - started))));
  assert.ok(performance.now() - started < 3000);
  assert.equal(history.filter('service:exited').length, Object.keys(plan.services).length);
  for (const service of Object.values(plan.services)) {
    assert.equal(history.filter('service:exited', service.name).length, 1);
    for (const dependency of service.dependsOn) {
      assert.ok(history.find('service:exited', service.name).i < history.find('service:exited', dependency).i,
        `${dependency} exited before its dependent ${service.name}`);
    }
  }
  assertTimestamps(history);
});

test('SIGKILL ESCALATION: ignore-sigterm is dead within two seconds', options, async () => {
  const plan = await makeServices([{ name: 'stubborn', delay: 0, extraArgs: ['--ignore-sigterm'] }]);
  const { emitter, history } = trackedEmitter();
  const result = await runEngine({ ...plan, algorithm: 'parallel', emitter });
  assertReady(plan, history, result, 'parallel');
  const started = performance.now();
  await stopAll({ graceMs: 500 });
  assert.ok(await waitDead(result.pids, Math.max(0, 2000 - (performance.now() - started))));
  assert.ok(performance.now() - started < 2000);
});

async function waitUntil(predicate, timeoutMs, description) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('CLI SIGINT: real CLI stops all children and exits within five seconds', {
  ...options, skip: process.platform === 'win32'
}, async t => {
  const plan = await makeServices(diamond());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-engine-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'serviceboot.yml');
  const rawServices = Object.fromEntries(Object.values(plan.services).map(service => [service.name, {
    command: service.command, cwd: service.cwd, depends_on: service.dependsOn,
    ready_check: `port ${service.readyCheck.port}`,
    ready_timeout_ms: service.timeoutMs, ready_interval_ms: service.intervalMs
  }]));
  fs.writeFileSync(file, yaml.dump({ version: 1, services: rawServices }));
  const preload = process.env.ENGINE_PATH ? ['--require', path.join(__dirname, '../helpers/engine-preload.js')] : [];
  const child = spawn(process.execPath, [...preload, path.join(repoRoot, 'bin/serviceboot.js'),
    'up', '--config', file, '--algorithm', 'parallel'], {
    cwd: repoRoot, env: { ...process.env, ...(process.env.ENGINE_PATH ? { ENGINE_PATH: enginePath } : {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let closed = false;
  let exitCode;
  let exitSignal;
  let spawnError;
  const pids = new Set();
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (const match of stdout.matchAll(/\bpid=(\d+)/g)) {
      pids.add(Number(match[1]));
      observedPids.add(Number(match[1]));
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => { spawnError = error; });
  child.on('close', (code, signal) => { closed = true; exitCode = code; exitSignal = signal; });
  t.after(async () => {
    if (!closed) child.kill('SIGKILL');
    await waitUntil(() => closed, 5000, 'CLI cleanup');
    for (const pid of pids) {
      if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Already gone. */ } }
    }
    await waitDead([...pids], 1000);
  });
  const allReady = () => {
    const ready = new Set([...stdout.matchAll(/^service:ready\s+(\S+)/gm)].map(match => match[1]));
    return Object.keys(plan.services).every(name => ready.has(name));
  };
  await waitUntil(() => allReady() || closed || spawnError, 10000, 'CLI services ready');
  assert.ifError(spawnError);
  assert.ok(allReady(), `CLI exited before readiness:\n${stderr || stdout}`);
  assert.equal(pids.size, Object.keys(plan.services).length);
  const started = performance.now();
  assert.equal(child.kill('SIGINT'), true);
  await waitUntil(() => closed, 5000, 'CLI SIGINT exit');
  assert.ok(performance.now() - started < 5000);
  assert.equal(exitCode, 130, stderr);
  assert.equal(exitSignal, null);
  assert.ok(await waitDead([...pids], 3000), 'CLI left child processes alive');
});

test('NO DOUBLE-SPAWN: each service starts exactly once in a normal run', options, async () => {
  const plan = await makeServices(wide());
  const { emitter, history } = trackedEmitter();
  const result = await runEngine({ ...plan, algorithm: 'parallel', emitter });
  assertReady(plan, history, result, 'parallel');
  assert.equal(history.filter('service:starting').length, Object.keys(plan.services).length);
  for (const name of Object.keys(plan.services)) assert.equal(history.filter('service:starting', name).length, 1);
});
