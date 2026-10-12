const processes = require('./process-manager');
const readiness = require('./readiness');
const { EngineError } = require('./errors');

function checkAborted(ctx, serviceName) {
  if (ctx.aborted) throw new EngineError('startup aborted', { reason: 'aborted', serviceName });
}

const failedExit = exit => exit.code !== 0 || exit.signal !== null;

function crash(handle, exit) {
  const tail = handle.tail.slice(-5).join('\n');
  return new EngineError(`exited with code ${exit.code} after becoming ready${tail ? `\n${tail}` : ''}`, {
    reason: 'crash', serviceName: handle.name
  });
}

async function retry(service, ctx, state, handle, exit) {
  checkAborted(ctx, service.name);
  const maxRetries = service.maxRetries ?? 3;
  if (state.attempt >= maxRetries) throw crash(handle, exit);
  const attempt = ++state.attempt;
  // An exited shell can still own descendants and an open port. Remove the old
  // process group before replacing it; preflight is only for the initial start.
  await processes.terminate(handle, { graceMs: 1000 });
  checkAborted(ctx, service.name);
  ctx.emit('service:restarting', { name: service.name, attempt, maxRetries,
    code: exit.code, signal: exit.signal });
  await new Promise((resolve, reject) => {
    const signal = ctx.abortController.signal;
    let timer;
    function finish(error) {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    }
    const onAbort = () => finish(new EngineError('restart aborted', {
      reason: 'aborted', serviceName: service.name
    }));
    // Backoff avoids a tight crash/spawn loop. Abort wakes it immediately.
    timer = setTimeout(() => finish(), 500 * attempt);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function watch(service, ctx, state, handle) {
  if (service.restart !== 'on-failure') return;
  ctx.supervised = true;
  // This promise fires once per process. Recovery tasks are tracked only while
  // retrying, so stopAll can drain them without waiting for healthy exits first.
  void handle.exited.then(exit => {
    if (ctx.aborted || handle.stopping || state.handle !== handle || !failedExit(exit)) return;
    const operation = recover(service, ctx, state, handle, exit);
    ctx.recoveries.add(operation);
    void operation.then(() => ctx.recoveries.delete(operation), error => {
      ctx.recoveries.delete(operation);
      if (!ctx.aborted) ctx.emit('service:failed', {
        name: service.name, reason: 'crash', error: error.message
      });
    });
  });
}

async function recover(service, ctx, state, handle, exit) {
  try {
    await retry(service, ctx, state, handle, exit);
    await launch(service, ctx, { preflight: false });
  } catch (error) {
    if (ctx.aborted || error.reason === 'aborted') return;
    try { await processes.terminate(state.handle, { graceMs: 1000 }); } catch (cleanupError) {
      error.cleanupError = cleanupError;
    }
    // A failed replacement leaves this service down. Siblings and dependents
    // retain their processes; this is not a terminal startup failure of the run.
    if (!ctx.aborted) ctx.emit('service:failed', {
      name: service.name, reason: error.reason || 'crash', error: error.message
    });
  }
}

async function launch(service, ctx, { preflight = true } = {}) {
  checkAborted(ctx, service.name);
  if (!ctx.states.has(service.name)) ctx.states.set(service.name, { attempt: 0, handle: null });
  const state = ctx.states.get(service.name);
  if (preflight) {
    await readiness.preflightPort(service);
    checkAborted(ctx, service.name);
  }
  for (;;) {
    checkAborted(ctx, service.name);
    const handle = await processes.spawnService(service, {
      level: ctx.levels.get(service.name), emit: ctx.emit
    });
    state.handle = handle;
    let ms;
    try {
      ms = await readiness.waitForReady(service, { handle, signal: ctx.abortController.signal });
    } catch (error) {
      checkAborted(ctx, service.name);
      if (error.reason !== 'crash' || service.restart !== 'on-failure' ||
          state.attempt >= (service.maxRetries ?? 3)) throw error;
      const exit = await handle.exited;
      if (!failedExit(exit) || handle.stopping) throw error;
      await retry(service, ctx, state, handle, exit);
      continue;
    }
    checkAborted(ctx, service.name);
    ctx.emit('service:ready', { name: service.name, pid: handle.pid, ms });
    ctx.readyMs[service.name] = ms;
    ctx.pids[service.name] = handle.pid;
    watch(service, ctx, state, handle);
    return handle;
  }
}

module.exports = { launch };
