const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { formatEvent, chooseMode, createRenderer, createPrettyRenderer, EVENTS } = require('../../src/cli/ui');

function fakeStream(isTTY = true) {
  const chunks = [];
  return { isTTY, chunks, write(chunk) { chunks.push(chunk); return true; }, text() { return chunks.join(''); } };
}

const plan = { order: ['db', 'api'], groups: [['db'], ['api']] };

function drive(emitter) {
  emitter.emit('run:start', { algorithm: 'adaptive', total: 2, ts: 1 });
  emitter.emit('adaptive:decision', { width: 1, depth: 2, chosen: 'sequential', reason: 'because', ts: 2 });
  emitter.emit('service:starting', { name: 'db', pid: 11, level: 0, ts: 3 });
  emitter.emit('service:log', { name: 'db', stream: 'stdout', line: 'hello\nworld', ts: 4 });
  emitter.emit('service:ready', { name: 'db', pid: 11, ms: 120, ts: 5 });
  emitter.emit('service:starting', { name: 'api', pid: 12, level: 1, ts: 6 });
  emitter.emit('service:restarting', { name: 'api', attempt: 1, maxRetries: 2, code: 1, signal: null, ts: 7 });
  emitter.emit('service:ready', { name: 'api', pid: 13, ms: 80, ts: 8 });
  emitter.emit('run:done', { algorithm: 'adaptive', effectiveAlgorithm: 'sequential', totalMs: 250, ts: 9 });
}

test('UI: formatEvent keeps the Person 2 one-line event format', () => {
  assert.equal(formatEvent('service:starting', { name: 'api', pid: 1, level: 0, ts: 2 }),
    'service:starting api pid=1 level=0 ts=2');
  assert.equal(formatEvent('service:log', { name: 'a', line: 'x\ny\rz' }), 'service:log a line=x\\ny\\rz');
  assert.equal(formatEvent('run:failed', { error: new Error('boom') }), 'run:failed error=boom');
  assert.equal(EVENTS.length, 10);
});

test('UI: plain mode unless stdout is a TTY; colour honours NO_COLOR, TERM=dumb and --no-color', () => {
  assert.deepEqual(chooseMode({ stream: { isTTY: false }, env: {} }), { pretty: false, color: false });
  assert.deepEqual(chooseMode({ stream: { isTTY: true }, env: {} }), { pretty: true, color: true });
  assert.deepEqual(chooseMode({ stream: { isTTY: true }, env: {}, plain: true }), { pretty: false, color: false });
  assert.deepEqual(chooseMode({ stream: { isTTY: true }, env: { NO_COLOR: '' } }), { pretty: true, color: false });
  assert.deepEqual(chooseMode({ stream: { isTTY: true }, env: { TERM: 'dumb' } }), { pretty: true, color: false });
  assert.deepEqual(chooseMode({ stream: { isTTY: true }, env: {}, noColor: true }), { pretty: true, color: false });
});

test('UI: plain renderer logs every event line and the Ready line, and detaches', () => {
  const lines = [];
  const emitter = new EventEmitter();
  const ui = createRenderer({ stream: { isTTY: false }, log: line => lines.push(line) });
  assert.equal(ui.mode, 'plain');
  ui.attach(emitter);
  drive(emitter);
  ui.ready({ algorithm: 'adaptive', effectiveAlgorithm: 'sequential', totalMs: 250 }, 2);
  assert.equal(lines.length, 10);
  assert.ok(lines.every(line => !/[\r\n\u001b]/.test(line)));
  assert.match(lines.at(-1), /^Ready: 2 services \(algorithm=adaptive, effectiveAlgorithm=sequential, totalMs=250\)$/);
  ui.dispose();
  for (const event of EVENTS) assert.equal(emitter.listenerCount(event), 0);
});

test('UI: skip() hides run:failed during a signal shutdown', () => {
  const lines = [];
  const emitter = new EventEmitter();
  const ui = createRenderer({ stream: { isTTY: false }, log: line => lines.push(line) });
  ui.attach(emitter, { skip: event => event === 'run:failed' });
  emitter.emit('run:failed', { error: 'aborted' });
  emitter.emit('run:start', { algorithm: 'parallel', total: 1 });
  assert.deepEqual(lines, ['run:start algorithm=parallel total=1']);
  ui.dispose();
});

test('UI: pretty renderer without colour writes whole lines, no escape codes, no timers', () => {
  const stream = fakeStream();
  const emitter = new EventEmitter();
  const ui = createPrettyRenderer({ stream, color: false });
  ui.header({ config: 'x.yml', plan, algorithm: 'adaptive', maxParallel: Infinity });
  ui.attach(emitter);
  drive(emitter);
  ui.ready({ algorithm: 'adaptive', effectiveAlgorithm: 'sequential', totalMs: 250, readyMs: { db: 120, api: 80 }, pids: { db: 11, api: 13 } }, 2);
  ui.dispose();
  const text = stream.text();
  assert.ok(!text.includes('\u001b'));
  assert.ok(stream.chunks.every(chunk => chunk.endsWith('\n')), 'each write is one complete line');
  assert.match(text, /Adaptive width=1 depth=2 → SEQUENTIAL/);
  assert.match(text, /db\s+ready in 120 ms/);
  assert.match(text, /api\s+restarting \(attempt 1\/2\) after exit code 1; backoff 500 ms/);
  assert.match(text, /hello ⏎ world/);
  assert.match(text, /All 2 services ready in 250 ms \(sequential, chosen by adaptive\)/);
});

test('UI: quiet pretty mode hides service output lines', () => {
  const stream = fakeStream();
  const emitter = new EventEmitter();
  const ui = createPrettyRenderer({ stream, color: false, showLogs: false });
  ui.attach(emitter);
  drive(emitter);
  ui.dispose();
  assert.ok(!stream.text().includes('hello'));
});

test('UI: colour mode erases and redraws the spinner around each line and clears its timer', async () => {
  const stream = fakeStream();
  const emitter = new EventEmitter();
  const ui = createPrettyRenderer({ stream, color: true });
  ui.header({ config: 'x.yml', plan, algorithm: 'parallel', maxParallel: 2 });
  ui.attach(emitter);
  emitter.emit('run:start', { algorithm: 'parallel', total: 2 });
  await new Promise(resolve => setTimeout(resolve, 200));
  emitter.emit('service:starting', { name: 'db', pid: 1, level: 0 });
  const text = stream.text();
  assert.match(text, /\u001b\[\?25l/, 'cursor hidden while animating');
  assert.match(text, /\r\u001b\[2K/, 'footer erased before a line');
  assert.match(text, /0\/2 ready/);
  emitter.emit('run:failed', { error: 'boom' });
  ui.dispose();
  assert.match(stream.text(), /\u001b\[\?25h/, 'cursor restored');
  // The test process exits on its own only if the spinner interval is gone.
});
