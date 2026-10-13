const test = require('node:test');
const assert = require('node:assert/strict');
const { createCollector } = require('../../src/metrics/collector');
const processes = require('../../src/engine/process-manager');

const LINUX = { platform: 'linux', cpu: true, memory: true, contextSwitches: true, source: 'test' };

function fakes(script) {
  // script: array of per-sample process lists for PIDs 10 (leader) and 11 (child)
  let call = 0;
  return {
    getRunning: () => [{ name: 'svc', pid: 10, level: 0 }],
    getForestPids: async roots => new Map(roots.map(root => [root, [root, 11]])),
    sampleProcesses: async () => script[Math.min(call++, script.length - 1)]
  };
}

test('METRICS: CPU% is the sum of per-process CPU-time deltas over wall time; memory sums the tree', async () => {
  const deps = fakes([
    [{ pid: 10, cpuMs: 0, rssBytes: 1000, voluntaryCtx: 1, involuntaryCtx: 0 },
      { pid: 11, cpuMs: 100, rssBytes: 4000, voluntaryCtx: 5, involuntaryCtx: 2 }],
    [{ pid: 10, cpuMs: 0, rssBytes: 1000, voluntaryCtx: 1, involuntaryCtx: 0 },
      { pid: 11, cpuMs: 300, rssBytes: 9000, voluntaryCtx: 9, involuntaryCtx: 4 }]
  ]);
  const collector = createCollector({ ...deps, support: LINUX, intervalMs: 50 });
  const first = await collector.sampleOnce();
  assert.equal(first.cpuPercent, null, 'no interval before the first sample');
  assert.equal(first.rssBytes, 5000);
  await new Promise(resolve => setTimeout(resolve, 100));
  const second = await collector.sampleOnce();
  // 200 ms of CPU in roughly 100 ms of wall time: about two busy cores.
  assert.ok(second.cpuPercent > 100 && second.cpuPercent <= 200, String(second.cpuPercent));
  assert.equal(second.rssBytes, 10000);
  assert.equal(second.perService[0].treePids, 2);
  const summary = collector.summary();
  assert.equal(summary.memory.peakRssBytes, 10000);
  assert.equal(summary.contextSwitches.available, true);
  assert.equal(summary.contextSwitches.voluntary, 10);
  assert.equal(summary.contextSwitches.involuntary, 4);
  assert.equal(summary.processesSeen, 2);
});

test('METRICS: unsupported counters are reported unavailable with a reason, never as zero', async () => {
  const deps = fakes([[{ pid: 10, cpuMs: 5, rssBytes: 100, voluntaryCtx: null, involuntaryCtx: null }]]);
  const collector = createCollector({ ...deps, support: { ...LINUX, platform: 'darwin', contextSwitches: false }, intervalMs: 50 });
  await collector.sampleOnce();
  const summary = collector.summary();
  assert.equal(summary.contextSwitches.available, false);
  assert.equal(summary.contextSwitches.voluntary, null);
  assert.match(summary.contextSwitches.reason, /darwin/);

  const none = createCollector({ ...deps, support: { platform: 'aix', cpu: false, memory: false, contextSwitches: false, source: null } });
  await none.sampleOnce();
  const unsupported = none.summary();
  assert.equal(unsupported.cpu.available, false);
  assert.equal(unsupported.memory.available, false);
});

test('METRICS: snapshots never overlap and stop() drains the in-flight query', async () => {
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const collector = createCollector({
    support: LINUX, intervalMs: 50,
    getRunning: () => [{ name: 'svc', pid: 10, level: 0 }],
    getForestPids: async roots => {
      active++; calls++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 120)); // slower than the interval
      active--;
      return new Map(roots.map(root => [root, [root]]));
    },
    sampleProcesses: async () => [{ pid: 10, cpuMs: calls * 10, rssBytes: 10, voluntaryCtx: 0, involuntaryCtx: 0 }]
  });
  collector.start();
  await new Promise(resolve => setTimeout(resolve, 400));
  const summary = await collector.stop();
  assert.equal(maxActive, 1);
  assert.equal(active, 0);
  const after = calls;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls, after, 'no sampling after stop');
  assert.ok(summary.sampleCount >= 2);
});

test('METRICS: a failing OS query is counted, not thrown into the measured run', async () => {
  const collector = createCollector({
    support: LINUX,
    getRunning: () => [{ name: 'svc', pid: 10, level: 0 }],
    getForestPids: async () => { throw new Error('ps timed out'); },
    sampleProcesses: async () => []
  });
  assert.equal(await collector.sampleOnce(), null);
  const summary = collector.summary();
  assert.equal(summary.errors, 1);
  assert.equal(summary.lastError, 'ps timed out');
});

test('METRICS: ps TIME parsing and platform support table', () => {
  assert.equal(processes.parsePsTime('0:01.50'), 1500);
  assert.equal(processes.parsePsTime('01:02:03'), 3723000);
  assert.equal(processes.parsePsTime('1-00:00:01'), 86401000);
  const support = processes.samplerSupport();
  assert.equal(support.platform, process.platform);
  assert.equal(typeof support.cpu, 'boolean');
});

test('METRICS: real sample of this test process (Linux/macOS/Windows sampler)', { skip: !['linux', 'darwin', 'win32'].includes(process.platform) }, async () => {
  const [self] = await processes.sampleProcesses([process.pid]);
  assert.equal(self.pid, process.pid);
  assert.ok(self.rssBytes > 1024 * 1024, 'a Node process holds more than 1 MB');
  assert.ok(self.cpuMs >= 0);
  if (process.platform === 'linux') assert.ok(self.voluntaryCtx >= 0);
  else assert.equal(self.voluntaryCtx, null);
  const forest = await processes.getForestPids([process.pid]);
  assert.deepEqual(forest.get(process.pid).slice(0, 1), [process.pid]);
});
