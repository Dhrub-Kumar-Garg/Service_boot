// Person 3: serial benchmark of the three startup algorithms.
//
// Method (see docs/REPORT.md, "Benchmark method"):
// - Same machine, same configs, one run at a time. Never two runs at once:
//   they would fight over the same ports and CPU and corrupt each other.
// - Round-robin order: round 1 runs every (config, algorithm) pair, then
//   round 2, ... so slow drift (thermal, background load) affects all
//   algorithms alike instead of biasing whichever ran last.
// - startupMs is the engine's own measurement (run:start -> every service
//   ready). Shutdown and whole-run wall time are recorded separately.
// - stopAll() is ALWAYS awaited in finally between runs, and the metrics
//   collector is drained, so no process or timer leaks into the next run.
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { loadPlan } = require('../plan');
const engine = require('../engine');
const processes = require('../engine/process-manager');
const { createCollector } = require('../metrics/collector');

const SCHEMA_VERSION = 1;
const ALGORITHMS = ['sequential', 'parallel', 'adaptive'];

function describe(values) {
  const known = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!known.length) return null;
  const sorted = [...known].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  // Sample standard deviation (n - 1): spread between repeated runs.
  const stdev = n > 1 ? Math.sqrt(sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean, median, min: sorted[0], max: sorted[n - 1], stdev };
}

function environment() {
  const cpus = os.cpus();
  return {
    platform: process.platform, osRelease: os.release(), arch: process.arch,
    cpuModel: cpus[0]?.model ?? null, logicalCpus: cpus.length,
    totalMemoryBytes: os.totalmem(), node: process.version
  };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runOnce({ configPath, algorithm, maxParallel, sampleMs, metrics, round, onEvent, isCancelled }) {
  const plan = loadPlan(configPath);
  const emitter = new EventEmitter();
  const counts = {};
  let restarts = 0;
  for (const event of ['run:start', 'adaptive:decision', 'service:starting', 'service:ready',
    'service:failed', 'service:exited', 'service:restarting', 'run:done', 'run:failed', 'service:log']) {
    emitter.on(event, payload => {
      counts[event] = (counts[event] || 0) + 1;
      if (event === 'service:restarting') restarts++;
      if (onEvent) onEvent(event, payload);
    });
  }
  let decision = null;
  emitter.on('adaptive:decision', payload => { decision = { width: payload.width, depth: payload.depth, chosen: payload.chosen }; });

  const collector = metrics ? createCollector({ intervalMs: sampleMs }) : null;
  const wallStart = performance.now();
  const run = { config: configPath, round, algorithm, effectiveAlgorithm: null, outcome: 'ok', error: null,
    startupMs: null, readyMs: null, shutdownMs: null, wallMs: null, restarts: 0, adaptiveDecision: null,
    eventCounts: counts, metrics: null };
  try {
    if (isCancelled()) throw Object.assign(new Error('benchmark cancelled'), { cancelled: true });
    if (collector) collector.start();
    const result = await engine.runEngine({ services: plan.services, groups: plan.groups, algorithm, maxParallel, emitter });
    run.effectiveAlgorithm = result.effectiveAlgorithm;
    run.startupMs = result.totalMs;
    run.readyMs = { ...result.readyMs };
  } catch (error) {
    run.outcome = error.cancelled || error.reason === 'aborted' ? 'cancelled' : 'failed';
    run.error = error.message;
  } finally {
    // Stop the sampler first (one last sample = state at "all ready"), then
    // stop services. Shutdown time is measured on its own.
    if (collector) run.metrics = await collector.stop({ finalSample: run.outcome === 'ok' });
    const shutdownStart = performance.now();
    try {
      await engine.stopAll();
    } catch (error) {
      run.outcome = 'failed';
      run.error = `${run.error ? `${run.error}; ` : ''}cleanup: ${error.message}`;
    }
    run.shutdownMs = performance.now() - shutdownStart;
    run.wallMs = performance.now() - wallStart;
    run.restarts = restarts;
    run.adaptiveDecision = decision;
    emitter.removeAllListeners();
  }
  return run;
}

function summarize(runs, configs, algorithms) {
  const summary = [];
  for (const config of configs) {
    for (const algorithm of algorithms) {
      const all = runs.filter(run => run.config === config && run.algorithm === algorithm);
      const ok = all.filter(run => run.outcome === 'ok');
      const services = ok.length ? Object.keys(ok[0].readyMs) : [];
      const perService = {};
      for (const name of services) perService[name] = describe(ok.map(run => run.readyMs[name]));
      const metric = pick => describe(ok.map(run => run.metrics ? pick(run.metrics) : null));
      summary.push({
        config, algorithm,
        effectiveAlgorithms: [...new Set(ok.map(run => run.effectiveAlgorithm))],
        runs: all.length, successful: ok.length,
        failed: all.filter(run => run.outcome === 'failed').length,
        // Only successful runs are timing samples; failures are counted, not averaged.
        startupMs: describe(ok.map(run => run.startupMs)),
        shutdownMs: describe(ok.map(run => run.shutdownMs)),
        perServiceReadyMs: perService,
        peakRssBytes: metric(m => m.memory?.peakRssBytes ?? null),
        meanCpuPercent: metric(m => m.cpu?.meanPercent ?? null),
        peakCpuPercent: metric(m => m.cpu?.peakPercent ?? null),
        orchestratorPeakRssBytes: metric(m => m.orchestrator?.peakRssBytes ?? null),
        voluntaryContextSwitches: metric(m => m.contextSwitches?.available ? m.contextSwitches.voluntary : null),
        involuntaryContextSwitches: metric(m => m.contextSwitches?.available ? m.contextSwitches.involuntary : null)
      });
    }
  }
  return summary;
}

async function runBenchmark({
  configs, algorithms = ALGORITHMS, runs = 3, maxParallel = Infinity, sampleMs = 500,
  metrics = true, cooldownMs = 300, keepSamples = true, command = null,
  onRunStart, onRunEnd, onEvent, isCancelled = () => false
}) {
  if (!Array.isArray(configs) || !configs.length) throw new TypeError('configs must be a non-empty array');
  if (!Number.isInteger(runs) || runs < 1) throw new TypeError('runs must be a positive integer');
  // Validate every config up front so a typo fails before any process starts.
  const plans = configs.map(config => ({ config, plan: loadPlan(config) }));
  const results = [];
  const startedAt = new Date().toISOString();
  const total = runs * configs.length * algorithms.length;
  let index = 0;
  outer:
  for (let round = 1; round <= runs; round++) {
    for (const { config } of plans) {
      for (const algorithm of algorithms) {
        if (isCancelled()) break outer;
        index++;
        if (onRunStart) onRunStart({ index, total, config, algorithm, round });
        const run = await runOnce({ configPath: config, algorithm, maxParallel, sampleMs, metrics, round, onEvent, isCancelled });
        if (run.metrics && !keepSamples) delete run.metrics.samples;
        results.push(run);
        if (onRunEnd) onRunEnd({ index, total, run });
        // Let sockets and the OS settle so one run's teardown does not
        // overlap the next run's startup.
        if (cooldownMs > 0 && index < total && !isCancelled()) await delay(cooldownMs);
      }
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'serviceboot', version: require('../../package.json').version },
    startedAt, finishedAt: new Date().toISOString(),
    command,
    complete: results.length === total,
    environment: environment(),
    settings: {
      runsPerPair: runs, algorithms, maxParallel: maxParallel === Infinity ? null : maxParallel,
      metrics, sampleIntervalMs: metrics ? sampleMs : null, cooldownMs, order: 'round-robin by round, then config, then algorithm'
    },
    metricsSupport: processes.samplerSupport(),
    units: {
      time: 'milliseconds (performance.now, monotonic)',
      memory: 'bytes; sum of resident set size over every process in every service tree (upper bound: shared pages counted per process)',
      cpu: 'percent of ONE core over each sampling interval, summed over service trees (100 = one busy core)',
      contextSwitches: 'count, Linux /proc only; null elsewhere'
    },
    configs: plans.map(({ config, plan }) => ({
      path: config, services: plan.order.length, groups: plan.groups,
      analysis: { depth: plan.analysis.depth, width: plan.analysis.width, chosen: plan.analysis.chosen }
    })),
    runs: results,
    summary: summarize(results, configs, algorithms)
  };
}

module.exports = { runBenchmark, describe, summarize, ALGORITHMS, SCHEMA_VERSION };
