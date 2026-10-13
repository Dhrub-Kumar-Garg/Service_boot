const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const engine = require('../../src/engine');
const { runBenchmark, describe } = require('../../src/benchmark');

const root = path.resolve(__dirname, '../..');
const small = path.join(root, 'samples', 'small.yml');
const linear = path.join(root, 'samples', 'linear.yml');

test('BENCH: describe() gives mean, median, sample stdev and ignores missing values', () => {
  const stats = describe([10, 20, 30, null, undefined, NaN]);
  assert.deepEqual({ ...stats, stdev: Number(stats.stdev.toFixed(6)) }, { n: 3, mean: 20, median: 20, min: 10, max: 30, stdev: 10 });
  assert.equal(describe([4, 1, 3, 2]).median, 2.5);
  assert.equal(describe([5]).stdev, 0);
  assert.equal(describe([null]), null);
});

test('BENCH: runs are serial, round-robin, and stopAll is awaited after every run', async t => {
  const log = [];
  let active = 0;
  t.mock.method(engine, 'runEngine', async ({ algorithm, services, emitter }) => {
    assert.equal(active, 0, 'never two runs at once');
    active++;
    log.push(`run:${algorithm}:${Object.keys(services).length}`);
    emitter.emit('service:starting', { name: 'x', pid: 1, level: 0 });
    await new Promise(resolve => setTimeout(resolve, 5));
    const ready = Object.fromEntries(Object.keys(services).map(name => [name, 10]));
    return { algorithm, effectiveAlgorithm: algorithm === 'adaptive' ? 'sequential' : algorithm, totalMs: 100, readyMs: ready, pids: {} };
  });
  t.mock.method(engine, 'stopAll', async () => { log.push('stop'); active = 0; });
  const results = await runBenchmark({ configs: [small, linear], algorithms: ['sequential', 'parallel'], runs: 2, metrics: false, cooldownMs: 0 });
  assert.deepEqual(log, [
    'run:sequential:3', 'stop', 'run:parallel:3', 'stop', 'run:sequential:5', 'stop', 'run:parallel:5', 'stop',
    'run:sequential:3', 'stop', 'run:parallel:3', 'stop', 'run:sequential:5', 'stop', 'run:parallel:5', 'stop'
  ]);
  assert.equal(results.schemaVersion, 1);
  assert.equal(results.complete, true);
  assert.equal(results.runs.length, 8);
  assert.deepEqual(results.runs.map(run => run.round), [1, 1, 1, 1, 2, 2, 2, 2]);
  const row = results.summary.find(entry => entry.config === small && entry.algorithm === 'sequential');
  assert.equal(row.startupMs.n, 2);
  assert.equal(row.startupMs.mean, 100);
  assert.equal(row.peakRssBytes, null, 'metrics off means null, not zero');
  assert.equal(results.settings.maxParallel, null);
  assert.ok(results.environment.node.startsWith('v'));
});

test('BENCH: failed runs are counted but are not timing samples; cleanup still runs', async t => {
  let calls = 0;
  let stops = 0;
  t.mock.method(engine, 'runEngine', async ({ algorithm }) => {
    calls++;
    if (calls === 2) throw Object.assign(new Error('exited with code 1 before becoming ready'), { reason: 'crash' });
    return { algorithm, effectiveAlgorithm: algorithm, totalMs: 50 + calls, readyMs: { a: 1 }, pids: {} };
  });
  t.mock.method(engine, 'stopAll', async () => { stops++; });
  const results = await runBenchmark({ configs: [small], algorithms: ['parallel'], runs: 3, metrics: false, cooldownMs: 0 });
  assert.equal(stops, 3);
  const row = results.summary[0];
  assert.equal(row.runs, 3);
  assert.equal(row.successful, 2);
  assert.equal(row.failed, 1);
  assert.equal(row.startupMs.n, 2);
  assert.equal(results.runs[1].outcome, 'failed');
  assert.equal(results.runs[1].startupMs, null);
});

test('BENCH: cancellation stops scheduling new runs and marks the file incomplete', async t => {
  let cancelled = false;
  t.mock.method(engine, 'runEngine', async ({ algorithm }) => {
    cancelled = true;
    return { algorithm, effectiveAlgorithm: algorithm, totalMs: 1, readyMs: {}, pids: {} };
  });
  t.mock.method(engine, 'stopAll', async () => {});
  const results = await runBenchmark({ configs: [small], runs: 3, metrics: false, cooldownMs: 0, isCancelled: () => cancelled });
  assert.equal(results.runs.length, 1);
  assert.equal(results.complete, false);
});

test('BENCH: invalid config fails before any run starts', async t => {
  t.mock.method(engine, 'runEngine', async () => { throw new Error('must not run'); });
  await assert.rejects(runBenchmark({ configs: [small, path.join(root, 'samples', 'cyclic.yml')], metrics: false }), { name: 'ConfigError' });
});

function cli(args) {
  return spawnSync(process.execPath, [path.join(root, 'bin', 'serviceboot.js'), ...args], { cwd: root, encoding: 'utf8', timeout: 20000 });
}

test('BENCH CLI: option validation uses exit code 2', () => {
  for (const args of [
    ['benchmark', '--runs', '0'], ['benchmark', '--runs', 'x'], ['benchmark', '--algorithms', 'fast'],
    ['benchmark', '--algorithms', 'parallel,parallel'], ['benchmark', '--sample-ms', '10'],
    ['benchmark', '--out', ''], ['benchmark', '--exit-after-ready'], ['benchmark', '--algorithm', 'parallel'],
    ['up', '--runs', '2'], ['plan', '--config', 'a.yml', '--config', 'b.yml'], ['up', '--no-metrics'],
    ['plan', '--plain']
  ]) {
    const result = cli(args);
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
    assert.match(result.stderr, /^error:/);
  }
});

test('BENCH CLI: config errors exit 1 before anything is written', () => {
  const result = cli(['benchmark', '--config', 'samples/cyclic.yml', '--out', 'results/never.json']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Circular dependency/);
  assert.equal(require('node:fs').existsSync(path.join(root, 'results', 'never.json')), false);
});

test('CLI help lists every command and the exit codes', () => {
  const result = cli(['--help']);
  assert.equal(result.status, 0);
  for (const word of ['plan', 'up', 'down', 'benchmark', '--plain', '--quiet', '--no-color', '--runs', '--out', 'Exit codes']) {
    assert.ok(result.stdout.includes(word), word);
  }
});
