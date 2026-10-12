const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const mockFile = path.resolve(__dirname, '../../mock/mock-service.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(predicate, description) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function startMock(t, args) {
  const child = spawn(process.execPath, [mockFile, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  const state = { child, stdout: '', stderr: '', ended: false };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { state.stdout += data; });
  child.stderr.on('data', data => { state.stderr += data; });
  child.on('error', error => { state.error = error; });
  child.on('close', (code, signal) => { state.ended = true; state.code = code; state.signal = signal; });
  t.after(async () => {
    if (!state.ended) child.kill('SIGKILL');
    await waitUntil(() => state.ended, 'mock process cleanup');
  });
  return state;
}

async function waitForLog(state, text) {
  await waitUntil(() => state.stdout.includes(text) || state.ended || state.error, text);
  assert.ifError(state.error);
  assert.ok(state.stdout.includes(text), `stdout: ${state.stdout}\nstderr: ${state.stderr}`);
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let finished = false;
    function finish(connected) {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(connected);
    }
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: urlPath, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.setTimeout(1000, () => request.destroy(new Error('HTTP request timed out')));
  });
}

test('mock TCP port opens after its delay and not before', { timeout: 10000 }, async t => {
  const port = await freePort();
  const started = performance.now();
  const state = startMock(t, ['--port', String(port), '--name', 'delayed', '--delay', '600']);
  await waitForLog(state, '[delayed] starting');
  assert.equal(await canConnect(port), false);
  assert.ok(!state.stdout.includes('listening'));
  await waitForLog(state, `[delayed] listening on 127.0.0.1:${port}`);
  assert.ok(performance.now() - started >= 600);
  assert.equal(await canConnect(port), true);
  assert.equal(state.stderr, '');
});

test('mock HTTP health returns 200 ok and other paths return 404', { timeout: 10000 }, async t => {
  const port = await freePort();
  const state = startMock(t, ['--port', String(port), '--http']);
  await waitForLog(state, `listening on 127.0.0.1:${port}`);
  assert.deepEqual(await get(port, '/health'), { status: 200, body: 'ok' });
  assert.equal((await get(port, '/other')).status, 404);
});

test('mock HTTP supports a custom health path', { timeout: 10000 }, async t => {
  const port = await freePort();
  const state = startMock(t, ['--port', String(port), '--http', '--health-path', '/status']);
  await waitForLog(state, `listening on 127.0.0.1:${port}`);
  assert.deepEqual(await get(port, '/status'), { status: 200, body: 'ok' });
  assert.equal((await get(port, '/health')).status, 404);
});

test('mock exit-after uses the requested code and starts before readiness delay', { timeout: 10000 }, async t => {
  const port = await freePort();
  const state = startMock(t, ['--port', String(port), '--delay', '1000', '--exit-after', '80', '--exit-code', '7']);
  await waitUntil(() => state.ended, 'scheduled crash');
  assert.equal(state.code, 7);
  assert.equal(state.signal, null);
  assert.ok(state.stdout.includes('[mock] starting'));
  assert.ok(!state.stdout.includes('listening'));
  assert.equal(await canConnect(port), false);
});

test('mock never-ready stays alive without opening a port', { timeout: 10000 }, async t => {
  const port = await freePort();
  const state = startMock(t, ['--port', String(port), '--never-ready']);
  await waitForLog(state, '[mock] starting');
  await delay(80);
  assert.equal(state.ended, false);
  assert.equal(await canConnect(port), false);
  assert.ok(!state.stdout.includes('listening'));
});

test('mock SIGTERM closes active sockets, logs stopping, and exits cleanly', {
  timeout: 10000, skip: process.platform === 'win32'
}, async t => {
  const port = await freePort();
  const state = startMock(t, ['--port', String(port), '--name', 'term']);
  await waitForLog(state, `listening on 127.0.0.1:${port}`);
  const socket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  assert.equal(state.child.kill('SIGTERM'), true);
  await waitUntil(() => state.ended, 'SIGTERM shutdown');
  assert.equal(state.code, 0);
  assert.equal(state.signal, null);
  assert.ok(state.stdout.includes('[term] stopping'));
  assert.equal(await canConnect(port), false);
});

test('mock SIGTERM during delay cancels the pending listener', {
  timeout: 10000, skip: process.platform === 'win32'
}, async t => {
  const port = await freePort();
  const state = startMock(t, ['--port', String(port), '--delay', '1000']);
  await waitForLog(state, '[mock] starting');
  state.child.kill('SIGTERM');
  await waitUntil(() => state.ended, 'shutdown during delay');
  assert.equal(state.code, 0);
  assert.ok(state.stdout.includes('[mock] stopping'));
  assert.ok(!state.stdout.includes('listening'));
  assert.equal(await canConnect(port), false);
});

test('mock ignore-sigterm logs and stays alive until SIGKILL', {
  timeout: 10000, skip: process.platform === 'win32'
}, async t => {
  const port = await freePort();
  const state = startMock(t, ['--port', String(port), '--never-ready', '--ignore-sigterm']);
  await waitForLog(state, '[mock] starting');
  state.child.kill('SIGTERM');
  await waitForLog(state, '[mock] ignoring SIGTERM');
  assert.equal(state.ended, false);
  state.child.kill('SIGKILL');
  await waitUntil(() => state.ended, 'forced shutdown');
  assert.equal(state.signal, 'SIGKILL');
});

test('mock invalid arguments print an error and exit 2', () => {
  for (const args of [
    [], ['--port', '0'], ['--port', '65536'], ['--port', 'abc'], ['--port', '1.5'],
    ['--port', '4101', '--delay=-1'], ['--port', '4101', '--delay', '2147483648'],
    ['--port', '4101', '--exit-code', '7'],
    ['--port', '4101', '--exit-after', '10', '--exit-code', '256'],
    ['--port', '4101', '--exit-after=abc'], ['--port', '4101', '--name='],
    ['--port', '4101', '--health-path', 'health'], ['--port', '4101', '--bogus'],
    ['--port', '4101', 'unexpected']
  ]) {
    const result = spawnSync(process.execPath, [mockFile, ...args], {
      encoding: 'utf8', timeout: 5000, windowsHide: true
    });
    assert.ifError(result.error);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /^error:/);
    assert.equal(result.stdout, '');
  }
});
