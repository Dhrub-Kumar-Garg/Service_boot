const fs = require('node:fs');
const path = require('node:path');

let serial = 0;
const location = cwd => path.join(cwd, '.serviceboot', 'pids.json');

function validate(record) {
  const pid = value => Number.isSafeInteger(value) && value > 0;
  if (!record || !pid(record.cliPid) || typeof record.startedAt !== 'string' ||
      typeof record.config !== 'string' || !Array.isArray(record.services) ||
      record.services.some(service => !service || typeof service.name !== 'string' ||
        !pid(service.pid) || !Number.isInteger(service.level) || service.level < 0)) {
    throw new Error('Invalid ServiceBoot pid file');
  }
  return record;
}

function read({ cwd = process.cwd() } = {}) {
  try {
    return validate(JSON.parse(withRetry(() => fs.readFileSync(location(cwd), 'utf8'))));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Windows refuses to replace a file while another process has it open (for
// example `down`, or a test, reading pids.json at that instant): rename fails
// with EPERM/EACCES/EBUSY. The lock lasts only microseconds, so retry briefly.
// On POSIX rename replaces an open file atomically and never takes this path.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pauseSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withRetry(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= 40) throw error;
      pauseSync(Math.min(5 + attempt * 5, 50)); // about 1.5 s in total at most
    }
  }
}

function renameWithRetry(from, to) {
  withRetry(() => fs.renameSync(from, to));
}

function write(record, { cwd = process.cwd() } = {}) {
  const data = validate({ cliPid: process.pid, startedAt: new Date().toISOString(),
    config: '', services: [], ...record });
  const file = location(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${++serial}.tmp`;
  try {
    // A reader sees the previous complete JSON or the new complete JSON. The
    // temporary file is in the same directory so rename stays on one filesystem.
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameWithRetry(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return data;
}

function addService({ name, pid, level }, { cwd = process.cwd(), cliPid = process.pid } = {}) {
  const record = read({ cwd });
  if (!record || record.cliPid !== cliPid) throw new Error('ServiceBoot pid file ownership changed');
  const services = record.services.filter(service => service.name !== name);
  services.push({ name, pid, level });
  return write({ ...record, services }, { cwd });
}

function remove({ cwd = process.cwd(), cliPid } = {}) {
  // An old CLI must never delete the file of a newer run in the same directory.
  if (cliPid !== undefined && read({ cwd })?.cliPid !== cliPid) return false;
  try {
    fs.unlinkSync(location(cwd));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = { write, addService, read, remove };
