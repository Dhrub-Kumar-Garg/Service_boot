const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { ConfigError } = require('../../src/config/errors');
const { parseReadyCheck, parseConfigString, parseConfig } = require('../../src/config/parser');
const { validateRaw } = require('../../src/config/validator');

const baseDir = path.resolve('config-fixtures');
const minimal = 'version: 1\nservices:\n  api:\n    command: node app.js\n';
const rawWith = fields => ({ version: 1, services: { api: { command: 'node app.js', ...fields } } });

function expectProblem(raw, pattern) {
  const errors = validateRaw(raw);
  assert.ok(errors.some(error => pattern.test(error)), JSON.stringify(errors));
  assert.throws(() => parseConfigString(yaml.dump(raw), baseDir), error => {
    assert.ok(error instanceof ConfigError);
    assert.ok(error.errors.some(message => pattern.test(message)));
    assert.equal(error.message, error.errors.join('\n'));
    return true;
  });
}

function tempFolder(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serviceboot-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('ConfigError keeps all messages and joins them with newlines', () => {
  const error = new ConfigError(['first problem', 'second problem']);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ConfigError');
  assert.deepEqual(error.errors, ['first problem', 'second problem']);
  assert.equal(error.message, 'first problem\nsecond problem');
  assert.deepEqual(new ConfigError('one problem').errors, ['one problem']);
});

test('minimal config produces exactly the contract fields and defaults', () => {
  assert.deepEqual(parseConfigString(minimal, baseDir), {
    order: ['api'],
    services: {
      api: {
        name: 'api', command: 'node app.js', cwd: baseDir, env: {}, dependsOn: [],
        readyCheck: { type: 'none' }, timeoutMs: 30000, intervalMs: 500,
        restart: 'never', maxRetries: 3
      }
    }
  });
});

test('full config normalizes every field and applies defaults to other services', () => {
  const { services, order } = parseConfigString(`version: 1
services:
  api:
    command: node api.js
    cwd: ./backend
    env: { PORT: 3000, DEBUG: false, EMPTY: null }
    depends_on: [db]
    ready_check: http http://127.0.0.1:3000/health
    ready_timeout_ms: 10000
    ready_interval_ms: 100
    restart: on-failure
    max_retries: 0
  db:
    command: node db.js
    ready_check: port 5432
`, baseDir);
  assert.deepEqual(order, ['api', 'db']);
  assert.deepEqual(services.api, {
    name: 'api', command: 'node api.js', cwd: path.join(baseDir, 'backend'),
    env: { PORT: '3000', DEBUG: 'false', EMPTY: 'null' }, dependsOn: ['db'],
    readyCheck: { type: 'http', url: 'http://127.0.0.1:3000/health' },
    timeoutMs: 10000, intervalMs: 100, restart: 'on-failure', maxRetries: 0
  });
  assert.deepEqual(services.db, {
    name: 'db', command: 'node db.js', cwd: baseDir, env: {}, dependsOn: [],
    readyCheck: { type: 'port', port: 5432 }, timeoutMs: 30000, intervalMs: 500,
    restart: 'never', maxRetries: 3
  });
});

test('top-level config must be an object', () => {
  for (const raw of [null, [], 'text', 1, true, new Date()]) {
    expectProblem(raw, /Config must be an object/);
  }
  assert.throws(() => parseConfigString('', baseDir), ConfigError);
});

test('version must be exactly the number 1', () => {
  for (const version of [undefined, null, '1', 2, true]) {
    expectProblem({ ...rawWith({}), version }, /version must be 1/);
  }
});

test('services must be a non-empty object', () => {
  for (const services of [undefined, null, [], {}, 'api']) {
    expectProblem({ version: 1, services }, /services must be a non-empty object/);
  }
});

test('service names must contain only letters, digits, underscores, and hyphens', () => {
  for (const name of ['', 'bad name', 'api.test', 'api/one']) {
    expectProblem({ version: 1, services: { [name]: { command: 'node app.js' } } }, /invalid name/);
  }
  assert.deepEqual(validateRaw({
    version: 1, services: { 'API_1-x': { command: 'node app.js' } }
  }), []);
});

test('each service definition must be an object', () => {
  for (const service of [null, [], 'node app.js', 1]) {
    expectProblem({ version: 1, services: { api: service } }, /Service "api" must be an object/);
  }
});

test('command must be a non-empty string', () => {
  for (const command of [undefined, null, '', ' \t ', 123, []]) {
    expectProblem(rawWith({ command }), /command must be a non-empty string/);
  }
});

test('cwd must be a string when supplied', () => {
  for (const cwd of [null, 123, [], {}]) expectProblem(rawWith({ cwd }), /cwd must be a string/);
});

test('depends_on must be an array', () => {
  for (const depends_on of ['db', null, {}]) {
    expectProblem(rawWith({ depends_on }), /depends_on must be an array of strings/);
  }
});

test('depends_on entries must be strings', () => {
  expectProblem(rawWith({ depends_on: [1, null, {}] }), /depends_on entries must be strings/);
});

test('self-dependencies are rejected', () => {
  expectProblem(rawWith({ depends_on: ['api'] }), /Service "api" cannot depend on itself/);
});

test('duplicate dependencies are rejected', () => {
  const raw = rawWith({ depends_on: ['db', 'db'] });
  raw.services.db = { command: 'node db.js' };
  expectProblem(raw, /duplicate dependency "db"/);
});

test('unknown dependencies use the required error message', () => {
  const raw = rawWith({ depends_on: ['db'] });
  assert.deepEqual(validateRaw(raw), ['Service "api" depends on unknown service "db"']);
  expectProblem(raw, /^Service "api" depends on unknown service "db"$/);
});

test('inherited object properties do not count as existing dependencies', () => {
  expectProblem(rawWith({ depends_on: ['constructor', 'toString', '__proto__'] }), /unknown service/);
  assert.equal(validateRaw(rawWith({ depends_on: ['constructor', 'toString', '__proto__'] })).length, 3);
});

test('ready_check must be a valid readiness expression', () => {
  for (const ready_check of [null, 123, '', 'tcp 3000', 'port 0', 'http ftp://127.0.0.1']) {
    expectProblem(rawWith({ ready_check }), /ready_check:/);
  }
});

test('ready_timeout_ms must be a positive integer', () => {
  for (const ready_timeout_ms of [null, 0, -1, 1.5, '1000', Infinity]) {
    expectProblem(rawWith({ ready_timeout_ms }), /ready_timeout_ms must be a positive integer/);
  }
});

test('ready_interval_ms must be a positive integer', () => {
  for (const ready_interval_ms of [null, 0, -1, 1.5, '100', Infinity]) {
    expectProblem(rawWith({ ready_interval_ms }), /ready_interval_ms must be a positive integer/);
  }
});

test('readiness interval must be strictly less than timeout, including defaults', () => {
  for (const fields of [
    { ready_timeout_ms: 100, ready_interval_ms: 100 },
    { ready_timeout_ms: 100, ready_interval_ms: 101 },
    { ready_timeout_ms: 500 },
    { ready_interval_ms: 30000 }
  ]) expectProblem(rawWith(fields), /ready_interval_ms must be less than ready_timeout_ms/);
  assert.deepEqual(validateRaw(rawWith({ ready_timeout_ms: 2, ready_interval_ms: 1 })), []);
});

test('restart must be never or on-failure', () => {
  for (const restart of [null, '', 'always', 'NEVER', 1]) {
    expectProblem(rawWith({ restart }), /restart must be "never" or "on-failure"/);
  }
  for (const restart of ['never', 'on-failure']) assert.deepEqual(validateRaw(rawWith({ restart })), []);
});

test('max_retries must be an integer greater than or equal to zero', () => {
  for (const max_retries of [null, -1, 1.5, '3', Infinity]) {
    expectProblem(rawWith({ max_retries }), /max_retries must be an integer >= 0/);
  }
  for (const max_retries of [0, 3]) assert.deepEqual(validateRaw(rawWith({ max_retries })), []);
});

test('env must be an object and cannot be an array', () => {
  for (const env of [null, [], 'PORT=3000', 1, new Date()]) {
    expectProblem(rawWith({ env }), /env must be an object/);
  }
});

test('duplicate readiness ports report both service names', () => {
  const raw = rawWith({ ready_check: 'PoRt 5432' });
  raw.services.db = { command: 'node db.js', ready_check: 'port 05432' };
  const errors = validateRaw(raw);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Service "api"/);
  assert.match(errors[0], /Service "db"/);
  assert.match(errors[0], /5432/);
  expectProblem(raw, /same readiness port/);
});

test('all independent validation errors are returned together before normalization', () => {
  const raw = {
    version: 2,
    services: {
      api: {
        command: '', depends_on: ['api', 'db', 'db', 1], ready_check: 'port 0',
        cwd: 123, env: [], ready_timeout_ms: 0, ready_interval_ms: -1,
        restart: 'always', max_retries: -1
      },
      'bad name': { command: null }
    }
  };
  const errors = validateRaw(raw);
  assert.equal(errors.length, 16);
  assert.throws(() => parseConfigString(yaml.dump(raw), baseDir), error => {
    assert.ok(error instanceof ConfigError);
    assert.deepEqual(error.errors, errors);
    assert.equal(error.message, errors.join('\n'));
    return true;
  });
  assert.equal(validateRaw({}).length, 2);
});

test('YAML syntax errors include human-readable line and column information', () => {
  assert.throws(() => parseConfigString('version: 1\nservices: [\n', baseDir), error => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /YAML syntax error at line \d+, column \d+:/);
    return true;
  });
});

test('duplicate YAML keys are rejected with line information', () => {
  for (const source of [
    'version: 1\nversion: 1\nservices: {}\n',
    'version: 1\nservices:\n  api: {command: node a}\n  api: {command: node b}\n',
    'version: 1\nservices:\n  api:\n    command: node a\n    command: node b\n'
  ]) {
    assert.throws(() => parseConfigString(source, baseDir), error => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /line \d+, column \d+/);
      assert.match(error.message, /duplicated mapping key/);
      return true;
    });
  }
});

test('missing file becomes ConfigError with the required path message', t => {
  const file = path.join(tempFolder(t), 'missing.yml');
  assert.throws(() => parseConfig(file), error => {
    assert.ok(error instanceof ConfigError);
    assert.deepEqual(error.errors, [`Config file not found: ${file}`]);
    return true;
  });
});

test('unreadable file becomes ConfigError', t => {
  const file = path.join(tempFolder(t), 'serviceboot.yml');
  fs.writeFileSync(file, minimal);
  // Simulate EACCES: permission bits do not reliably deny reads on every OS.
  const originalRead = fs.readFileSync;
  const mock = t.mock.method(fs, 'readFileSync', function (name, ...args) {
    if (name === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return originalRead.call(this, name, ...args);
  });
  assert.throws(() => parseConfig(file), error => {
    assert.ok(error instanceof ConfigError);
    assert.deepEqual(error.errors, [`Config file not found: ${file}`]);
    return true;
  });
  mock.mock.restore();
});

test('parseReadyCheck accepts valid forms, whitespace, and case-insensitive keywords', () => {
  for (const [input, expected] of [
    ['none', { type: 'none' }], ['  NoNe \t', { type: 'none' }],
    ['port 1', { type: 'port', port: 1 }], ['port 65535', { type: 'port', port: 65535 }],
    ['  PoRt\t3000  ', { type: 'port', port: 3000 }],
    ['HTTP http://127.0.0.1:3000/health', { type: 'http', url: 'http://127.0.0.1:3000/health' }],
    [' http https://example.com/health ', { type: 'http', url: 'https://example.com/health' }]
  ]) assert.deepEqual(parseReadyCheck(input), expected);
});

test('parseReadyCheck rejects invalid forms with plain descriptive Errors', () => {
  for (const input of [
    undefined, null, 123, {}, '', 'none extra', 'port', 'port 0', 'port 65536',
    'port -1', 'port 1.5', 'port 1e3', 'port 12junk', 'port 3000 extra',
    'http', 'http ftp://127.0.0.1', 'http //127.0.0.1', 'http http://',
    'http http://127.0.0.1/a b', 'tcp 3000'
  ]) {
    assert.throws(() => parseReadyCheck(input), error => {
      assert.equal(error.constructor, Error);
      assert.ok(error.message.length > 10);
      return true;
    });
  }
});

test('relative cwd resolves against the config file folder', t => {
  const directory = tempFolder(t);
  const file = path.join(directory, 'serviceboot.yml');
  fs.writeFileSync(file, `${minimal}    cwd: ./backend\n`);
  const { services } = parseConfig(path.relative(process.cwd(), file));
  assert.equal(services.api.cwd, path.join(directory, 'backend'));
  assert.ok(path.isAbsolute(services.api.cwd));
});

test('default and empty cwd resolve to the config folder; absolute cwd remains absolute', t => {
  const directory = tempFolder(t);
  const file = path.join(directory, 'serviceboot.yml');
  fs.writeFileSync(file, minimal);
  assert.equal(parseConfig(file).services.api.cwd, directory);
  assert.equal(parseConfigString(yaml.dump(rawWith({ cwd: '' })), directory).services.api.cwd, directory);
  const absolute = path.join(directory, 'backend');
  assert.equal(parseConfigString(yaml.dump(rawWith({ cwd: absolute })), baseDir).services.api.cwd, absolute);
});

test('env numbers become strings without altering the raw object', () => {
  const raw = rawWith({ env: { PORT: 3000, COUNT: 0 } });
  assert.deepEqual(validateRaw(raw), []);
  assert.equal(raw.services.api.env.PORT, 3000);
  assert.deepEqual(parseConfigString(yaml.dump(raw), baseDir).services.api.env, { PORT: '3000', COUNT: '0' });
});

test('declaration order is preserved rather than alphabetically sorted', () => {
  const { order } = parseConfigString(`version: 1
services:
  zebra: {command: node z}
  api: {command: node a}
  db: {command: node d}
`, baseDir);
  assert.deepEqual(order, ['zebra', 'api', 'db']);
});

test('numeric service names preserve YAML declaration order in block and flow mappings', () => {
  for (const source of [
    'version: 1\nservices:\n  10: {command: node a}\n  2: {command: node b}\n',
    'version: 1\nservices: {10: {command: node a}, 2: {command: node b}}\n'
  ]) assert.deepEqual(parseConfigString(source, baseDir).order, ['10', '2']);
});

test('YAML aliases and merges retain services and declaration order', () => {
  const { services, order } = parseConfigString(`version: 1
shared: &shared
  10: {command: node a}
  2: {command: node b}
services:
  api: &api {command: node api}
  copy: *api
  <<: *shared
  db: {command: node db}
`, baseDir);
  assert.deepEqual(order, ['api', 'copy', '10', '2', 'db']);
  assert.equal(services.copy.name, 'copy');
  assert.equal(services.copy.command, 'node api');
  assert.equal(services['10'].command, 'node a');
});

test('special object property names are safe service and environment keys', () => {
  const { services, order } = parseConfigString(`version: 1
services:
  __proto__:
    command: node a
    env: {__proto__: 42, constructor: 7}
  constructor:
    command: node b
    depends_on: [__proto__]
`, baseDir);
  assert.deepEqual(order, ['__proto__', 'constructor']);
  assert.ok(Object.hasOwn(services, '__proto__'));
  assert.equal(services.__proto__.env.__proto__, '42');
  assert.equal(services.__proto__.env.constructor, '7');
  assert.equal(Object.getPrototypeOf(services), Object.prototype);
  assert.equal(Object.getPrototypeOf(services.__proto__.env), Object.prototype);
});

test('multi-service cycles are left for Phase 3 graph validation', () => {
  const source = `version: 1
services:
  api: {command: node a, depends_on: [db]}
  db: {command: node b, depends_on: [api]}
`;
  assert.deepEqual(validateRaw(yaml.load(source)), []);
  assert.deepEqual(parseConfigString(source, baseDir).order, ['api', 'db']);
});
