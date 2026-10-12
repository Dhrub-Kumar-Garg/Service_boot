const { parseReadyCheck } = require('./parser');

function isObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function validateRaw(rawObject) {
  const errors = [];
  if (!isObject(rawObject)) return ['Config must be an object'];

  if (rawObject.version !== 1) errors.push('Config version must be 1');
  if (!isObject(rawObject.services) || Object.keys(rawObject.services).length === 0) {
    errors.push('Config services must be a non-empty object');
    return errors;
  }

  const services = rawObject.services;
  const ports = new Map();
  for (const [name, service] of Object.entries(services)) {
    const prefix = `Service "${name}"`;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      errors.push(`${prefix} has an invalid name (use letters, digits, underscores, or hyphens)`);
    }
    if (!isObject(service)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }
    if (typeof service.command !== 'string' || !service.command.trim()) {
      errors.push(`${prefix} command must be a non-empty string`);
    }
    if (service.cwd !== undefined && typeof service.cwd !== 'string') {
      errors.push(`${prefix} cwd must be a string`);
    }

    if (service.depends_on !== undefined) {
      if (!Array.isArray(service.depends_on)) {
        errors.push(`${prefix} depends_on must be an array of strings`);
      } else {
        const seen = new Set();
        for (const dependency of service.depends_on) {
          if (typeof dependency !== 'string') {
            errors.push(`${prefix} depends_on entries must be strings`);
            continue;
          }
          if (dependency === name) errors.push(`${prefix} cannot depend on itself`);
          if (seen.has(dependency)) {
            errors.push(`${prefix} has duplicate dependency "${dependency}"`);
          }
          seen.add(dependency);
          if (!Object.hasOwn(services, dependency)) {
            errors.push(`${prefix} depends on unknown service "${dependency}"`);
          }
        }
      }
    }

    if (service.ready_check !== undefined) {
      try {
        const check = parseReadyCheck(service.ready_check);
        if (check.type === 'port') {
          if (ports.has(check.port)) {
            errors.push(`${prefix} and Service "${ports.get(check.port)}" use the same readiness port ${check.port}`);
          } else {
            ports.set(check.port, name);
          }
        }
      } catch (error) {
        errors.push(`${prefix} ready_check: ${error.message}`);
      }
    }

    const timeout = service.ready_timeout_ms === undefined ? 30000 : service.ready_timeout_ms;
    const interval = service.ready_interval_ms === undefined ? 500 : service.ready_interval_ms;
    if (!positiveInteger(timeout)) {
      errors.push(`${prefix} ready_timeout_ms must be a positive integer`);
    }
    if (!positiveInteger(interval)) {
      errors.push(`${prefix} ready_interval_ms must be a positive integer`);
    }
    // Compare effective values so omitted fields still obey the timing rule.
    if (positiveInteger(timeout) && positiveInteger(interval) && interval >= timeout) {
      errors.push(`${prefix} ready_interval_ms must be less than ready_timeout_ms`);
    }

    if (service.restart !== undefined && !['never', 'on-failure'].includes(service.restart)) {
      errors.push(`${prefix} restart must be "never" or "on-failure"`);
    }
    if (service.max_retries !== undefined &&
        (!Number.isInteger(service.max_retries) || service.max_retries < 0)) {
      errors.push(`${prefix} max_retries must be an integer >= 0`);
    }
    if (service.env !== undefined && !isObject(service.env)) {
      errors.push(`${prefix} env must be an object (not an array)`);
    }
  }
  return errors;
}

module.exports = { validateRaw };
