const processes = require('./process-manager');
const { getRunning } = processes;
const { EventEmitter, setMaxListeners } = require('node:events');
const { performance } = require('node:perf_hooks');
const { createEmit } = require('./events');
const { EngineError } = require('./errors');
const { runSequential, runParallel } = require('./runners');
const { analyze } = require('../graph/adaptive');

let activeContext = null;
let shutdownOperation = null;

function validate(services, groups, algorithm, maxParallel, emitter) {
  if (!['sequential', 'parallel', 'adaptive'].includes(algorithm)) {
    throw new TypeError('algorithm must be sequential, parallel, or adaptive');
  }
  if (maxParallel !== Infinity && (!Number.isInteger(maxParallel) || maxParallel <= 0)) {
    throw new TypeError('maxParallel must be a positive integer or Infinity');
  }
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new TypeError('services must be an object');
  }
  if (!Array.isArray(groups) || !groups.every(Array.isArray)) {
    throw new TypeError('groups must be an array of levels');
  }
  const names = new Set();
  for (const group of groups) {
    for (const name of group) {
      if (typeof name !== 'string' || !Object.hasOwn(services, name)) {
        throw new TypeError(`Unknown service in groups: ${String(name)}`);
      }
      if (names.has(name)) throw new TypeError(`Duplicate service in groups: ${name}`);
      names.add(name);
    }
  }
  if (!emitter || typeof emitter.emit !== 'function') {
    throw new TypeError('emitter must expose an emit function');
  }
}

async function runEngine({ services, groups, algorithm, maxParallel = Infinity,
  emitter = new EventEmitter() } = {}) {
  // Validate the complete plan before spawning anything, including names in
  // later levels. A rejected caller must not disturb an existing running plan.
  validate(services, groups, algorithm, maxParallel, emitter);
  if (activeContext || shutdownOperation || getRunning().length > 0) {
    throw new Error('Engine already running; call stopAll() first');
  }

  let finishStarting;
  const ctx = {
    aborted: false, failure: null, abortController: new AbortController(),
    emit: createEmit(emitter),
    // Null-prototype maps safely support service names such as __proto__.
    readyMs: Object.create(null), pids: Object.create(null),
    levels: new Map(groups.flatMap((group, level) => group.map(name => [name, level]))),
    startingDone: new Promise(resolve => { finishStarting = resolve; }),
    abort(error) {
      if (!this.failure) this.failure = error;
      this.aborted = true;
      this.abortController.abort();
    }
  };
  // Parallel services legitimately share this run's cancellation signal.
  // Each readiness wait removes its listener; the default limit of ten would
  // otherwise warn on a wide level even though no listeners are leaked.
  setMaxListeners(0, ctx.abortController.signal);
  activeContext = ctx;

  try {
    ctx.emit('run:start', { algorithm, total: Object.keys(services).length });
    const started = performance.now();
    let effectiveAlgorithm = algorithm;
    try {
      if (algorithm === 'adaptive') {
        const { width, depth, chosen, reason } = analyze(groups);
        effectiveAlgorithm = chosen;
        ctx.emit('adaptive:decision', { width, depth, chosen, reason });
      }
      if (effectiveAlgorithm === 'sequential') await runSequential(services, groups, ctx);
      else await runParallel(services, groups, maxParallel, ctx);
      if (ctx.aborted) throw ctx.failure;
    } finally {
      // Shutdown waits for worker drainage, not the entire runEngine promise:
      // that promise itself must await shutdown before rejecting a failure.
      finishStarting();
    }
    const result = {
      algorithm, effectiveAlgorithm,
      totalMs: performance.now() - started, readyMs: ctx.readyMs, pids: ctx.pids
    };
    ctx.emit('run:done', {
      algorithm, effectiveAlgorithm: result.effectiveAlgorithm, totalMs: result.totalMs
    });
    return result;
  } catch (error) {
    ctx.abort(error);
    const failure = ctx.failure;
    try {
      await stopAll({ graceMs: 1000 });
    } catch (cleanupError) {
      // Preserve the original startup failure and expose a cleanup failure too.
      failure.cleanupError = cleanupError;
    }
    ctx.emit('run:failed', { error: failure.message });
    throw failure;
  } finally {
    if (activeContext === ctx) activeContext = null;
  }
}

function stopAll({ graceMs = 3000 } = {}) {
  if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 2147483647) {
    return Promise.reject(new TypeError('graceMs must be a finite non-negative timer duration'));
  }
  if (shutdownOperation) return shutdownOperation;
  const ctx = activeContext;

  // Publish the shared promise before abort listeners can call stopAll again.
  // An async function wrapper would return a different promise to each caller.
  shutdownOperation = Promise.resolve().then(async () => {
    if (ctx) await ctx.startingDone;
    // Include spawned services still checking readiness and owned groups whose
    // shell already exited. The startup barrier prevents a late spawn escaping.
    const byLevel = new Map();
    for (const handle of processes.getManagedHandles()) {
      if (!byLevel.has(handle.level)) byLevel.set(handle.level, []);
      byLevel.get(handle.level).push(handle);
    }
    const levels = [...byLevel.keys()].sort((a, b) => b - a);
    let failure;
    for (const level of levels) {
      // Dependents stop before dependencies. Peers on a level can stop together,
      // but all their OS exits must complete before the next shallower level.
      await Promise.all(byLevel.get(level).map(async handle => {
        try {
          await processes.terminate(handle, { graceMs });
        } catch (error) {
          // Still drain this level and attempt the other levels if one OS kill
          // fails. Reject only after every owned process has been attempted.
          if (!failure) failure = error;
        }
      }));
    }
    if (activeContext === ctx) activeContext = null;
    if (failure) throw failure;
  }).finally(() => { shutdownOperation = null; });
  if (ctx) ctx.abort(new EngineError('startup aborted', { reason: 'aborted' }));
  return shutdownOperation;
}

module.exports = { runEngine, stopAll, getRunning };
