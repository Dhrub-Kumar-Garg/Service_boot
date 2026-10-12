const { flatten } = require('../graph/topo');
const processes = require('./process-manager');
const readiness = require('./readiness');
const { EngineError } = require('./errors');

function checkAborted(ctx, serviceName) {
  if (ctx.aborted) {
    throw new EngineError('startup aborted', { reason: 'aborted', serviceName });
  }
}

async function startOne(service, ctx) {
  try {
    checkAborted(ctx, service.name);
    await readiness.preflightPort(service);
    // Another worker can fail while this port check is awaiting the OS.
    checkAborted(ctx, service.name);
    const handle = await processes.spawnService(service, {
      level: ctx.levels.get(service.name), emit: ctx.emit
    });
    const ms = await readiness.waitForReady(service, {
      handle, signal: ctx.abortController.signal
    });
    // none readiness returns immediately even for an aborted signal. Do not
    // announce readiness or start more work after shutdown has begun.
    checkAborted(ctx, service.name);
    ctx.emit('service:ready', { name: service.name, pid: handle.pid, ms });
    ctx.readyMs[service.name] = ms;
    ctx.pids[service.name] = handle.pid;
  } catch (error) {
    if (error.reason !== 'aborted') {
      ctx.emit('service:failed', {
        name: service.name, reason: error.reason || 'spawn', error: error.message
      });
    }
    throw error;
  }
}

async function runSequential(services, groups, ctx) {
  // Sequential scheduling permits one startup at a time: the next process
  // receives CPU time only after its predecessor has reported readiness.
  for (const name of flatten(groups)) {
    checkAborted(ctx, name);
    await startOne(services[name], ctx);
  }
}

async function runParallel(services, groups, maxParallel, ctx) {
  for (const group of groups) {
    checkAborted(ctx);
    let next = 0;
    const workerCount = Math.min(maxParallel, group.length);
    async function worker() {
      // A worker holds one startup slot through readiness, not merely spawn.
      // Ready services keep running without occupying a worker slot.
      while (!ctx.aborted && next < group.length) {
        const name = group[next++];
        try {
          await startOne(services[name], ctx);
        } catch (error) {
          ctx.abort(error);
          throw error;
        }
      }
    }
    // This level barrier drains ALL workers on failure as well as success.
    // A plain Promise.all could reject while peers still finish spawning,
    // racing cleanup and leaving later rejections without an observer.
    const results = await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker())
    );
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw ctx.failure || failure.reason;
    checkAborted(ctx);
  }
}

module.exports = { startOne, runSequential, runParallel };
