const { parseArgs } = require('node:util');
const net = require('node:net');
const http = require('node:http');

function integer(value, option, min, max) {
  const number = Number(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value) ||
      !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`--${option} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function main(argv) {
  let values;
  let port;
  let delay;
  let exitAfter;
  let exitCode;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: {
        port: { type: 'string' }, name: { type: 'string', default: 'mock' },
        delay: { type: 'string', default: '0' }, http: { type: 'boolean' },
        'health-path': { type: 'string', default: '/health' },
        'exit-after': { type: 'string' }, 'exit-code': { type: 'string' },
        'never-ready': { type: 'boolean' }, 'ignore-sigterm': { type: 'boolean' }
      }
    }));
    port = integer(values.port, 'port', 1, 65535);
    // Node timers overflow beyond this limit and would run almost immediately.
    delay = integer(values.delay, 'delay', 0, 2147483647);
    if (values['exit-after'] !== undefined) {
      exitAfter = integer(values['exit-after'], 'exit-after', 0, 2147483647);
    } else if (values['exit-code'] !== undefined) {
      throw new Error('--exit-code requires --exit-after');
    }
    exitCode = integer(values['exit-code'] === undefined ? '1' : values['exit-code'], 'exit-code', 0, 255);
    if (!values.name.trim() || /[\r\n]/.test(values.name)) throw new Error('--name must be a non-empty single line');
    if (!values['health-path'].startsWith('/') || /[\s?#]/.test(values['health-path'])) {
      throw new Error('--health-path must be a URL path starting with /');
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const name = values.name;
  console.log(`[${name}] starting`);
  let server;
  let listenTimer;
  let stopping = false;
  const sockets = new Set();
  const keepAlive = setInterval(() => {}, 1000);
  // Crash timing starts now, independently of the readiness delay.
  const exitTimer = exitAfter === undefined ? undefined
    : setTimeout(() => process.exit(exitCode), exitAfter);

  function stop(signal) {
    if (signal === 'SIGTERM' && values['ignore-sigterm']) {
      console.log(`[${name}] ignoring SIGTERM`);
      return;
    }
    if (stopping) return;
    stopping = true;
    console.log(`[${name}] stopping`);
    clearTimeout(listenTimer);
    clearTimeout(exitTimer);
    clearInterval(keepAlive);
    if (server && server.listening) {
      server.close(() => process.exit(0));
      // Existing probe connections must not hold graceful shutdown open.
      for (const socket of sockets) socket.destroy();
    } else {
      process.exit(0);
    }
  }
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  if (values['never-ready']) return;
  listenTimer = setTimeout(() => {
    server = values.http ? http.createServer((request, response) => {
      const healthy = request.url.split('?')[0] === values['health-path'];
      response.writeHead(healthy ? 200 : 404, { 'Content-Type': 'text/plain' });
      response.end(healthy ? 'ok' : 'not found');
    }) : net.createServer();
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('error', error => {
      console.error(`[${name}] error: ${error.message}`);
      process.exit(1);
    });
    server.listen(port, '127.0.0.1', () => console.log(`[${name}] listening on 127.0.0.1:${port}`));
  }, delay);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
