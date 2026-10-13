const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const engine = require('../../src/engine');
const { createCollector } = require('../../src/metrics/collector');
const { isAlive } = require('../helpers');

const root = path.resolve(__dirname, '../..');
const supported = ['linux', 'darwin', 'win32'].includes(process.platform);

// A real "service" whose CPU work happens in a GRANDCHILD: shell -> node parent
// -> node busy child. Measuring only the leader would report almost nothing.
// The scripts are files, not `node -e "..."`: cmd.exe has no backslash quote
// escaping, so characters such as < inside an inline script become redirections.
function busyTreeService(name, port, dir) {
  const child = path.join(dir, 'busy-child.js');
  const parent = path.join(dir, 'busy-parent.js');
  fs.writeFileSync(child, 'const s = Date.now(); while (Date.now() - s < 4000) {}\n');
  fs.writeFileSync(parent, [
    "const { spawn } = require('child_process');",
    `spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' });`,
    `require('net').createServer().listen(${port}, '127.0.0.1');`,
    'setInterval(() => {}, 1000);'
  ].join('\n'));
  return {
    name, command: `"${process.execPath}" "${parent}"`,
    cwd: dir, env: {}, dependsOn: [], readyCheck: { type: 'port', port },
    timeoutMs: 10000, intervalMs: 100, restart: 'never', maxRetries: 3
  };
}

test('METRICS (real): busy grandchild CPU is attributed to its service tree; stop leaves no timers', { skip: !supported, timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-busy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = busyTreeService('busy', 44731, dir);
  const collector = createCollector({ intervalMs: 300 });
  let pids = [];
  let summary;
  try {
    await engine.runEngine({ services: { busy: service }, groups: [['busy']], algorithm: 'sequential', emitter: new EventEmitter() });
    collector.start();
    await new Promise(resolve => setTimeout(resolve, 1500));
    pids = await engine.getTreePids(engine.getRunning()[0].pid);
  } finally {
    // Cleanup only here; assertions come after, so they can never hide the
    // original error of a failed startup.
    summary = await collector.stop();
    await engine.stopAll();
  }
  assert.ok(pids.length >= 2, `tree ${pids}`);
  assert.ok(summary.sampleCount >= 3, JSON.stringify(summary));
  assert.equal(summary.errors, 0, summary.lastError);
  // One core spinning in the grandchild: well above idle.
  assert.ok(summary.cpu.peakPercent > 40, `peak CPU ${summary.cpu.peakPercent}`);
  assert.ok(summary.memory.peakRssBytes > 10 * 1024 * 1024);
  assert.ok(Math.max(...summary.samples.map(sample => sample.perService[0]?.treePids || 0)) >= 2);
  if (process.platform === 'linux') assert.equal(summary.contextSwitches.available, true);
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const pid of pids) assert.equal(isAlive(pid), false, `pid ${pid} survived`);
});

test('BENCH (real CLI): small config, 2 runs x 3 algorithms -> valid results JSON, no processes left', { skip: !supported, timeout: 90000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-bench-'));
  const out = path.join(dir, 'results.json');
  const result = spawnSync(process.execPath, [path.join(root, 'bin', 'serviceboot.js'), 'benchmark',
    '--config', 'samples/small.yml', '--runs', '2', '--out', out, '--sample-ms', '200'], {
    cwd: root, encoding: 'utf8', timeout: 80000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const data = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.complete, true);
  assert.equal(data.runs.length, 6);
  assert.ok(data.runs.every(run => run.outcome === 'ok' && run.startupMs > 0 && run.shutdownMs >= 0));
  const adaptive = data.runs.filter(run => run.algorithm === 'adaptive');
  assert.ok(adaptive.every(run => run.effectiveAlgorithm === 'sequential' && run.adaptiveDecision.chosen === 'sequential'));
  for (const row of data.summary) {
    assert.equal(row.startupMs.n, 2);
    assert.deepEqual(Object.keys(row.perServiceReadyMs), ['postgres', 'redis', 'api']);
    assert.ok(row.peakRssBytes.mean > 0);
  }
  // Parallel overlaps postgres and redis (each ~300 ms delay), sequential cannot.
  const mean = algorithm => data.summary.find(row => row.algorithm === algorithm).startupMs.mean;
  assert.ok(mean('parallel') < mean('sequential'), `${mean('parallel')} vs ${mean('sequential')}`);
  assert.equal(fs.existsSync(path.join(root, '.serviceboot', 'pids.json')), false, 'benchmark removes its PID record');
  const pids = data.runs.flatMap(run => run.metrics.samples.flatMap(sample => sample.perService.map(service => service.pid)));
  for (const pid of new Set(pids)) assert.equal(isAlive(pid), false, `pid ${pid} survived`);
  fs.rmSync(dir, { recursive: true, force: true });
});
