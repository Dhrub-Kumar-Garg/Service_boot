const { parseArgs } = require('node:util');
const { EventEmitter } = require('node:events');
const { ConfigError } = require('../config/errors');
const { loadPlan } = require('../plan');
const engine = require('../engine');
const processes = require('../engine/process-manager');
const pidfile = require('../engine/pidfile');
const { down } = require('../engine/down');
const path = require('node:path');

const USAGE = `Usage:
  serviceboot plan [--config FILE] [--json]
  serviceboot up [--config FILE] [--algorithm sequential|parallel|adaptive]
                 [--max-parallel N] [--exit-after-ready]
  serviceboot down
  serviceboot --help

Default config: ./serviceboot.yml. Default algorithm: adaptive.`;

const EVENTS = [
  'run:start', 'adaptive:decision', 'service:starting', 'service:log',
  'service:ready', 'service:failed', 'service:exited', 'service:restarting', 'run:done', 'run:failed'
];

function formatEvent(event, payload = {}) {
  const parts = [event];
  if (payload.name !== undefined) parts.push(String(payload.name));
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'name') continue;
    const text = value instanceof Error ? value.message
      : typeof value === 'object' ? JSON.stringify(value) : String(value);
    // A log line or error may contain newlines; each event still gets one line.
    parts.push(`${key}=${text.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`);
  }
  return parts.join(' ');
}

async function runUp(plan, options) {
  const previous = pidfile.read();
  if (previous && processes.isPidAlive(previous.cliPid)) {
    throw new Error(`ServiceBoot is already running (pid ${previous.cliPid}). Run "serviceboot down" first.`);
  }
  if (previous) {
    console.error(`warning: stale ServiceBoot pid file (pid ${previous.cliPid}); cleaning recorded leftovers and continuing`);
    await down();
  }
  pidfile.write({ config: options.config });
  const emitter = new EventEmitter();

  let stopping = false;
  let signalCode;
  let fatal = false;
  emitter.on('service:starting', payload => {
    try { pidfile.addService(payload); } catch (error) { onFatal(error); }
  });
  for (const event of EVENTS) emitter.on(event, payload => {
    // Cancellation during a signal shutdown is expected, not a startup failure.
    if (event === 'run:failed' && signalCode !== undefined) return;
    console.log(formatEvent(event, payload));
  });
  let finishShutdown;
  const shutdown = new Promise(resolve => { finishShutdown = resolve; });
  async function stop(code) {
    if (stopping) return;
    stopping = true;
    try {
      await engine.stopAll({});
      pidfile.remove({ cliPid: process.pid });
      finishShutdown(fatal ? 3 : signalCode ?? code);
    } catch (error) {
      console.error(`error: ${error.message}`);
      processes.killAllSync();
      try {
        const record = pidfile.read();
        if (record?.cliPid === process.pid && record.services.every(service => !processes.isGroupAlive(service.pid))) {
          pidfile.remove({ cliPid: process.pid });
        }
      } catch (fileError) { console.error(`error: ${fileError.message}`); }
      finishShutdown(3);
    }
    // An uncaught error can leave unrelated handles alive. After best-effort
    // service cleanup, exit rather than resuming a damaged process.
    if (fatal) process.exit(3);
  }

  function onSignal(code) {
    if (signalCode !== undefined) {
      // A second interrupt skips asynchronous grace periods. Kill every owned
      // process tree synchronously before exiting with the first signal's code.
      processes.killAllSync();
      try { pidfile.remove({ cliPid: process.pid }); } catch (error) { console.error(`error: ${error.message}`); }
      process.exit(signalCode);
      return;
    }
    signalCode = code;
    void stop(code);
  }
  function onFatal(error) {
    // In strict rejection mode Node may report the same rejected promise via
    // both fatal events. One shutdown and one diagnostic are enough.
    if (fatal) return;
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    fatal = true;
    void stop(3);
  }
  const onInterrupt = () => onSignal(130);
  const onTerminate = () => onSignal(143);
  process.on('SIGINT', onInterrupt);
  // Windows does not deliver SIGTERM as a console signal; Ctrl+C delivers
  // SIGINT. Register SIGTERM too for POSIX and programmatic signal tests.
  process.on('SIGTERM', onTerminate);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  // EventEmitters alone do not keep Node alive after services become ready.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    // Shutdown may happen during readiness checks. Race it with startup, and
    // handle later engine rejection too so cancellation is never unhandled.
    const startup = Promise.resolve().then(() => stopping ? undefined : engine.runEngine({
      services: plan.services, groups: plan.groups,
      algorithm: options.algorithm, maxParallel: options.maxParallel, emitter
    })).then(result => ({ result }), error => ({ error }));
    const outcome = await Promise.race([startup, shutdown.then(code => ({ code }))]);
    if (outcome.code !== undefined) return outcome.code;
    if (stopping) return await shutdown;
    if (outcome.error) {
      if (!outcome.error.cleanupError) pidfile.remove({ cliPid: process.pid });
      console.error(`error: ${outcome.error.message}`);
      return 3;
    }

    const result = outcome.result;
    console.log(`Ready: ${plan.order.length} services (algorithm=${result.algorithm}, effectiveAlgorithm=${result.effectiveAlgorithm}, totalMs=${result.totalMs})`);
    if (options.exitAfterReady) void stop(0);
    return await shutdown;
  } finally {
    clearInterval(keepAlive);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onFatal);
    emitter.removeAllListeners();
  }
}

async function main(argv) {
  let values;
  let command;
  let maxParallel = Infinity;
  try {
    const parsed = parseArgs({
      args: argv, strict: true, allowPositionals: true,
      options: {
        config: { type: 'string' }, json: { type: 'boolean' },
        algorithm: { type: 'string' }, 'max-parallel': { type: 'string' },
        'exit-after-ready': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
      }
    });
    values = parsed.values;
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    command = parsed.positionals[0];
    if (parsed.positionals.length !== 1 || !['plan', 'up', 'down'].includes(command)) {
      throw new Error('Expected exactly one command: plan, up or down');
    }
    const allowed = command === 'plan' ? ['config', 'json']
      : command === 'down' ? [] : ['config', 'algorithm', 'max-parallel', 'exit-after-ready'];
    for (const key of Object.keys(values)) {
      if (!allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
    }
    if (values.config !== undefined && !values.config.trim()) throw new Error('--config must not be empty');
    if (values.algorithm !== undefined && !['sequential', 'parallel', 'adaptive'].includes(values.algorithm)) {
      throw new Error('--algorithm must be sequential, parallel, or adaptive');
    }
    if (values['max-parallel'] !== undefined) {
      maxParallel = Number(values['max-parallel']);
      if (!/^\d+$/.test(values['max-parallel']) || !Number.isSafeInteger(maxParallel) || maxParallel <= 0) {
        throw new Error('--max-parallel must be a positive integer');
      }
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.log(USAGE);
    return 2;
  }

  const configPath = values.config === undefined ? './serviceboot.yml' : values.config;
  try {
    if (command === 'down') {
      console.log(await down() ? 'ServiceBoot stopped' : 'Nothing to stop');
      return 0;
    }
    const plan = loadPlan(configPath);
    if (command === 'plan') {
      if (values.json) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log(`Config: ${configPath}  (${plan.order.length} services)`);
        console.log('Start order (levels):');
        plan.groups.forEach((group, level) => console.log(`  Level ${level}: ${group.join(', ')}`));
        console.log(`Graph analysis: depth=${plan.analysis.depth} width=${plan.analysis.width}`);
        console.log(`Adaptive decision: ${plan.analysis.chosen.toUpperCase()}`);
        console.log(plan.analysis.reason);
      }
      return 0;
    }
    return await runUp(plan, {
      algorithm: values.algorithm === undefined ? 'adaptive' : values.algorithm,
      maxParallel, exitAfterReady: Boolean(values['exit-after-ready']), config: path.resolve(configPath)
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.errors) console.error(`error: ${problem}`);
      return 1;
    }
    console.error(`error: ${error.message}`);
    return 3;
  }
}

module.exports = { main };
