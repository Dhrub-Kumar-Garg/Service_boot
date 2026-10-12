const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const { EngineError } = require('./errors');

function errorDetail(error) {
  if (error.code === 'ECONNREFUSED') return 'connection refused';
  if (error.code === 'ETIMEDOUT') return 'timeout';
  return error.message;
}

function portProbe(port, host, timeoutMs, signal) {
  return new Promise(resolve => {
    let socket;
    let timer;
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket?.removeListener('connect', onConnect);
      // A TCP socket is an OS connection, even when a probe fails. Destroy it
      // on every path so readiness never keeps a connection or event loop alive.
      socket?.destroy();
      resolve(result);
    }
    const onConnect = () => finish({ ok: true, detail: 'port open' });
    const onError = error => finish({ ok: false, detail: errorDetail(error) });
    const onAbort = () => finish({ ok: false, detail: 'aborted' });
    function onClose() {
      // Keep the error handler through close to absorb errors queued by destroy.
      socket.removeListener('error', onError);
      finish({ ok: false, detail: 'connection closed' });
    }

    try {
      socket = net.connect({ port, host });
      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.once('close', onClose);
      // This is a total probe deadline, not an inactivity timeout that traffic
      // could repeatedly reset.
      timer = setTimeout(() => finish({ ok: false, detail: 'timeout' }), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    } catch (error) {
      finish({ ok: false, detail: errorDetail(error) });
    }
  });
}

async function isPortOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  return (await portProbe(port, host, timeoutMs)).ok;
}

function httpProbe(url, timeoutMs, signal) {
  return new Promise(resolve => {
    let request;
    let response;
    let timer;
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Readiness uses the status headers, not the body. Destroying the body
      // and request releases their socket even if the server streams forever.
      response?.destroy();
      request?.destroy();
      resolve(result);
    }
    const onError = error => finish({ ok: false, detail: errorDetail(error) });
    const onAbort = () => finish({ ok: false, detail: 'aborted' });
    function onResponse(value) {
      response = value;
      response.once('error', onError);
      response.once('close', () => response.removeListener('error', onError));
      if (settled) {
        response.destroy();
        return;
      }
      finish({ ok: response.statusCode >= 200 && response.statusCode < 300,
        detail: `HTTP ${response.statusCode}` });
    }
    function onClose() {
      request.removeListener('error', onError);
      request.removeListener('response', onResponse);
      finish({ ok: false, detail: 'connection closed' });
    }

    try {
      const address = new URL(url);
      const transport = address.protocol === 'https:' ? https : http;
      // Each probe owns its socket; no HTTP keep-alive pool survives readiness.
      // HTTPS uses Node's normal certificate validation, including hostname.
      request = transport.get(address, { agent: false }, onResponse);
      request.once('error', onError);
      request.once('close', onClose);
      timer = setTimeout(() => finish({ ok: false, detail: 'timeout' }), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    } catch (error) {
      finish({ ok: false, detail: errorDetail(error) });
    }
  });
}

function httpOk(url, timeoutMs = 1000) {
  return httpProbe(url, timeoutMs);
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    let timer;
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

// A Promise has no removeListener API. Attach just once per readiness wait,
// and clear this callback on completion so a pending exited Promise retains
// only an empty subscription, not timers, sockets or the service's state.
function subscribeToExit(exited, callback) {
  const subscription = { callback };
  exited.then(result => subscription.callback?.(result));
  return () => { subscription.callback = null; };
}

async function waitForReady(service, { handle, signal }) {
  const started = performance.now();
  if (service.readyCheck.type === 'none') return 0;

  const deadline = started + service.timeoutMs;
  const controller = new AbortController();
  let exitResult;
  let observedExit = false;
  let detail = 'not checked';
  const unsubscribeExit = subscribeToExit(handle.exited, result => {
    exitResult = result;
    observedExit = true;
    // The process exit notification interrupts both a probe and its next sleep.
    controller.abort();
  });
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  function checkStopped() {
    if (handle.hasExited || observedExit) {
      const code = exitResult ? exitResult.code : handle.child?.exitCode ?? 'unknown';
      const tail = handle.tail.slice(-5);
      throw new EngineError(`exited with code ${code} before becoming ready${
        tail.length ? '\n' + tail.join('\n') : ''}`, {
        reason: 'crash', serviceName: service.name
      });
    }
    if (signal?.aborted) {
      throw new EngineError('readiness wait aborted', {
        reason: 'aborted', serviceName: service.name
      });
    }
  }
  function timeoutError() {
    return new EngineError(`not ready after ${service.timeoutMs}ms (last check: ${detail})`, {
      reason: 'timeout', serviceName: service.name
    });
  }

  try {
    // Deliver an already-resolved exit result before the first status check.
    await Promise.resolve();
    while (true) {
      checkStopped();
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw timeoutError();
      const probeMs = Math.min(1000, service.intervalMs * 2, remaining);
      const check = service.readyCheck;
      const result = check.type === 'port'
        ? await portProbe(check.port, '127.0.0.1', probeMs, controller.signal)
        : await httpProbe(check.url, probeMs, controller.signal);
      detail = result.detail;
      // Check exit/abort again so a successful probe cannot win a shutdown race.
      checkStopped();
      const elapsed = performance.now() - started;
      if (elapsed >= service.timeoutMs) throw timeoutError();
      if (result.ok) return elapsed;
      await sleep(Math.min(service.intervalMs, deadline - performance.now()), controller.signal);
    }
  } finally {
    unsubscribeExit();
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

async function preflightPort(service) {
  if (service.readyCheck.type !== 'port') return;
  const port = service.readyCheck.port;
  if (await isPortOpen(port)) {
    throw new EngineError(`Port ${port} is already in use (is a previous run still alive? try "serviceboot down")`, {
      reason: 'spawn', serviceName: service.name
    });
  }
}

module.exports = { isPortOpen, httpOk, waitForReady, preflightPort };
