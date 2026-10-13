// Person 3: CPU / memory / context-switch collector for running service trees.
//
// OS concepts used here:
// - A service's recorded PID is its shell / process-group leader. The real work
//   happens in its descendants, so every sample walks the whole process TREE
//   (parent-PID links from one process-table snapshot) and sums the members.
// - CPU time is cumulative per process (user + kernel time). CPU% over an
//   interval = (sum of per-process CPU-time deltas) / (wall-clock delta) * 100,
//   so 100% means one fully busy core and N cores can reach N * 100%.
// - Resident set size (RSS) is the physical memory a process currently holds.
//   Summing RSS over processes over-counts pages they share (e.g. the Node
//   binary), so the total is an upper bound, not an exact footprint.
// - Context-switch counters are monotonic per process; they are only read
//   where the OS exposes them (Linux /proc). Elsewhere they are null with a
//   reason, never invented zeroes.
// - CPU time of a process that starts AND exits between two samples is not
//   seen at all; very short-lived children are under-counted.
const { performance } = require('node:perf_hooks');
const processes = require('../engine/process-manager');

function createCollector({
  intervalMs = 500,
  getRunning = processes.getRunning,
  getForestPids,
  sampleProcesses,
  sampleForest,
  support = processes.samplerSupport(),
  keepSamples = true
} = {}) {
  // One call per sample returns {forest, stats}. Tests may inject the two
  // halves separately; production uses the single combined OS snapshot.
  const snapshot = sampleForest || (getForestPids || sampleProcesses
    ? async roots => {
      const forest = await (getForestPids || processes.getForestPids)(roots);
      const pids = [...new Set([...forest.values()].flat())];
      return { forest, stats: await (sampleProcesses || processes.sampleProcesses)(pids) };
    }
    : processes.sampleForest);
  if (!Number.isFinite(intervalMs) || intervalMs < 50) throw new TypeError('intervalMs must be >= 50');

  const samples = [];
  const lastCpu = new Map();       // pid -> cumulative cpuMs at previous sample
  const ctxByPid = new Map();      // pid -> {voluntary, involuntary} latest values
  const seenPids = new Set();
  let lastAt = null;
  let lastOrchestrator = null;
  let timer = null;
  let inFlight = null;
  let running = false;
  let errors = 0;
  let lastError = null;
  let startedAt = null;

  async function sampleOnce() {
    // Never overlap snapshots: slow `ps`/CIM queries would pile up otherwise.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const at = performance.now();
      const orchestratorCpu = process.cpuUsage();
      const orchestratorRss = process.memoryUsage().rss;
      let services = [];
      try {
        // getRunning() is the live list of leaders; it reflects restarts.
        const leaders = getRunning();
        const { forest, stats } = await snapshot(leaders.map(service => service.pid));
        const byPid = new Map(stats.map(stat => [stat.pid, stat]));
        let cpuDeltaMs = 0;
        let rssBytes = 0;
        let rssKnown = false;
        for (const stat of stats) {
          seenPids.add(stat.pid);
          if (stat.cpuMs !== null && stat.cpuMs !== undefined) {
            // A PID first seen now contributes all CPU time since its birth,
            // which happened during (or just before) this interval.
            const previous = lastCpu.has(stat.pid) ? lastCpu.get(stat.pid) : 0;
            cpuDeltaMs += Math.max(0, stat.cpuMs - previous);
            lastCpu.set(stat.pid, stat.cpuMs);
          }
          if (stat.rssBytes !== null && stat.rssBytes !== undefined) {
            rssBytes += stat.rssBytes;
            rssKnown = true;
          }
          if (stat.voluntaryCtx !== null && stat.voluntaryCtx !== undefined) {
            ctxByPid.set(stat.pid, { voluntary: stat.voluntaryCtx, involuntary: stat.involuntaryCtx ?? 0 });
          }
        }
        services = leaders.map(leader => {
          const tree = forest.get(leader.pid) || [leader.pid];
          const members = tree.map(pid => byPid.get(pid)).filter(Boolean);
          const rss = members.reduce((sum, stat) => sum + (stat.rssBytes || 0), 0);
          return { name: leader.name, pid: leader.pid, treePids: members.length, rssBytes: members.length ? rss : null };
        });
        const elapsed = lastAt === null ? null : at - lastAt;
        const orchestratorCpuMs = lastOrchestrator === null ? null
          : ((orchestratorCpu.user - lastOrchestrator.user) + (orchestratorCpu.system - lastOrchestrator.system)) / 1000;
        const sample = {
          t: startedAt === null ? 0 : at - startedAt,
          services: services.length,
          pids: stats.length,
          // The first sample has no previous point, so no interval CPU%.
          cpuPercent: support.cpu && elapsed ? (cpuDeltaMs / elapsed) * 100 : null,
          rssBytes: support.memory && rssKnown ? rssBytes : (support.memory && stats.length === 0 ? 0 : null),
          orchestratorRssBytes: orchestratorRss,
          orchestratorCpuPercent: elapsed && orchestratorCpuMs !== null ? (orchestratorCpuMs / elapsed) * 100 : null,
          perService: services
        };
        if (keepSamples) samples.push(sample);
        lastAt = at;
        lastOrchestrator = orchestratorCpu;
        return sample;
      } catch (error) {
        // A failed snapshot (e.g. a timed-out PowerShell query) is counted and
        // reported, but must not crash the run being measured.
        errors++;
        lastError = error.message;
        return null;
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  function schedule() {
    if (!running) return;
    // setTimeout after completion (not setInterval) guarantees no overlap.
    timer = setTimeout(async () => {
      timer = null;
      await sampleOnce();
      schedule();
    }, intervalMs);
  }

  function start() {
    if (running) throw new Error('collector already started');
    running = true;
    startedAt = performance.now();
    void sampleOnce().then(schedule);
  }

  async function stop({ finalSample = true } = {}) {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
    // Drain a query that is still in flight so no child process outlives us.
    if (inFlight) await inFlight;
    if (finalSample) await sampleOnce();
    return summary();
  }

  function stats(values) {
    const known = values.filter(value => typeof value === 'number' && Number.isFinite(value));
    if (!known.length) return null;
    return { mean: known.reduce((a, b) => a + b, 0) / known.length, max: Math.max(...known), samples: known.length };
  }

  function summary() {
    const cpu = stats(samples.map(sample => sample.cpuPercent));
    const rss = stats(samples.map(sample => sample.rssBytes));
    const orchestratorRss = stats(samples.map(sample => sample.orchestratorRssBytes));
    const orchestratorCpu = stats(samples.map(sample => sample.orchestratorCpuPercent));
    let contextSwitches;
    if (!support.contextSwitches) {
      contextSwitches = { available: false, reason: `not exposed by this collector on ${support.platform}`, voluntary: null, involuntary: null };
    } else if (!ctxByPid.size) {
      contextSwitches = { available: false, reason: 'no service process was sampled', voluntary: null, involuntary: null };
    } else {
      let voluntary = 0;
      let involuntary = 0;
      for (const value of ctxByPid.values()) { voluntary += value.voluntary; involuntary += value.involuntary; }
      contextSwitches = {
        available: true,
        reason: 'sum of the last observed counters of every sampled service process; processes that exited between samples are counted up to their last sample',
        voluntary, involuntary, processes: ctxByPid.size
      };
    }
    return {
      intervalMs,
      source: support.source,
      platform: support.platform,
      sampleCount: samples.length,
      errors, lastError,
      processesSeen: seenPids.size,
      cpu: support.cpu ? { available: !!cpu, meanPercent: cpu?.mean ?? null, peakPercent: cpu?.max ?? null, samples: cpu?.samples ?? 0 }
        : { available: false, reason: `unsupported on ${support.platform}` },
      memory: support.memory ? { available: !!rss, peakRssBytes: rss?.max ?? null, meanRssBytes: rss?.mean ?? null }
        : { available: false, reason: `unsupported on ${support.platform}` },
      orchestrator: {
        peakRssBytes: orchestratorRss?.max ?? null,
        meanCpuPercent: orchestratorCpu?.mean ?? null
      },
      contextSwitches,
      samples: keepSamples ? samples : undefined
    };
  }

  return { start, stop, sampleOnce, summary };
}

module.exports = { createCollector };
