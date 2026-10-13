const { parseArgs } = require('node:util');
const { EventEmitter } = require('node:events');
const { ConfigError } = require('../config/errors');
const { loadPlan } = require('../plan');
const engine = require('../engine');
const processes = require('../engine/process-manager');
const pidfile = require('../engine/pidfile');
const { down } = require('../engine/down');
const path = require('node:path');
const fs = require('node:fs');
const { createRenderer } = require('./ui');
const { runBenchmark, ALGORITHMS } = require('../benchmark');

const USAGE = `Usage:
  serviceboot plan [--config FILE] [--json]
  serviceboot up [--config FILE] [--algorithm sequential|parallel|adaptive]
                 [--max-parallel N] [--exit-after-ready]
                 [--plain] [--quiet] [--no-color]
  serviceboot down
  serviceboot benchmark [--config FILE]... [--runs N] [--algorithms LIST]
                 [--max-parallel N] [--out FILE] [--sample-ms N] [--no-metrics]
  serviceboot --help

Commands:
  plan       Validate the config and print dependency levels and the adaptive decision.
  up         Start every service in dependency order and keep them running.
  down       Stop the run recorded in ./.serviceboot (same folder as up).
  benchmark  Run each algorithm on each config, serially, and write results JSON.

Options:
  --config FILE        Config file (default ./serviceboot.yml). benchmark accepts it
                       several times; default samples/small.yml, linear.yml, wide.yml.
  --algorithm NAME     sequential | parallel | adaptive (default adaptive).
  --max-parallel N     At most N services starting (not yet ready) at once per level.
  --exit-after-ready   Measure startup, then stop everything and exit.
  --plain              Machine-readable 'event key=value' lines even on a terminal.
  --quiet              Hide service stdout/stderr lines in terminal output.
  --no-color           No colours or spinner (the NO_COLOR variable does the same).
  --runs N             Repetitions per config and algorithm (default 3).
  --algorithms LIST    Comma-separated subset to benchmark (default all three).
  --out FILE           Benchmark output (default results/results.json).
  --sample-ms N        CPU/memory sampling interval, >= 100 (default 500).
  --no-metrics         Benchmark timings only, without the CPU/memory sampler.
  --json               plan: print the full plan as JSON.

Exit codes: 0 ok, 1 config error, 2 usage error, 3 runtime/engine failure,
130 stopped by Ctrl+C (SIGINT), 143 stopped by SIGTERM (POSIX).`;

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
  // Person 3: presentation lives in ./ui.js. Plain mode prints exactly the
  // Person 2 'event key=value' lines; pretty mode is used on a terminal.
  const ui = createRenderer({ plain: options.plain, noColor: options.noColor, showLogs: !options.quiet });
  ui.header({ config: options.configLabel, plan, algorithm: options.algorithm, maxParallel: options.maxParallel });
  ui.attach(emitter, {
    // Cancellation during a signal shutdown is expected, not a startup failure.
    skip: event => event === 'run:failed' && signalCode !== undefined
  });
  let finishShutdown;
  const shutdown = new Promise(resolve => { finishShutdown = resolve; });
  async function stop(code) {
    if (stopping) return;
    stopping = true;
    ui.stopping();
    try {
      await engine.stopAll({});
      pidfile.remove({ cliPid: process.pid });
      finishShutdown(fatal ? 3 : signalCode ?? code);
    } catch (error) {
      ui.error(`error: ${error.message}`);
      processes.killAllSync();
      try {
        const record = pidfile.read();
        if (record?.cliPid === process.pid && record.services.every(service => !processes.isGroupAlive(service.pid))) {
          pidfile.remove({ cliPid: process.pid });
        }
      } catch (fileError) { ui.error(`error: ${fileError.message}`); }
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
    ui.error(`error: ${error instanceof Error ? error.message : String(error)}`);
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
      ui.error(`error: ${outcome.error.message}`);
      return 3;
    }

    const result = outcome.result;
    ui.ready(result, plan.order.length, { exitAfterReady: options.exitAfterReady });
    if (options.exitAfterReady) void stop(0);
    return await shutdown;
  } finally {
    clearInterval(keepAlive);
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onFatal);
    ui.dispose();
    emitter.removeAllListeners();
  }
}

const DEFAULT_BENCHMARK_CONFIGS = ['samples/small.yml', 'samples/linear.yml', 'samples/wide.yml'];

function positiveInteger(text, option, min = 1) {
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < min) {
    throw new Error(`--${option} must be ${min === 1 ? 'a positive integer' : `an integer >= ${min}`}`);
  }
  return number;
}

function fmtMs(ms) {
  return ms === null || ms === undefined ? 'n/a' : `${ms.toFixed(1)}`;
}
function fmtMb(bytes) {
  return bytes === null || bytes === undefined ? 'n/a' : `${(bytes / 1048576).toFixed(1)}`;
}

// Person 3: `serviceboot benchmark`. Runs are strictly serial and every run
// awaits stopAll() before the next one starts (see src/benchmark/index.js).
async function runBenchmarkCommand(options) {
  const previous = pidfile.read();
  if (previous && processes.isPidAlive(previous.cliPid)) {
    throw new Error(`ServiceBoot is already running (pid ${previous.cliPid}). Run "serviceboot down" first.`);
  }
  if (previous) {
    console.error(`warning: stale ServiceBoot pid file (pid ${previous.cliPid}); cleaning recorded leftovers and continuing`);
    await down();
  }
  // Validate every config before writing anything or starting a process.
  for (const config of options.configs) loadPlan(config);
  const outFile = path.resolve(options.out);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // Record ownership like `up`, so `serviceboot down` can recover services if
  // this benchmark process is hard-killed in the middle of a run.
  pidfile.write({ config: path.resolve(options.configs[0]) });
  let signalCode;
  const onSignal = code => {
    if (signalCode !== undefined) {
      processes.killAllSync();
      try { pidfile.remove({ cliPid: process.pid }); } catch { /* best effort */ }
      process.exit(signalCode);
    }
    signalCode = code;
    console.error('\nStopping benchmark after cleaning up the current run (Ctrl+C again to force)…');
    // Abort the run in progress; runOnce awaits stopAll in its finally block.
    void engine.stopAll().catch(() => {});
  };
  const onInterrupt = () => onSignal(130);
  const onTerminate = () => onSignal(143);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const tty = Boolean(process.stdout.isTTY);
  const total = options.runs * options.configs.length * options.algorithms.length;
  console.log(`Benchmark: ${options.configs.length} config(s) × ${options.algorithms.length} algorithm(s) × ${options.runs} run(s) = ${total} serial runs`);
  console.log(`Metrics: ${options.metrics ? `sampling every ${options.sampleMs} ms` : 'off'}; max-parallel: ${options.maxParallel === Infinity ? 'unlimited' : options.maxParallel}`);
  let results;
  try {
    results = await runBenchmark({
      configs: options.configs, algorithms: options.algorithms, runs: options.runs,
      maxParallel: options.maxParallel, sampleMs: options.sampleMs, metrics: options.metrics,
      command: `serviceboot ${options.argv.join(' ')}`,
      isCancelled: () => signalCode !== undefined,
      onEvent(event, payload) {
        if (event === 'service:starting') {
          try { pidfile.addService(payload); } catch { /* ownership is best effort */ }
        }
      },
      onRunStart({ index, config, algorithm, round }) {
        // Each run starts from a fresh service list in the PID record.
        try { pidfile.write({ config: path.resolve(config) }); } catch { /* best effort */ }
        const text = `[${String(index).padStart(String(total).length)}/${total}] round ${round} ${path.basename(config, '.yml').padEnd(8)} ${algorithm.padEnd(10)}`;
        if (tty) process.stdout.write(`${text} …`); else console.log(text);
      },
      onRunEnd({ run }) {
        const effective = run.algorithm === 'adaptive' && run.effectiveAlgorithm ? ` (→ ${run.effectiveAlgorithm})` : '';
        const peak = run.metrics?.memory?.peakRssBytes;
        const detail = run.outcome === 'ok'
          ? `startup ${fmtMs(run.startupMs)} ms${effective}, shutdown ${fmtMs(run.shutdownMs)} ms${peak ? `, peak RSS ${fmtMb(peak)} MB` : ''}`
          : `${run.outcome.toUpperCase()}: ${run.error}`;
        if (tty) process.stdout.write(`\r\u001b[2K`);
        console.log(`${tty ? '' : '  '}${tty ? `${path.basename(run.config, '.yml').padEnd(8)} ${run.algorithm.padEnd(10)} r${run.round} ` : ''}${detail}`);
      }
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    try { await engine.stopAll(); } catch (error) { console.error(`error: ${error.message}`); }
    pidfile.remove({ cliPid: process.pid });
  }
  fs.writeFileSync(outFile, `${JSON.stringify(results, null, 2)}\n`);

  console.log('');
  console.log('Startup time (ms) over successful runs — mean ± sample stdev [min … max]');
  for (const row of results.summary) {
    const s = row.startupMs;
    const eff = row.algorithm === 'adaptive' ? ` → ${row.effectiveAlgorithms.join('/') || '?'}` : '';
    console.log(`  ${path.basename(row.config, '.yml').padEnd(8)} ${(row.algorithm + eff).padEnd(24)} ${s ? `${fmtMs(s.mean).padStart(8)} ± ${fmtMs(s.stdev).padStart(6)}  [${fmtMs(s.min)} … ${fmtMs(s.max)}]  n=${s.n}` : 'no successful runs'}${row.failed ? `  failed=${row.failed}` : ''}${row.peakRssBytes ? `  peakRSS=${fmtMb(row.peakRssBytes.mean)} MB` : ''}`);
  }
  for (const config of results.configs) {
    const seq = results.summary.find(row => row.config === config.path && row.algorithm === 'sequential')?.startupMs;
    const par = results.summary.find(row => row.config === config.path && row.algorithm === 'parallel')?.startupMs;
    if (seq && par) {
      console.log(`  ${path.basename(config.path, '.yml')}: parallel vs sequential mean startup = ${(seq.mean / par.mean).toFixed(2)}× (${(((seq.mean - par.mean) / seq.mean) * 100).toFixed(1)}% less time)`);
    }
  }
  console.log(`Wrote ${path.relative(process.cwd(), outFile) || outFile}${results.complete ? '' : ' (INCOMPLETE: cancelled)'}`);
  if (signalCode !== undefined) return signalCode;
  return results.runs.some(run => run.outcome === 'failed') ? 3 : 0;
}

async function main(argv) {
  let values;
  let command;
  let maxParallel = Infinity;
  try {
    const parsed = parseArgs({
      args: argv, strict: true, allowPositionals: true,
      options: {
        config: { type: 'string', multiple: true }, json: { type: 'boolean' },
        algorithm: { type: 'string' }, 'max-parallel': { type: 'string' },
        'exit-after-ready': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
        plain: { type: 'boolean' }, quiet: { type: 'boolean' }, 'no-color': { type: 'boolean' },
        runs: { type: 'string' }, algorithms: { type: 'string' }, out: { type: 'string' },
        'sample-ms': { type: 'string' }, 'no-metrics': { type: 'boolean' }
      }
    });
    values = parsed.values;
    if (values.help) {
      console.log(USAGE);
      return 0;
    }
    command = parsed.positionals[0];
    if (parsed.positionals.length !== 1 || !['plan', 'up', 'down', 'benchmark'].includes(command)) {
      throw new Error('Expected exactly one command: plan, up, down or benchmark');
    }
    const allowed = {
      plan: ['config', 'json'],
      down: [],
      up: ['config', 'algorithm', 'max-parallel', 'exit-after-ready', 'plain', 'quiet', 'no-color'],
      benchmark: ['config', 'runs', 'algorithms', 'max-parallel', 'out', 'sample-ms', 'no-metrics']
    }[command];
    for (const key of Object.keys(values)) {
      if (!allowed.includes(key)) throw new Error(`--${key} is not valid for ${command}`);
    }
    if (values.config !== undefined) {
      if (values.config.some(config => !config.trim())) throw new Error('--config must not be empty');
      if (command !== 'benchmark' && values.config.length > 1) throw new Error('--config may be given only once');
    }
    if (values.algorithm !== undefined && !ALGORITHMS.includes(values.algorithm)) {
      throw new Error('--algorithm must be sequential, parallel, or adaptive');
    }
    if (values['max-parallel'] !== undefined) {
      maxParallel = Number(values['max-parallel']);
      if (!/^\d+$/.test(values['max-parallel']) || !Number.isSafeInteger(maxParallel) || maxParallel <= 0) {
        throw new Error('--max-parallel must be a positive integer');
      }
    }
    if (values.runs !== undefined) positiveInteger(values.runs, 'runs');
    if (values['sample-ms'] !== undefined) positiveInteger(values['sample-ms'], 'sample-ms', 100);
    if (values.algorithms !== undefined) {
      const list = values.algorithms.split(',').map(name => name.trim());
      if (!list.length || list.some(name => !ALGORITHMS.includes(name)) || new Set(list).size !== list.length) {
        throw new Error('--algorithms must be a comma-separated list of distinct names from sequential,parallel,adaptive');
      }
    }
    if (values.out !== undefined && !values.out.trim()) throw new Error('--out must not be empty');
  } catch (error) {
    console.error(`error: ${error.message}`);
    console.log(USAGE);
    return 2;
  }

  const configPath = values.config === undefined ? './serviceboot.yml' : values.config[0];
  try {
    if (command === 'down') {
      console.log(await down() ? 'ServiceBoot stopped' : 'Nothing to stop');
      return 0;
    }
    if (command === 'benchmark') {
      return await runBenchmarkCommand({
        argv,
        configs: values.config === undefined ? DEFAULT_BENCHMARK_CONFIGS : values.config,
        runs: values.runs === undefined ? 3 : Number(values.runs),
        algorithms: values.algorithms === undefined ? ALGORITHMS : values.algorithms.split(',').map(name => name.trim()),
        maxParallel,
        out: values.out === undefined ? 'results/results.json' : values.out,
        sampleMs: values['sample-ms'] === undefined ? 500 : Number(values['sample-ms']),
        metrics: !values['no-metrics']
      });
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
      maxParallel, exitAfterReady: Boolean(values['exit-after-ready']), config: path.resolve(configPath),
      configLabel: configPath, plain: Boolean(values.plain), quiet: Boolean(values.quiet),
      noColor: Boolean(values['no-color'])
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
