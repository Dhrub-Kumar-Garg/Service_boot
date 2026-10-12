const { flatten } = require('../graph/topo');
const { launch } = require('./recovery');
const { EngineError } = require('./errors');

function checkAborted(ctx, serviceName) {
  if (ctx.aborted) {
    throw new EngineError('startup aborted', { reason: 'aborted', serviceName });
  }
}

async function startOne(service, ctx) {
  try {
    checkAborted(ctx, service.name);
    await launch(service, ctx);
  } catch (error) {
    if (error.reason === 'aborted') throw error;
    // Several processes can fail in the same level. Claim the first failure
    // before notifying listeners or canceling peers; later failures are silent.
    checkAborted(ctx, service.name);
    const failure = error instanceof EngineError ? error : new EngineError(error.message, {
      reason: error.reason || 'spawn', serviceName: service.name
    });
    ctx.abort(failure);
    ctx.emit('service:failed', {
      name: service.name, reason: failure.reason, error: failure.message
    });
    throw failure;
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
        await startOne(services[name], ctx);
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
