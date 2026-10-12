const net = require('node:net');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { topoLevels } = require('../../src/graph/topo');

const repoRoot = path.resolve(__dirname, '../..');
const mockPath = path.join(repoRoot, 'mock', 'mock-service.js');
const EVENT_NAMES = [
  'run:start', 'adaptive:decision', 'service:starting', 'service:log',
  'service:ready', 'service:failed', 'service:exited', 'run:done', 'run:failed'
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function quoteArgument(value) {
  const text = String(value);
  // Quote paths containing spaces, including Windows paths. Keep backslashes
  // intact; JSON.stringify would double them in a shell command on Windows.
  return /^[A-Za-z0-9_./:=\\-]+$/.test(text) ? text : `"${text.replace(/"/g, '\\"')}"`;
}

async function makeServices(specs) {
  const entries = [];
  const ports = new Set();
  for (const spec of specs) {
    let port;
    do { port = await freePort(); } while (ports.has(port));
    ports.add(port);
    const args = [mockPath, '--port', port, '--name', spec.name,
      '--delay', spec.delay === undefined ? 300 : spec.delay, ...(spec.extraArgs || [])];
    entries.push([spec.name, {
      name: spec.name,
      command: `node ${args.map(quoteArgument).join(' ')}`,
      cwd: repoRoot,
      env: {},
      dependsOn: [...(spec.deps || [])],
      readyCheck: { type: 'port', port },
      timeoutMs: 10000,
      intervalMs: 100,
      restart: 'never',
      maxRetries: 3
    }]);
  }
  const services = Object.fromEntries(entries);
  return { services, groups: topoLevels(services, specs.map(spec => spec.name)) };
}

function record(emitter) {
  const events = [];
  for (const name of EVENT_NAMES) {
    emitter.on(name, payload => events.push({ name, payload: { ...payload }, i: events.length }));
  }
  function filter(name, serviceName) {
    return events.filter(event => event.name === name &&
      (serviceName === undefined || event.payload.name === serviceName));
  }
  function find(name, serviceName) {
    return filter(name, serviceName)[0];
  }
  function maxInFlight() {
    const inFlight = new Set();
    let maximum = 0;
    for (const event of events) {
      if (event.name === 'service:starting') inFlight.add(event.payload.name);
      if (event.name === 'service:ready' || event.name === 'service:failed') {
        inFlight.delete(event.payload.name);
      }
      maximum = Math.max(maximum, inFlight.size);
    }
    return maximum;
  }
  return { events, find, filter, maxInFlight };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pids, timeoutMs = 3000) {
  const values = Array.isArray(pids) ? pids : Object.values(pids);
  const deadline = performance.now() + timeoutMs;
  while (values.some(isAlive)) {
    if (performance.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return true;
}

module.exports = { freePort, makeServices, record, isAlive, waitDead };
