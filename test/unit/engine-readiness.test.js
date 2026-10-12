const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter, getEventListeners } = require('node:events');
const { performance } = require('node:perf_hooks');
const { EngineError } = require('../../src/engine/errors');
const { isPortOpen, httpOk, waitForReady, preflightPort } = require('../../src/engine/readiness');
const { spawnService, terminate, getRunning } = require('../../src/engine/process-manager');
const { createEmit } = require('../../src/engine/events');
const { freePort } = require('../helpers');

const options = { timeout: 5000 };

function fakeProcess() {
  let resolveExit;
  const handle = {
    hasExited: false, tail: [], child: { exitCode: null },
    exited: new Promise(resolve => { resolveExit = resolve; })
  };
  return {
    handle,
    exit(code = 7, signal = null) {
      handle.hasExited = true;
      handle.child.exitCode = code;
      resolveExit({ code, signal });
    }
  };
}

function service(readyCheck, overrides = {}) {
  return { name: 'readiness-test', readyCheck, timeoutMs: 1000, intervalMs: 25, ...overrides };
}

function schedule(t, ms, callback) {
  const timer = setTimeout(callback, ms);
  t.after(() => clearTimeout(timer));
}

function trackServer(t, server) {
  const sockets = new Set();
  const onConnection = socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', onConnection);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    server.removeListener('connection', onConnection);
  });
  return sockets;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    function onError(error) {
      server.removeListener('listening', onListening);
      reject(error);
    }
    function onListening() {
      server.removeListener('error', onError);
      resolve(server.address().port);
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function waitUntil(predicate) {
  const deadline = performance.now() + 1000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('Timed out waiting for probe cleanup');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('isPortOpen detects an open port and a refused connection, releasing sockets', options, async t => {
  const server = net.createServer();
  const sockets = trackServer(t, server);
  const port = await listen(server);
  assert.equal(await isPortOpen(port), true);
  await waitUntil(() => sockets.size === 0);
  const free = await freePort();
  assert.equal(await isPortOpen(free), false);
});

test('isPortOpen destroys a stalled socket and clears its listeners on timeout', options, async t => {
  // A controllable socket exercises a connect timeout without depending on a
  // particular host firewall silently dropping outbound SYN packets.
  const socket = new EventEmitter();
  let destroys = 0;
  socket.destroy = () => { destroys++; queueMicrotask(() => socket.emit('close')); };
  t.mock.method(net, 'connect', () => socket);
  assert.equal(await isPortOpen(12345, '127.0.0.1', 25), false);
  await Promise.resolve();
  assert.equal(destroys, 1);
  assert.equal(socket.listenerCount('connect'), 0);
  assert.equal(socket.listenerCount('error'), 0);
  assert.equal(socket.listenerCount('close'), 0);
});

test('port readiness resolves after a port opens at 300 ms', options, async t => {
  const port = await freePort();
  const server = net.createServer();
  trackServer(t, server);
  schedule(t, 300, () => server.listen(port, '127.0.0.1'));
  const controller = new AbortController();
  const ms = await waitForReady(service({ type: 'port', port }), {
    handle: fakeProcess().handle, signal: controller.signal
  });
  assert.ok(ms >= 275, `ready after ${ms}ms`);
  assert.ok(ms < 1000);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a port that never opens rejects with a readiness timeout and last probe detail', options, async () => {
  const port = await freePort();
  const controller = new AbortController();
  const start = performance.now();
  await assert.rejects(waitForReady(service({ type: 'port', port }, { timeoutMs: 180 }), {
    handle: fakeProcess().handle, signal: controller.signal
  }), error => {
    assert.ok(error instanceof EngineError);
    assert.equal(error.reason, 'timeout');
    assert.equal(error.serviceName, 'readiness-test');
    assert.match(error.message, /^not ready after 180ms \(last check: (connection refused|timeout)\)$/);
    return true;
  });
  assert.ok(performance.now() - start >= 180);
  assert.ok(performance.now() - start < 500);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('httpOk accepts only 2xx and destroys an unfinished response body', options, async t => {
  let status = 200;
  const server = http.createServer((request, response) => {
    response.writeHead(status);
    response.flushHeaders();
    // Deliberately leave the body unfinished: a readiness probe must close it.
  });
  const sockets = trackServer(t, server);
  const port = await listen(server);
  for (status of [200, 204, 299, 301, 503]) {
    assert.deepEqual(await httpOk(`http://127.0.0.1:${port}/health`), {
      ok: status >= 200 && status < 300, detail: `HTTP ${status}`
    });
    await waitUntil(() => sockets.size === 0);
  }
});

test('httpOk describes a refused connection and a server that never sends headers', options, async t => {
  const free = await freePort();
  assert.deepEqual(await httpOk(`http://127.0.0.1:${free}/health`), {
    ok: false, detail: 'connection refused'
  });
  const server = http.createServer(() => {});
  const sockets = trackServer(t, server);
  const port = await listen(server);
  assert.deepEqual(await httpOk(`http://127.0.0.1:${port}/health`, 40), {
    ok: false, detail: 'timeout'
  });
  await waitUntil(() => sockets.size === 0);
});

test('HTTP readiness retries 503 until a 200 response', options, async t => {
  let requests = 0;
  const server = http.createServer((request, response) => {
    response.writeHead(++requests < 3 ? 503 : 200);
    response.end();
  });
  const sockets = trackServer(t, server);
  const port = await listen(server);
  const controller = new AbortController();
  const ms = await waitForReady(service({ type: 'http', url: `http://127.0.0.1:${port}/health` }), {
    handle: fakeProcess().handle, signal: controller.signal
  });
  assert.equal(requests, 3);
  assert.ok(ms >= 45);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await waitUntil(() => sockets.size === 0);
});

test('HTTP always 500 times out with HTTP 500 in the diagnostic', options, async t => {
  const server = http.createServer((request, response) => {
    response.writeHead(500);
    response.end();
  });
  const sockets = trackServer(t, server);
  const port = await listen(server);
  await assert.rejects(waitForReady(service({ type: 'http', url: `http://127.0.0.1:${port}/health` }, {
    timeoutMs: 180
  }), { handle: fakeProcess().handle }), {
    name: 'EngineError', reason: 'timeout',
    message: 'not ready after 180ms (last check: HTTP 500)'
  });
  await waitUntil(() => sockets.size === 0);
});

test('hanging HTTP probes cannot overrun the overall readiness deadline', options, async t => {
  const server = http.createServer(() => {});
  const sockets = trackServer(t, server);
  const port = await listen(server);
  const start = performance.now();
  await assert.rejects(waitForReady(service({ type: 'http', url: `http://127.0.0.1:${port}` }, {
    timeoutMs: 120, intervalMs: 100
  }), { handle: fakeProcess().handle }), {
    reason: 'timeout', message: 'not ready after 120ms (last check: timeout)'
  });
  assert.ok(performance.now() - start < 300);
  await waitUntil(() => sockets.size === 0);
});

test('an already exited handle rejects as crash with only its last five log lines', options, async () => {
  const process = fakeProcess();
  process.handle.tail = ['old line', 'one', 'two', 'three', 'four', 'five'];
  process.exit(9);
  await assert.rejects(waitForReady(service({ type: 'port', port: 12345 }), {
    handle: process.handle
  }), {
    name: 'EngineError', reason: 'crash', serviceName: 'readiness-test',
    message: 'exited with code 9 before becoming ready\none\ntwo\nthree\nfour\nfive'
  });
});

test('process exit interrupts the sleep between probes immediately', options, async t => {
  const port = await freePort();
  const process = fakeProcess();
  const controller = new AbortController();
  const start = performance.now();
  schedule(t, 50, () => process.exit(3));
  await assert.rejects(waitForReady(service({ type: 'port', port }, { intervalMs: 700 }), {
    handle: process.handle, signal: controller.signal
  }), { reason: 'crash', message: 'exited with code 3 before becoming ready' });
  assert.ok(performance.now() - start < 300);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort interrupts the sleep between probes and removes the abort listener', options, async t => {
  const port = await freePort();
  const controller = new AbortController();
  const start = performance.now();
  schedule(t, 50, () => controller.abort());
  await assert.rejects(waitForReady(service({ type: 'port', port }, { intervalMs: 700 }), {
    handle: fakeProcess().handle, signal: controller.signal
  }), { name: 'EngineError', reason: 'aborted', serviceName: 'readiness-test' });
  assert.ok(performance.now() - start < 300);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const cause of ['abort', 'exit']) {
  test(`${cause} interrupts an in-flight HTTP probe and releases its socket`, options, async t => {
    const controller = new AbortController();
    const process = fakeProcess();
    let stoppedAt;
    const server = http.createServer(() => {
      // The request proves the probe is in flight before interruption.
      stoppedAt = performance.now();
      if (cause === 'abort') controller.abort();
      else process.exit(4);
    });
    const sockets = trackServer(t, server);
    const port = await listen(server);
    await assert.rejects(waitForReady(service({ type: 'http', url: `http://127.0.0.1:${port}` }, {
      timeoutMs: 3000, intervalMs: 900
    }), { handle: process.handle, signal: controller.signal }), {
      reason: cause === 'abort' ? 'aborted' : 'crash'
    });
    assert.ok(performance.now() - stoppedAt < 200);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await waitUntil(() => sockets.size === 0);
  });
}

test('an already aborted signal prevents the first probe', options, async t => {
  const controller = new AbortController();
  controller.abort();
  const probe = t.mock.method(net, 'connect', () => { throw new Error('must not probe'); });
  await assert.rejects(waitForReady(service({ type: 'port', port: 12345 }), {
    handle: fakeProcess().handle, signal: controller.signal
  }), { reason: 'aborted' });
  assert.equal(probe.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort destroys an in-flight stalled TCP socket and clears its probe listeners', options, async t => {
  const controller = new AbortController();
  const socket = new EventEmitter();
  let destroys = 0;
  socket.destroy = () => { destroys++; queueMicrotask(() => socket.emit('close')); };
  t.mock.method(net, 'connect', () => {
    queueMicrotask(() => controller.abort());
    return socket;
  });
  const start = performance.now();
  await assert.rejects(waitForReady(service({ type: 'port', port: 12345 }, {
    intervalMs: 700
  }), { handle: fakeProcess().handle, signal: controller.signal }), { reason: 'aborted' });
  assert.ok(performance.now() - start < 200);
  assert.equal(destroys, 1);
  assert.deepEqual(socket.eventNames(), []);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('none readiness resolves zero immediately without probes or subscriptions', options, async t => {
  const controller = new AbortController();
  const process = fakeProcess();
  process.exit(1);
  controller.abort();
  const start = performance.now();
  assert.equal(await waitForReady(service({ type: 'none' }), {
    handle: process.handle, signal: controller.signal
  }), 0);
  assert.ok(performance.now() - start < 50);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('preflightPort rejects a busy port with the exact spawn diagnostic and accepts a free port', options, async t => {
  const server = net.createServer();
  const sockets = trackServer(t, server);
  const port = await listen(server);
  await assert.rejects(preflightPort(service({ type: 'port', port })), {
    name: 'EngineError', reason: 'spawn', serviceName: 'readiness-test',
    message: `Port ${port} is already in use (is a previous run still alive? try "serviceboot down")`
  });
  await waitUntil(() => sockets.size === 0);
  await preflightPort(service({ type: 'port', port: await freePort() }));
  await preflightPort(service({ type: 'none' }));
  await preflightPort(service({ type: 'http', url: `http://127.0.0.1:${port}` }));
});

test('HTTPS uses certificate validation and accepts 2xx with an explicitly trusted test certificate', options, async t => {
  const fixturePath = path.join(__dirname, 'engine-readiness-fixtures');
  const cert = fs.readFileSync(path.join(fixturePath, 'localhost-cert.pem'));
  const server = https.createServer({ cert,
    key: fs.readFileSync(path.join(fixturePath, 'localhost-key.pem'))
  }, (request, response) => { response.writeHead(204); response.end(); });
  const sockets = trackServer(t, server);
  const port = await listen(server);
  const url = `https://127.0.0.1:${port}/health`;
  const untrusted = await httpOk(url);
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.detail, /self.signed certificate/i);
  const originalGet = https.get;
  // Trust this fixture only inside the test. Production keeps TLS validation.
  t.mock.method(https, 'get', (address, options, callback) => originalGet(address, {
    ...options, ca: cert
  }, callback));
  assert.deepEqual(await httpOk(url), { ok: true, detail: 'HTTP 204' });
  assert.ok(await waitForReady(service({ type: 'http', url }), { handle: fakeProcess().handle }) >= 0);
  await waitUntil(() => sockets.size === 0);
});

test('readiness composes with a real spawned delayed mock and leaves no running service', options, async t => {
  const port = await freePort();
  const root = path.resolve(__dirname, '../..');
  const spec = service({ type: 'port', port }, {
    cwd: root, env: {},
    command: `"${process.execPath}" "${path.join(root, 'mock', 'mock-service.js')}" --port ${port} --delay 300`
  });
  await preflightPort(spec);
  const handle = await spawnService(spec, { level: 0, emit: createEmit(new EventEmitter()) });
  t.after(() => terminate(handle, { graceMs: 50 }));
  const ms = await waitForReady(spec, { handle });
  assert.ok(ms >= 275, `real mock ready after ${ms}ms`);
  await terminate(handle, { graceMs: 50 });
  assert.deepEqual(getRunning(), []);
  assert.equal(await isPortOpen(port), false);
});

test('a real mock crash rejects readiness promptly with its exit code and log tail', options, async t => {
  const port = await freePort();
  const root = path.resolve(__dirname, '../..');
  const spec = service({ type: 'port', port }, {
    cwd: root, env: {}, timeoutMs: 2500, intervalMs: 900,
    command: `"${process.execPath}" "${path.join(root, 'mock', 'mock-service.js')}" --port ${port} --delay 2000 --exit-after 80 --exit-code 7`
  });
  const handle = await spawnService(spec, { level: 0, emit: createEmit(new EventEmitter()) });
  t.after(() => terminate(handle, { graceMs: 50 }));
  const start = performance.now();
  await assert.rejects(waitForReady(spec, { handle }), {
    name: 'EngineError', reason: 'crash',
    message: 'exited with code 7 before becoming ready\n[mock] starting'
  });
  assert.ok(performance.now() - start < 700);
  await terminate(handle, { graceMs: 50 });
  assert.deepEqual(getRunning(), []);
});
