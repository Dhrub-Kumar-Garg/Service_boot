const { performance } = require('node:perf_hooks');

function createEmit(emitter) {
  return (name, payload) => {
    // A monotonic clock measures elapsed time without wall-clock adjustments.
    try {
      emitter.emit(name, { ...payload, ts: performance.now() });
    } catch (error) {
      // EventEmitter calls listeners synchronously. A UI exception must not
      // interrupt process bookkeeping or shutdown in the engine.
      console.error(`ServiceBoot listener error (${name}):`, error);
    }
  };
}

module.exports = { createEmit };
