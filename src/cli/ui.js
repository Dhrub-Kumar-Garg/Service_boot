// Person 3: terminal presentation for `serviceboot up`.
//
// Two modes:
// - plain : one `event key=value ...` line per engine event (Person 2 format).
//           Used whenever stdout is not a terminal (pipes, files, tests, CI)
//           or with --plain, so scripts can parse the output.
// - pretty: human output for an interactive terminal (TTY). Colours and the
//           live spinner line are disabled by NO_COLOR, --no-color or TERM=dumb.
//
// Why output never scrambles in parallel runs: Node runs every event listener
// on one thread, and each line is written with ONE synchronous write call.
// The spinner occupies the last terminal line; before a normal line is printed
// that line is erased (\r + "erase line"), the text is written, and the spinner
// is redrawn underneath it.
const { performance } = require('node:perf_hooks');

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

function chooseMode({ stream = process.stdout, env = process.env, plain = false, noColor = false } = {}) {
  const tty = Boolean(stream && stream.isTTY);
  const pretty = tty && !plain;
  const color = pretty && !noColor && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  return { pretty, color };
}

const CODES = { reset: 0, bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };
const NAME_COLORS = [36, 35, 33, 34, 32, 96, 95, 93, 94, 92];
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

function oneLine(text) {
  return String(text instanceof Error ? text.message : text).replace(/\r?\n/g, ' ⏎ ');
}

function createPlainRenderer({ log = (...args) => console.log(...args) } = {}) {
  const attached = [];
  return {
    mode: 'plain',
    attach(emitter, { skip = () => false } = {}) {
      for (const event of EVENTS) {
        const listener = payload => { if (!skip(event, payload)) log(formatEvent(event, payload)); };
        emitter.on(event, listener);
        attached.push([emitter, event, listener]);
      }
    },
    header() {},
    ready(result, total) {
      log(`Ready: ${total} services (algorithm=${result.algorithm}, effectiveAlgorithm=${result.effectiveAlgorithm}, totalMs=${result.totalMs})`);
    },
    stopping() {},
    error(message) { console.error(message); },
    dispose() {
      for (const [emitter, event, listener] of attached.splice(0)) emitter.removeListener(event, listener);
    }
  };
}

function createPrettyRenderer({ stream = process.stdout, color = true, showLogs = true, now = () => performance.now() } = {}) {
  const paint = (code, text) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  const c = Object.fromEntries(Object.entries(CODES).map(([name, code]) => [name, text => paint(code, text)]));
  const attached = [];
  const state = new Map(); // name -> {status, level, pid, ms, color}
  let width = 4;
  let total = 0;
  let startedAt = null;
  let phase = 'idle';
  let spinnerTimer = null;
  let frame = 0;
  let footerShown = false;

  const nameColor = name => {
    const entry = state.get(name);
    return entry ? entry.color : 36;
  };
  const label = name => paint(nameColor(name), String(name).padEnd(width));

  function clearFooter() {
    if (footerShown) { stream.write('\r\u001b[2K'); footerShown = false; }
  }
  function drawFooter() {
    // Only while the spinner runs (startup or shutdown), never while idle.
    if (!color || !spinnerTimer) return;
    const counts = { starting: 0, ready: 0 };
    for (const entry of state.values()) if (entry.status in counts) counts[entry.status]++;
    const elapsed = startedAt === null ? 0 : now() - startedAt;
    const text = phase === 'stopping'
      ? `${SPINNER[frame % SPINNER.length]} stopping services (dependents first)…`
      : `${SPINNER[frame % SPINNER.length]} ${counts.ready}/${total} ready · ${counts.starting} starting · ${formatMs(elapsed)}`;
    stream.write(`\r\u001b[2K${c.cyan(text)}`);
    footerShown = true;
  }
  function line(text) {
    // Erase spinner, print the complete line in one write, redraw spinner.
    clearFooter();
    stream.write(`${text}\n`);
    drawFooter();
  }
  function startSpinner() {
    if (!color || spinnerTimer) return;
    stream.write('\u001b[?25l'); // hide cursor while animating
    spinnerTimer = setInterval(() => { frame++; clearFooter(); drawFooter(); }, 80);
    drawFooter();
  }
  function stopSpinner() {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
    clearFooter();
    if (color) stream.write('\u001b[?25h');
  }

  const handlers = {
    'run:start'({ algorithm, total: count }) {
      total = count;
      startedAt = now();
      phase = 'starting';
      line(`${c.bold('▶ Starting')} ${count} services · algorithm ${c.bold(algorithm)}`);
      startSpinner();
    },
    'adaptive:decision'({ width: w, depth, chosen, reason }) {
      line(`${c.magenta('◆ Adaptive')} width=${w} depth=${depth} → ${c.bold(chosen.toUpperCase())}`);
      line(c.dim(`  ${reason}`));
    },
    'service:starting'({ name, pid, level }) {
      const entry = state.get(name) || { color: NAME_COLORS[state.size % NAME_COLORS.length] };
      Object.assign(entry, { status: 'starting', pid, level });
      state.set(name, entry);
      line(`${c.gray(`L${level}`)} ${c.blue('▸')} ${label(name)} starting   ${c.dim(`pid ${pid}`)}`);
    },
    'service:log'({ name, stream: which, line: text }) {
      if (!showLogs) return;
      const bar = which === 'stderr' ? c.red('│') : c.gray('│');
      line(`     ${label(name)} ${bar} ${c.dim(oneLine(text))}`);
    },
    'service:ready'({ name, ms }) {
      const entry = state.get(name);
      if (entry) Object.assign(entry, { status: 'ready', ms });
      line(`   ${c.green('✔')} ${label(name)} ready in ${c.bold(formatMs(ms))}`);
    },
    'service:failed'({ name, reason, error }) {
      const entry = state.get(name);
      if (entry) entry.status = 'failed';
      line(`   ${c.red('✖')} ${label(name)} ${c.red(`failed (${reason})`)}: ${oneLine(error)}`);
    },
    'service:restarting'({ name, attempt, maxRetries, code, signal }) {
      const entry = state.get(name);
      if (entry) entry.status = 'restarting';
      const why = signal ? `signal ${signal}` : `exit code ${code}`;
      line(`   ${c.yellow('↻')} ${label(name)} restarting (attempt ${attempt}/${maxRetries}) after ${why}; backoff ${formatMs(500 * attempt)}`);
    },
    'service:exited'({ name, code, signal }) {
      const entry = state.get(name);
      if (entry && entry.status !== 'failed' && entry.status !== 'restarting') entry.status = 'exited';
      line(`   ${c.gray('■')} ${label(name)} exited ${c.dim(signal ? `(signal ${signal})` : `(code ${code})`)}`);
    },
    'run:done'() {
      phase = 'running';
      stopSpinner();
    },
    'run:failed'({ error }) {
      phase = 'idle';
      stopSpinner();
      line(`${c.red('✖ Startup failed:')} ${oneLine(error)}`);
      line(c.dim('  Everything that had started was stopped (dependents first).'));
    }
  };

  return {
    mode: 'pretty',
    attach(emitter, { skip = () => false } = {}) {
      for (const event of EVENTS) {
        const listener = payload => {
          if (skip(event, payload)) {
            if (event === 'run:failed') { phase = 'idle'; stopSpinner(); }
            return;
          }
          handlers[event](payload);
        };
        emitter.on(event, listener);
        attached.push([emitter, event, listener]);
      }
    },
    header({ config, plan, algorithm, maxParallel }) {
      width = Math.max(4, ...plan.order.map(name => name.length));
      // Assign colours in declaration order so each service keeps one colour.
      plan.order.forEach((name, index) => state.set(name, { status: 'pending', color: NAME_COLORS[index % NAME_COLORS.length] }));
      line(`${c.bold('ServiceBoot')} ${c.dim('·')} ${config} ${c.dim('·')} ${plan.order.length} services ${c.dim('·')} ${plan.groups.length} levels`);
      plan.groups.forEach((group, level) => line(c.dim(`  L${level}: ${group.join(', ')}`)));
      if (maxParallel !== Infinity) line(c.dim(`  --max-parallel ${maxParallel}: at most ${maxParallel} services starting at once per level`));
      if (algorithm !== 'adaptive') line(c.dim(`  algorithm forced: ${algorithm}`));
    },
    ready(result, count, { exitAfterReady = false } = {}) {
      const max = Math.max(1, ...Object.values(result.readyMs || {}));
      line('');
      line(`${c.green('✔ All')} ${count} services ready in ${c.bold(formatMs(result.totalMs))} ${c.dim(`(${result.effectiveAlgorithm}${result.algorithm === 'adaptive' ? ', chosen by adaptive' : ''})`)}`);
      for (const [name, entry] of state) {
        const ms = result.readyMs?.[name];
        const bar = '█'.repeat(Math.max(1, Math.round(((ms || 0) / max) * 24)));
        line(`  ${c.gray(`L${entry.level ?? '?'}`)} ${label(name)} ${c.dim(`pid ${String(result.pids?.[name] ?? entry.pid ?? '?').padEnd(7)}`)} ${paint(entry.color, bar)} ${formatMs(ms)}`);
      }
      line(c.dim(exitAfterReady ? '  --exit-after-ready: stopping now.' : '  Running. Press Ctrl+C to stop (twice to force), or run "serviceboot down" in this folder.'));
    },
    stopping() {
      phase = 'stopping';
      line(c.yellow('■ Stopping services (dependents before dependencies)…'));
      startSpinner();
    },
    error(message) {
      clearFooter();
      console.error(color ? c.red(message) : message);
      drawFooter();
    },
    dispose() {
      stopSpinner();
      phase = 'idle';
      for (const [emitter, event, listener] of attached.splice(0)) emitter.removeListener(event, listener);
    }
  };
}

function createRenderer(options = {}) {
  const { pretty, color } = chooseMode(options);
  if (!pretty) return createPlainRenderer(options);
  return createPrettyRenderer({ ...options, color });
}

module.exports = { EVENTS, formatEvent, chooseMode, createRenderer, createPlainRenderer, createPrettyRenderer, formatMs };
