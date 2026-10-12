const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { freePort, makeServices, record, isAlive, waitDead } = require('../helpers');

test('freePort returns a port whose temporary listener has closed', async () => {
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

test('makeServices creates complete real Service objects and real topo levels', async () => {
  const specs = [
    { name: 'api', deps: ['db'], delay: 42, extraArgs: ['--never-ready'] },
    { name: 'db' }
  ];
  const { services, groups } = await makeServices(specs);
  assert.deepEqual(groups, [['db'], ['api']]);
  assert.deepEqual(Object.keys(services.api).sort(), [
    'name', 'command', 'cwd', 'env', 'dependsOn', 'readyCheck', 'timeoutMs',
    'intervalMs', 'restart', 'maxRetries'
  ].sort());
  assert.equal(services.api.cwd, path.resolve(__dirname, '../..'));
  assert.ok(services.api.command.startsWith('node '));
  assert.ok(services.api.command.includes(path.resolve(__dirname, '../../mock/mock-service.js')));
  assert.ok(services.api.command.includes(`--port ${services.api.readyCheck.port}`));
  assert.match(services.api.command, /--name api --delay 42 --never-ready$/);
  assert.equal(services.api.readyCheck.type, 'port');
  assert.notEqual(services.api.readyCheck.port, services.db.readyCheck.port);
  assert.equal(services.api.timeoutMs, 10000);
  assert.equal(services.api.intervalMs, 100);
  assert.equal(services.api.restart, 'never');
  assert.equal(services.api.maxRetries, 3);
  assert.deepEqual(services.api.env, {});
  assert.notEqual(services.api.dependsOn, specs[0].deps);
  assert.deepEqual(services.db.dependsOn, []);
  assert.match(services.db.command, /--delay 300$/);
});

test('record preserves event arrival indices and supports find/filter by service', () => {
  const emitter = new EventEmitter();
  const history = record(emitter);
  const payload = { name: 'api', pid: 123, ts: 1 };
  emitter.emit('run:start', { algorithm: 'parallel', total: 1, ts: 0 });
  emitter.emit('service:starting', payload);
  payload.pid = 456;
  emitter.emit('service:ready', { name: 'api', pid: 123, ms: 1, ts: 2 });
  assert.deepEqual(history.events.map(event => event.i), [0, 1, 2]);
  assert.equal(history.find('service:starting', 'api').payload.pid, 123);
  assert.equal(history.find('service:starting', 'missing'), undefined);
  assert.equal(history.filter('service:ready').length, 1);
  assert.equal(history.filter('service:ready', 'missing').length, 0);
});

test('record maxInFlight removes both ready and failed services', () => {
  const emitter = new EventEmitter();
  const history = record(emitter);
  emitter.emit('service:starting', { name: 'a' });
  emitter.emit('service:starting', { name: 'b' });
  emitter.emit('service:failed', { name: 'a' });
  emitter.emit('service:starting', { name: 'c' });
  emitter.emit('service:ready', { name: 'b' });
  emitter.emit('service:ready', { name: 'c' });
  emitter.emit('service:starting', { name: 'd' });
  assert.equal(history.maxInFlight(), 2);
});

test('isAlive and waitDead distinguish live, absent, and invalid PIDs', async () => {
  assert.equal(isAlive(process.pid), true);
  for (const pid of [0, -1, null, '123', 2147483647]) assert.equal(isAlive(pid), false);
  assert.equal(await waitDead([], 0), true);
  assert.equal(await waitDead([2147483647], 0), true);
  assert.equal(await waitDead({ current: process.pid }, 0), false);
});
