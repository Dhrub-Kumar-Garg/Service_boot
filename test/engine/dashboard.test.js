const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const http = require('node:http');
const { createDashboard, parseEvent } = require('../../src/dashboard/server');
const { freePort, waitDead } = require('../helpers');
const pidfile = require('../../src/engine/pidfile');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-dashboard-'));
  const port = await freePort();
  const command = `node "${path.resolve(__dirname, '../../mock/mock-service.js')}" --port ${port} --name api --delay 100 --http`;
  fs.writeFileSync(path.join(root, 'serviceboot.yml'), `version: 1\nservices:\n  api:\n    command: ${JSON.stringify(command)}\n    ready_check: http http://127.0.0.1:${port}/health\n    ready_interval_ms: 50\n`);
  fs.mkdirSync(path.join(root, 'samples'));
  fs.writeFileSync(path.join(root, 'samples/invalid.yml'), 'version: 1\nservices:\n  api: {command: node api, depends_on: [missing]}\n');
  const app = createDashboard({ root });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const get = async route => {
    const response = await fetch(`${origin}${route}`);
    return { status: response.status, body: await response.json() };
  };
  const post = async (route, data = {}, headers = {}) => {
    const response = await fetch(`${origin}${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    return { status: response.status, body: await response.json() };
  };
  return { app, root, origin, get, post };
}

async function until(get, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const { body } = await get('/api/state');
    if (predicate(body)) return body;
    if (body.phase === 'failed') assert.fail(body.error);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for dashboard state');
}

test('DASHBOARD: event parser preserves numeric readiness and ignores service log contents', () => {
  assert.deepEqual(parseEvent('service:ready api pid=123 ms=45.75 ts=99'), {
    event: 'service:ready', name: 'api', pid: 123, ms: 45.75
  });
  assert.equal(parseEvent('[api] listening on 127.0.0.1:4101'), null);
  assert.equal(parseEvent('error: cannot start api'), null);
});

test('DASHBOARD: plans, assets, all config errors, and missing report have honest responses', { timeout: 30000 }, async t => {
  const { get, origin } = await fixture(t);
  assert.deepEqual((await get('/api/configs')).body.configs, ['serviceboot.yml', 'samples/invalid.yml']);
  const plan = await get('/api/plan?config=serviceboot.yml');
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.body.groups, [['api']]);
  assert.ok(plan.body.source.includes('ready_check: http'));
  const invalid = await get('/api/plan?config=samples/invalid.yml');
  assert.equal(invalid.status, 422);
  assert.match(invalid.body.errors[0], /unknown service "missing"/);
  assert.equal((await get('/api/plan?config=../../package.json')).status, 400);
  assert.equal((await get('/api/report')).status, 404);
  for (const asset of ['/', '/app.js', '/style.css', '/favicon.svg']) {
    const response = await fetch(`${origin}${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.ok((await response.text()).length > 0);
  }
});

test('DASHBOARD: rejects foreign origins, invalid options, and double starts', { timeout: 30000 }, async t => {
  const { get, post, root, origin } = await fixture(t);
  assert.equal((await post('/api/start', {}, { Origin: 'https://example.com' })).status, 403);
  // fetch normalizes Host, so use a raw HTTP request to exercise DNS-rebinding
  // protection with the actual foreign header rather than silently replacing it.
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.request(`${origin}/api/start`, { method: 'POST',
      headers: { Host: 'example.com', 'Content-Type': 'application/json' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(foreignHost, 403);
  assert.equal((await post('/api/start', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/start', { config: 'serviceboot.yml', algorithm: 'fast' })).status, 400);
  assert.equal((await post('/api/start', { config: 'serviceboot.yml', maxParallel: 0 })).status, 400);
  assert.equal(pidfile.read({ cwd: root }), null);
  assert.equal((await post('/api/start', { config: 'serviceboot.yml' })).status, 202);
  assert.equal((await post('/api/start', { config: 'serviceboot.yml' })).status, 409);
  const running = await until(get, state => state.phase === 'running');
  assert.equal(running.services.api.status, 'ready');
  assert.ok(running.services.api.pid > 0);
  assert.ok(running.services.api.ms >= 0);
  assert.ok(running.totalMs > 0);
  assert.equal(running.effectiveAlgorithm, 'sequential');
  assert.equal(running.algorithm, 'adaptive');
  assert.ok(running.logs.some(entry => entry.line.includes('[api] listening')));
  const stopped = await post('/api/stop');
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.phase, 'stopped');
  assert.ok(await waitDead([running.services.api.pid], 3000));
  assert.equal(pidfile.read({ cwd: root }), null);
});

test('DASHBOARD: immediate Stop and closing the server both drain owned services', { timeout: 30000 }, async t => {
  const { app, get, post, root } = await fixture(t);
  await post('/api/start', { config: 'serviceboot.yml', algorithm: 'parallel', maxParallel: 1 });
  assert.equal((await post('/api/stop')).status, 200);
  assert.equal(pidfile.read({ cwd: root }), null);
  await post('/api/start', { config: 'serviceboot.yml', algorithm: 'parallel' });
  const running = await until(get, state => state.phase === 'running');
  await app.close();
  assert.ok(await waitDead([running.services.api.pid], 3000));
  assert.equal(pidfile.read({ cwd: root }), null);
});

test('DASHBOARD: never takes over or stops a separately owned CLI run', { timeout: 30000 }, async t => {
  const { app, post, root } = await fixture(t);
  pidfile.write({ cliPid: process.pid, config: 'other.yml' }, { cwd: root });
  assert.equal((await post('/api/start', { config: 'serviceboot.yml' })).status, 409);
  assert.equal((await post('/api/stop')).status, 200);
  await app.close();
  assert.equal(pidfile.read({ cwd: root }).cliPid, process.pid);
});
