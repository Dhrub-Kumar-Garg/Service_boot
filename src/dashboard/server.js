const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadPlan } = require('../plan');
const { down } = require('../engine/down');
const pidfile = require('../engine/pidfile');
const { isPidAlive } = require('../engine/process-manager');

const REPO = path.resolve(__dirname, '../..');
const ASSETS = path.join(__dirname, 'public');
const ALGORITHMS = ['adaptive', 'sequential', 'parallel'];

// Read the CLI's existing plain event format, leaving log/error text intact.
// A stream chunk is not necessarily a complete line; the caller buffers it.
function parseEvent(line) {
  const match = /^(service:[a-z]+)\s+(\S+)(?:\s|$)/.exec(line);
  if (!match) return null;
  const fields = Object.fromEntries([...line.matchAll(/\b(pid|level|ms|attempt)=(\d+(?:\.\d+)?)/g)]
    .map(([, key, value]) => [key, Number(value)]));
  return { event: match[1], name: match[2], ...fields };
}

function createDashboard({ root = REPO } = {}) {
  let child = null;
  let stopping = null;
  let closing = false;
  let state = { phase: 'idle', config: null, algorithm: 'adaptive', totalMs: null,
    effectiveAlgorithm: null, services: {}, logs: [], error: null };
  let sequence = 0;

  function configs() {
    const samples = path.join(root, 'samples');
    const yamlName = name => /^[A-Za-z0-9_-]+\.yml$/.test(name);
    const names = fs.existsSync(samples) ? fs.readdirSync(samples)
      .filter(yamlName).map(name => `samples/${name}`) : [];
    return [...fs.readdirSync(root).filter(yamlName), ...names];
  }

  function configPath(config) {
    if (!configs().includes(config)) throw Object.assign(new Error('Choose a configuration from this workspace.'), { status: 400 });
    return path.resolve(root, config);
  }

  function append(line, stream = 'stdout') {
    if (!line) return;
    state.logs.push({ id: ++sequence, line, stream, at: new Date().toISOString() });
    if (state.logs.length > 1000) state.logs.shift();
    const event = parseEvent(line);
    if (event && Object.hasOwn(state.services, event.name)) {
      const entry = state.services[event.name];
      const statuses = { 'service:starting': 'starting', 'service:ready': 'ready',
        'service:failed': 'failed', 'service:exited': 'stopped', 'service:restarting': 'restarting' };
      if (statuses[event.event]) Object.assign(entry, event, { status: statuses[event.event] });
    }
    if (line.startsWith('run:done ')) {
      state.totalMs = Number(/\btotalMs=([\d.]+)/.exec(line)?.[1]) || 0;
      state.effectiveAlgorithm = /\beffectiveAlgorithm=(\w+)/.exec(line)?.[1] || null;
      if (state.phase !== 'stopping') state.phase = 'running';
    }
    if (line.startsWith('error: ') || line.startsWith('run:failed ')) state.error = line;
  }

  function start({ config, algorithm = 'adaptive', maxParallel } = {}) {
    if (closing || child || stopping) throw Object.assign(new Error('Stop the current run before starting another.'), { status: 409 });
    const previous = pidfile.read({ cwd: root });
    if (previous && isPidAlive(previous.cliPid)) {
      throw Object.assign(new Error('A CLI run already owns this workspace. Stop it with serviceboot down first.'), { status: 409 });
    }
    if (!ALGORITHMS.includes(algorithm)) throw Object.assign(new Error('Unknown startup algorithm.'), { status: 400 });
    if (maxParallel !== undefined && (!Number.isSafeInteger(maxParallel) || maxParallel < 1)) {
      throw Object.assign(new Error('Concurrency limit must be a positive integer.'), { status: 400 });
    }
    const file = configPath(config);
    const plan = loadPlan(file);
    state = { phase: 'starting', config, algorithm, totalMs: null, effectiveAlgorithm: null,
      maxParallel: maxParallel ?? null,
      services: Object.fromEntries(plan.order.map(name => [name, { status: 'pending' }])), logs: [], error: null };
    const args = [path.join(REPO, 'bin/serviceboot.js'), 'up', '--config', file, '--algorithm', algorithm, '--plain'];
    if (maxParallel !== undefined) args.push('--max-parallel', String(maxParallel));
    // Reuse the CLI as a child process: it already owns PID files, signals,
    // readiness and full process-tree cleanup on each supported OS.
    child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    for (const stream of ['stdout', 'stderr']) {
      let buffer = '';
      child[stream].setEncoding('utf8');
      child[stream].on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) append(line, stream);
        // Bound an unterminated service log line as well as the log history.
        if (buffer.length > 65536) { append(buffer.slice(0, 65536), stream); buffer = ''; }
      });
      child[stream].on('end', () => { if (buffer) append(buffer, stream); });
    }
    child.on('error', error => { state.error = error.message; });
    child.on('close', code => {
      child = null;
      const failed = code !== 0 && code !== 130 && code !== 143 && state.phase !== 'stopping';
      state.phase = failed ? 'failed' : 'stopped';
      if (failed && !state.error) state.error = `ServiceBoot exited with code ${code}.`;
      for (const service of Object.values(state.services)) if (service.status !== 'failed') service.status = 'stopped';
    });
  }

  function stop() {
    if (stopping) return stopping;
    if (!child) return Promise.resolve();
    state.phase = 'stopping';
    const owned = child;
    stopping = (async () => {
      // The CLI publishes its PID file just after spawn. Await publication (or
      // exit) so an immediate Stop does not miss a run still starting up.
      const deadline = Date.now() + 5000;
      while (child === owned && pidfile.read({ cwd: root })?.cliPid !== owned.pid) {
        if (Date.now() >= deadline) throw new Error('CLI has not published its PID file. Check the live logs.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (child === owned) {
        const exited = new Promise(resolve => owned.once('close', resolve));
        await down({ cwd: root });
        await exited;
      }
    })().catch(error => {
      state.error = error.message;
      state.phase = 'failed';
      throw error;
    }).finally(() => { stopping = null; });
    return stopping;
  }

  async function body(request) {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 8192) throw Object.assign(new Error('Request too large.'), { status: 413 });
    }
    try { return JSON.parse(text || '{}'); }
    catch { throw Object.assign(new Error('Invalid JSON request.'), { status: 400 }); }
  }

  const server = http.createServer(async (request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff' });
      response.end(JSON.stringify(data));
    };
    try {
      // Bind to loopback, reject foreign Host/Origin values, and accept JSON
      // only for mutations so another website cannot start local processes.
      const host = `127.0.0.1:${server.address()?.port}`;
      if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
        return send(403, { error: 'Only this local dashboard can make requests.' });
      }
      const url = new URL(request.url, `http://${host}`);
      if (request.method === 'GET' && url.pathname === '/api/configs') return send(200, { configs: configs() });
      if (request.method === 'GET' && url.pathname === '/api/plan') {
        const file = configPath(url.searchParams.get('config'));
        return send(200, { ...loadPlan(file), source: fs.readFileSync(file, 'utf8') });
      }
      if (request.method === 'GET' && url.pathname === '/api/state') return send(200, state);
      if (request.method === 'GET' && url.pathname === '/api/report') {
        const file = path.join(root, 'report/results.json');
        return fs.existsSync(file) ? send(200, JSON.parse(fs.readFileSync(file, 'utf8')))
          : send(404, { error: 'No saved benchmark report found. Run the CLI benchmark to generate one.' });
      }
      if (request.method === 'POST' && ['/api/start', '/api/stop'].includes(url.pathname)) {
        if (request.headers['content-type'] !== 'application/json') return send(415, { error: 'Use application/json.' });
        if (url.pathname === '/api/start') { start(await body(request)); return send(202, state); }
        await stop();
        return send(200, state);
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (request.method !== 'GET' || !Object.hasOwn(assets, url.pathname)) return send(404, { error: 'Not found.' });
      const [file, type] = assets[url.pathname];
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
      response.end(fs.readFileSync(path.join(ASSETS, file)));
    } catch (error) {
      send(error.status || (error.name === 'ConfigError' ? 422 : 500), { error: error.message, errors: error.errors });
    }
  });

  async function close() {
    closing = true;
    await stop();
    if (server.listening) {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeIdleConnections();
      await closed;
    }
  }
  return { server, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT must be an integer between 1 and 65535.');
    process.exitCode = 2;
  } else {
    const app = createDashboard();
    app.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    app.server.listen(port, '127.0.0.1', () => console.log(`ServiceBoot dashboard: http://127.0.0.1:${port}`));
    let shutdown;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (!shutdown) shutdown = app.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    });
  }
}

module.exports = { createDashboard, parseEvent };
