const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConfigError } = require('../../src/config/errors');
const { buildGraph, detectCycle } = require('../../src/graph/dag');
const { topoLevels, flatten } = require('../../src/graph/topo');
const { analyze } = require('../../src/graph/adaptive');
const { loadPlan } = require('../../src/plan');

const sequentialReason = 'Width (W) <= Depth (D) x 2. Graph is small or mostly linear. Auto-selecting SEQUENTIAL execution to save concurrency overhead.';
const parallelReason = 'Width (W) > Depth (D) x 2. High independent concurrency detected. Auto-selecting PARALLEL execution.';

function servicesFrom(entries) {
  return Object.fromEntries(entries.map(([name, dependsOn]) => [name, { name, dependsOn }]));
}

function assertCycle(services, expected) {
  assert.deepEqual(detectCycle(services), expected);
  assert.throws(() => topoLevels(services, Object.keys(services)), error => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.name, 'ConfigError');
    assert.deepEqual(error.errors, [`Circular dependency detected: ${expected.join(' -> ')}`]);
    assert.equal(error.message, error.errors[0]);
    return true;
  });
}

function configFile(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-plan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'serviceboot.yml');
  fs.writeFileSync(file, source);
  return file;
}

test('buildGraph creates both adjacency maps including empty lists', () => {
  const services = servicesFrom([
    ['a', []], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']], ['alone', []]
  ]);
  assert.deepEqual(buildGraph(services), {
    dependsOn: { a: [], b: ['a'], c: ['a'], d: ['b', 'c'], alone: [] },
    dependents: { a: ['b', 'c'], b: ['d'], c: ['d'], d: [], alone: [] }
  });
});

test('graph functions accept frozen inputs and do not mutate service dependencies', () => {
  const services = servicesFrom([['a', []], ['b', ['a']], ['c', ['a']]]);
  for (const service of Object.values(services)) {
    Object.freeze(service.dependsOn);
    Object.freeze(service);
  }
  Object.freeze(services);
  const order = Object.freeze(['a', 'b', 'c']);
  const graph = buildGraph(services);
  graph.dependsOn.b.push('c');
  assert.deepEqual(services.b.dependsOn, ['a']);
  assert.deepEqual(topoLevels(services, order), [['a'], ['b', 'c']]);
  assert.equal(detectCycle(services), null);
});

test('independent services produce one level in declaration order', () => {
  const services = servicesFrom([['z', []], ['a', []], ['m', []]]);
  assert.deepEqual(topoLevels(services, ['z', 'a', 'm']), [['z', 'a', 'm']]);
});

test('linear chain a to b to c to d produces four levels', () => {
  const services = servicesFrom([['a', []], ['b', ['a']], ['c', ['b']], ['d', ['c']]]);
  assert.deepEqual(topoLevels(services, ['a', 'b', 'c', 'd']), [['a'], ['b'], ['c'], ['d']]);
});

test('diamond graph groups b and c together before d', () => {
  const services = servicesFrom([['a', []], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]]);
  assert.deepEqual(topoLevels(services, ['a', 'b', 'c', 'd']), [['a'], ['b', 'c'], ['d']]);
});

test('longest-path rule places x after its deepest dependency', () => {
  const services = servicesFrom([['x', ['a', 'b']], ['b', ['a']], ['a', []]]);
  assert.deepEqual(topoLevels(services, ['x', 'b', 'a']), [['a'], ['b'], ['x']]);
});

test('level declaration order wins over the order nodes become unblocked', () => {
  const services = servicesFrom([
    ['rootA', []], ['rootB', []], ['z', ['rootB']], ['a', ['rootA']]
  ]);
  assert.deepEqual(topoLevels(services, ['rootA', 'rootB', 'z', 'a']), [
    ['rootA', 'rootB'], ['z', 'a']
  ]);
});

test('explicit declaration order is respected for numeric service names', () => {
  const services = servicesFrom([['10', []], ['2', []], ['1', ['10', '2']]]);
  assert.deepEqual(topoLevels(services, ['10', '2', '1']), [['10', '2'], ['1']]);
});

test('two-node cycle reports the closed dependency path', () => {
  assertCycle(servicesFrom([['a', ['b']], ['b', ['a']]]), ['a', 'b', 'a']);
});

test('three-node cycle reports the closed dependency path', () => {
  assertCycle(servicesFrom([['a', ['b']], ['b', ['c']], ['c', ['a']]]), ['a', 'b', 'c', 'a']);
});

test('cycle hidden behind a valid branch excludes the non-cyclic entry path', () => {
  const services = servicesFrom([
    ['valid', []], ['leaf', ['valid']], ['entry', ['a']], ['a', ['b']], ['b', ['a']]
  ]);
  assertCycle(services, ['a', 'b', 'a']);
});

test('DFS chooses the first cycle in service declaration order', () => {
  const services = servicesFrom([
    ['z', ['y']], ['y', ['z']], ['a', ['b']], ['b', ['a']]
  ]);
  assertCycle(services, ['z', 'y', 'z']);
});

test('DFS visits dependency neighbours in service declaration order', () => {
  const services = servicesFrom([['a', ['c', 'b']], ['b', ['a']], ['c', ['a']]]);
  assertCycle(services, ['a', 'b', 'a']);
});

test('cycle diagnostics use explicit order for numeric service names', () => {
  const services = servicesFrom([['10', ['2']], ['2', ['10']]]);
  assert.throws(() => topoLevels(services, ['10', '2']), error => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.message, 'Circular dependency detected: 10 -> 2 -> 10');
    return true;
  });
});

test('detectCycle returns null for acyclic graphs with shared dependencies', () => {
  const services = servicesFrom([
    ['d', ['b', 'c']], ['b', ['a']], ['c', ['a']], ['a', []], ['independent', []]
  ]);
  assert.equal(detectCycle(services), null);
});

test('detectCycle handles a self-loop even when called without config validation', () => {
  assertCycle(servicesFrom([['a', ['a']]]), ['a', 'a']);
});

test('DFS and Kahn handle a deep graph without recursive call-stack overflow', () => {
  const size = 10000;
  const entries = Array.from({ length: size }, (_, i) => [
    `n${i}`, i === size - 1 ? [] : [`n${i + 1}`]
  ]);
  const services = servicesFrom(entries);
  const order = entries.map(([name]) => name);
  assert.equal(detectCycle(services), null);
  const groups = topoLevels(services, order);
  assert.equal(groups.length, size);
  assert.deepEqual(groups[0], [`n${size - 1}`]);
  assert.deepEqual(groups[size - 1], ['n0']);

  services[`n${size - 1}`].dependsOn.push('n0');
  const cycle = detectCycle(services);
  assert.equal(cycle.length, size + 1);
  assert.equal(cycle[0], 'n0');
  assert.equal(cycle[size], 'n0');
});

test('empty graphs produce empty maps, no cycle, and no levels', () => {
  assert.deepEqual(buildGraph({}), { dependsOn: {}, dependents: {} });
  assert.equal(detectCycle({}), null);
  assert.deepEqual(topoLevels({}, []), []);
});

test('special object property names remain safe in both graph maps', () => {
  const services = servicesFrom([
    ['__proto__', []], ['constructor', ['__proto__']], ['toString', ['constructor']]
  ]);
  const graph = buildGraph(services);
  assert.ok(Object.hasOwn(graph.dependsOn, '__proto__'));
  assert.ok(Object.hasOwn(graph.dependents, '__proto__'));
  assert.deepEqual(graph.dependents.__proto__, ['constructor']);
  assert.equal(Object.getPrototypeOf(graph.dependsOn), Object.prototype);
  assert.equal(Object.getPrototypeOf(graph.dependents), Object.prototype);
  assert.equal(detectCycle(services), null);
  assert.deepEqual(topoLevels(services, ['__proto__', 'constructor', 'toString']), [
    ['__proto__'], ['constructor'], ['toString']
  ]);
});

test('adaptive boundary width equal to twice depth selects sequential with exact reason', () => {
  assert.deepEqual(analyze([['a', 'b', 'c', 'd'], ['e']]), {
    depth: 2, width: 4, total: 5, chosen: 'sequential', reason: sequentialReason
  });
});

test('adaptive width one above twice depth selects parallel with exact reason', () => {
  assert.deepEqual(analyze([['a', 'b', 'c', 'd', 'e'], ['f']]), {
    depth: 2, width: 5, total: 6, chosen: 'parallel', reason: parallelReason
  });
});

test('adaptive single service selects sequential', () => {
  assert.deepEqual(analyze([['a']]), {
    depth: 1, width: 1, total: 1, chosen: 'sequential', reason: sequentialReason
  });
});

test('adaptive linear graph selects sequential', () => {
  const services = servicesFrom([['a', []], ['b', ['a']], ['c', ['b']], ['d', ['c']]]);
  assert.deepEqual(analyze(topoLevels(services, ['a', 'b', 'c', 'd'])), {
    depth: 4, width: 1, total: 4, chosen: 'sequential', reason: sequentialReason
  });
});

test('adaptive eight roots plus two dependents selects parallel', () => {
  const roots = Array.from({ length: 8 }, (_, i) => `r${i}`);
  const services = servicesFrom([
    ...roots.map(name => [name, []]), ['api', ['r0', 'r1']], ['worker', ['r6', 'r7']]
  ]);
  const groups = topoLevels(services, [...roots, 'api', 'worker']);
  assert.deepEqual(groups, [roots, ['api', 'worker']]);
  assert.deepEqual(analyze(groups), {
    depth: 2, width: 8, total: 10, chosen: 'parallel', reason: parallelReason
  });
});

test('adaptive empty groups select sequential with zero dimensions', () => {
  assert.deepEqual(analyze([]), {
    depth: 0, width: 0, total: 0, chosen: 'sequential', reason: sequentialReason
  });
});

test('flatten concatenates levels in order and does not mutate them', () => {
  const groups = Object.freeze([
    Object.freeze(['z', 'a']), Object.freeze(['b', 'c']), Object.freeze(['d'])
  ]);
  assert.deepEqual(flatten(groups), ['z', 'a', 'b', 'c', 'd']);
  assert.deepEqual(flatten([]), []);
  assert.deepEqual(flatten([[], ['a'], []]), ['a']);
});

test('loadPlan returns the complete contract object from a temp YAML file', t => {
  const file = configFile(t, `version: 1
services:
  api:
    command: node api.js
    cwd: ./backend
    env: { PORT: 3000 }
    depends_on: [db, cache]
    ready_check: http http://127.0.0.1:3000/health
    ready_timeout_ms: 10000
    ready_interval_ms: 100
    restart: on-failure
    max_retries: 2
  db:
    command: node db.js
    ready_check: port 5432
  cache:
    command: node cache.js
`);
  const directory = path.dirname(file);
  assert.deepEqual(loadPlan(file), {
    services: {
      api: {
        name: 'api', command: 'node api.js', cwd: path.join(directory, 'backend'),
        env: { PORT: '3000' }, dependsOn: ['db', 'cache'],
        readyCheck: { type: 'http', url: 'http://127.0.0.1:3000/health' },
        timeoutMs: 10000, intervalMs: 100, restart: 'on-failure', maxRetries: 2
      },
      db: {
        name: 'db', command: 'node db.js', cwd: directory, env: {}, dependsOn: [],
        readyCheck: { type: 'port', port: 5432 }, timeoutMs: 30000, intervalMs: 500,
        restart: 'never', maxRetries: 3
      },
      cache: {
        name: 'cache', command: 'node cache.js', cwd: directory, env: {}, dependsOn: [],
        readyCheck: { type: 'none' }, timeoutMs: 30000, intervalMs: 500,
        restart: 'never', maxRetries: 3
      }
    },
    order: ['api', 'db', 'cache'], groups: [['db', 'cache'], ['api']],
    analysis: { depth: 2, width: 2, total: 3, chosen: 'sequential', reason: sequentialReason }
  });
});

test('loadPlan preserves numeric YAML service declaration order through planning', t => {
  const file = configFile(t, `version: 1
services:
  10: {command: node a}
  2: {command: node b}
  1: {command: node c, depends_on: ['10', '2']}
`);
  const plan = loadPlan(file);
  assert.deepEqual(plan.order, ['10', '2', '1']);
  assert.deepEqual(plan.groups, [['10', '2'], ['1']]);
});

test('loadPlan propagates cycle diagnostics as ConfigError', t => {
  const file = configFile(t, `version: 1
services:
  a: {command: node a, depends_on: [b]}
  b: {command: node b, depends_on: [c]}
  c: {command: node c, depends_on: [a]}
`);
  assert.throws(() => loadPlan(file), error => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.message, 'Circular dependency detected: a -> b -> c -> a');
    return true;
  });
});

test('loadPlan propagates config validation and missing-file errors', t => {
  const file = configFile(t, 'version: 1\nservices:\n  api: {command: node api, depends_on: [db]}\n');
  assert.throws(() => loadPlan(file), error => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.message, 'Service "api" depends on unknown service "db"');
    return true;
  });
  assert.throws(() => loadPlan(path.join(path.dirname(file), 'missing.yml')), ConfigError);
});
