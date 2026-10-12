const { terminate, getRunning, getManagedHandles } = require('./process-manager');

const MESSAGE = 'NOT IMPLEMENTED: Person 2 implements this (see CONTRACT.md section 5)';

async function runEngine() {
  throw new Error(MESSAGE);
}

async function stopAll({ graceMs = 3000 } = {}) {
  // Phase 1 stops independent processes concurrently. A later scheduling phase
  // will cancel startup and stop dependency levels in reverse order.
  const results = await Promise.allSettled(
    getManagedHandles().map(handle => terminate(handle, { graceMs }))
  );
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
}

module.exports = { runEngine, stopAll, getRunning };
