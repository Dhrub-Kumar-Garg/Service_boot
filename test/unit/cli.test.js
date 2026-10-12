const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPlan } = require('../../src/plan');
const { main } = require('../../src/cli');
const engine = require('../../src/engine');

const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'bin', 'serviceboot.js');
const stubMessage = 'NOT IMPLEMENTED: Person 2 implements this (see CONTRACT.md section 5)';

function runCli(args, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', timeout: 5000, windowsHide: true
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

for (const [sample, groups, depth, width, chosen] of [
  ['small', [['postgres', 'redis'], ['api']], 2, 2, 'SEQUENTIAL'],
  ['linear', [['a'], ['b'], ['c'], ['d'], ['e']], 5, 1, 'SEQUENTIAL'],
  ['wide', [['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'], ['api1', 'api2']], 2, 8, 'PARALLEL']
]) {
  test(`CLI plan ${sample} prints the correct levels and ${chosen} decision`, () => {
    const result = runCli(['plan', '--config', `samples/${sample}.yml`]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, new RegExp(`Config: samples/${sample}\\.yml  \\(${groups.flat().length} services\\)`));
    assert.match(result.stdout, /Start order \(levels\):/);
    groups.forEach((group, level) => assert.ok(result.stdout.includes(`  Level ${level}: ${group.join(', ')}`)));
    assert.ok(result.stdout.includes(`Graph analysis: depth=${depth} width=${width}`));
    assert.ok(result.stdout.includes(`Adaptive decision: ${chosen}`));
    assert.ok(result.stdout.includes(loadPlan(path.join(root, 'samples', `${sample}.yml`)).analysis.reason));
    assert.ok(!result.stdout.includes('\u001b'));
  });
}

test('CLI cyclic sample exits 1 and prints the cycle path', () => {
  const result = runCli(['plan', '--config', 'samples/cyclic.yml']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'error: Circular dependency detected: a -> b -> c -> a');
});

test('CLI invalid sample exits 1 and prints all three problems separately', () => {
  const result = runCli(['plan', '--config', 'samples/invalid.yml']);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const lines = result.stderr.trim().split(/\r?\n/);
  assert.equal(lines.length, 3);
  assert.ok(lines.every(line => line.startsWith('error: ')));
  assert.equal(lines[0], 'error: Service "api" depends on unknown service "missing"');
  assert.match(lines[1], /Service "worker" and Service "api".*port 4141/);
  assert.match(lines[2], /Service "broken" ready_check:/);
});

test('CLI missing file exits 1 for both plan and up', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'missing.yml');
  for (const command of ['plan', 'up']) {
    const result = runCli([command, '--config', file]);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), `error: Config file not found: ${file}`);
  }
});

test('CLI --json prints only valid JSON matching loadPlan', () => {
  const result = runCli(['plan', '--config', 'samples/wide.yml', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), loadPlan(path.join(root, 'samples', 'wide.yml')));
});

test('CLI default config is serviceboot.yml in the current working directory', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, 'samples', 'small.yml'), path.join(directory, 'serviceboot.yml'));
  const result = runCli(['plan'], directory);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith('Config: ./serviceboot.yml  (3 services)'));
});

test('CLI unknown command, missing command, extra positionals, and unknown options exit 2', () => {
  for (const args of [['unknown'], [], ['plan', 'extra'], ['plan', '--bogus']]) {
    const result = runCli(args);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stderr, /^error:/);
  }
});

test('CLI --help and -h print usage and exit 0', () => {
  for (const args of [['--help'], ['-h'], ['plan', '--help'], ['up', '--help']]) {
    const result = runCli(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stderr, '');
  }
});

test('CLI up with the engine stub exits 3 with its exact message', () => {
  const result = runCli(['up', '--config', 'samples/small.yml']);
  assert.equal(result.status, 3);
  assert.equal(result.stderr.trim(), `error: ${stubMessage}`);
  assert.equal(result.stdout, '');
});

test('runEngine remains a stub and stopAll safely handles an empty registry', async () => {
  await assert.rejects(engine.runEngine(), { message: stubMessage });
  await engine.stopAll();
  assert.deepEqual(engine.getRunning(), []);
});

test('CLI rejects invalid algorithms before loading a config', () => {
  for (const algorithm of ['fast', 'PARALLEL', '']) {
    const result = runCli(['up', `--algorithm=${algorithm}`]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--algorithm must be sequential, parallel, or adaptive/);
  }
});

test('CLI accepts all three algorithms and positive max-parallel values', () => {
  for (const algorithm of ['sequential', 'parallel', 'adaptive']) {
    const result = runCli(['up', '--config', 'samples/small.yml', '--algorithm', algorithm,
      '--max-parallel', '2', '--exit-after-ready']);
    assert.equal(result.status, 3);
    assert.equal(result.stderr.trim(), `error: ${stubMessage}`);
  }
});

test('CLI max-parallel must be a positive integer', () => {
  for (const value of ['0', '-1', '1.5', 'Infinity', '1e2', 'abc', '', '9007199254740992']) {
    const result = runCli(['up', `--max-parallel=${value}`]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--max-parallel must be a positive integer/);
  }
});

test('CLI rejects options belonging to the other command and missing option values', () => {
  for (const args of [
    ['plan', '--algorithm', 'parallel'], ['plan', '--max-parallel', '2'],
    ['plan', '--exit-after-ready'], ['up', '--json'], ['plan', '--config'], ['plan', '--config=']
  ]) assert.equal(runCli(args).status, 2);
});

function captureConsole(t) {
  const lines = [];
  const errors = [];
  t.mock.method(console, 'log', line => lines.push(line));
  t.mock.method(console, 'error', line => errors.push(line));
  return { lines, errors };
}

function readyResult(algorithm = 'adaptive') {
  return { algorithm, effectiveAlgorithm: 'sequential', totalMs: 42, readyMs: {}, pids: {} };
}

test('CLI wires engine options, prints every contract event, and stops after ready', async t => {
  const { lines, errors } = captureConsole(t);
  const config = path.join(root, 'samples', 'small.yml');
  let received;
  let stops = 0;
  t.mock.method(engine, 'runEngine', async options => {
    received = options;
    for (const [event, payload] of [
      ['run:start', { algorithm: 'parallel', total: 3 }],
      ['adaptive:decision', { width: 2, depth: 2, chosen: 'sequential', reason: 'test reason' }],
      ['service:starting', { name: 'api', pid: 1234, level: 1 }],
      ['service:log', { name: 'api', stream: 'stdout', line: 'hello\nworld' }],
      ['service:ready', { name: 'api', pid: 1234, ms: 12 }],
      ['service:failed', { name: 'api', reason: 'crash', error: new Error('fake\nerror') }],
      ['service:exited', { name: 'api', code: 0, signal: null }],
      ['run:done', { algorithm: 'parallel', effectiveAlgorithm: 'parallel', totalMs: 42 }],
      ['run:failed', { error: new Error('fake error') }]
    ]) options.emitter.emit(event, { ...payload, ts: 10 });
    return readyResult('parallel');
  });
  t.mock.method(engine, 'stopAll', async options => {
    assert.deepEqual(options, {});
    stops++;
  });
  assert.equal(await main(['up', '--config', config, '--algorithm', 'parallel', '--max-parallel', '2', '--exit-after-ready']), 0);
  assert.deepEqual(received.services, loadPlan(config).services);
  assert.deepEqual(received.groups, [['postgres', 'redis'], ['api']]);
  assert.equal(received.algorithm, 'parallel');
  assert.equal(received.maxParallel, 2);
  assert.ok(received.emitter instanceof EventEmitter);
  assert.equal(stops, 1);
  assert.equal(lines.length, 10);
  assert.ok(lines.includes('service:starting api pid=1234 level=1 ts=10'));
  assert.ok(lines.some(line => line.includes('line=hello\\nworld')));
  assert.ok(lines.every(line => !/[\r\n\u001b]/.test(line)));
  assert.match(lines[9], /^Ready: 3 services .*totalMs=42/);
  assert.deepEqual(errors, []);
});

test('CLI defaults to adaptive and unlimited parallelism', async t => {
  captureConsole(t);
  t.mock.method(engine, 'runEngine', async options => {
    assert.equal(options.algorithm, 'adaptive');
    assert.equal(options.maxParallel, Infinity);
    return readyResult();
  });
  t.mock.method(engine, 'stopAll', async () => {});
  assert.equal(await main(['up', '--config', path.join(root, 'samples', 'small.yml'), '--exit-after-ready']), 0);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`CLI waits after readiness and stops on ${signal} with exit ${code}`, async t => {
    const { lines } = captureConsole(t);
    const before = process.listenerCount(signal);
    let stops = 0;
    t.mock.method(engine, 'runEngine', async () => {
      setImmediate(() => process.emit(signal));
      return readyResult();
    });
    t.mock.method(engine, 'stopAll', async () => { stops++; });
    assert.equal(await main(['up', '--config', path.join(root, 'samples', 'small.yml')]), code);
    assert.ok(lines.some(line => line.startsWith('Ready:')));
    assert.equal(stops, 1);
    assert.equal(process.listenerCount(signal), before);
  });
}

test('CLI can stop during startup without waiting for unresolved readiness', async t => {
  const { lines } = captureConsole(t);
  let stops = 0;
  t.mock.method(engine, 'runEngine', () => {
    queueMicrotask(() => process.emit('SIGTERM'));
    return new Promise(() => {});
  });
  t.mock.method(engine, 'stopAll', async () => { stops++; });
  assert.equal(await main(['up', '--config', path.join(root, 'samples', 'small.yml')]), 143);
  assert.equal(stops, 1);
  assert.ok(!lines.some(line => line.startsWith('Ready:')));
});

test('CLI repeated signals call stopAll only once', async t => {
  captureConsole(t);
  let stops = 0;
  t.mock.method(engine, 'runEngine', async () => {
    setImmediate(() => { process.emit('SIGINT'); process.emit('SIGTERM'); });
    return readyResult();
  });
  t.mock.method(engine, 'stopAll', async () => {
    stops++;
    await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(await main(['up', '--config', path.join(root, 'samples', 'small.yml')]), 130);
  assert.equal(stops, 1);
});

test('CLI shutdown failure prints the engine error and exits 3', async t => {
  const { errors } = captureConsole(t);
  t.mock.method(engine, 'runEngine', async () => readyResult());
  t.mock.method(engine, 'stopAll', async () => { throw new Error('cleanup failed'); });
  assert.equal(await main(['up', '--config', path.join(root, 'samples', 'small.yml'), '--exit-after-ready']), 3);
  assert.deepEqual(errors, ['error: cleanup failed']);
});
