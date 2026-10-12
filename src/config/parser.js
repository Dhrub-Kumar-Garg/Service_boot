const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { ConfigError } = require('./errors');

function parseReadyCheck(str) {
  if (typeof str !== 'string') {
    throw new Error('ready_check must be a string');
  }

  const text = str.trim();
  if (/^none$/i.test(text)) return { type: 'none' };

  const portMatch = /^port\s+(\d+)$/i.exec(text);
  if (portMatch) {
    const port = Number(portMatch[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { type: 'port', port };
    }
  }
  if (/^port\b/i.test(text)) {
    throw new Error('Port readiness check must be "port N" with an integer from 1 to 65535');
  }

  const httpMatch = /^http\s+(.+)$/i.exec(text);
  if (httpMatch) {
    const url = httpMatch[1];
    if (/^https?:\/\//i.test(url) && !/\s/.test(url)) {
      try {
        const parsed = new URL(url);
        if (parsed.hostname) return { type: 'http', url };
      } catch {
        // An allowed scheme alone does not make an address a usable URL.
      }
    }
    throw new Error('HTTP readiness check requires a valid URL starting with http:// or https://');
  }

  throw new Error('ready_check must be "none", "port N", or "http URL"');
}

function parseConfigString(yamlText, baseDir) {
  let raw;
  const mappingOrders = new WeakMap();
  const stack = [];
  try {
    raw = yaml.load(yamlText, {
      listener(event, state) {
        if (event === 'open') {
          stack.push([]);
          return;
        }
        const children = stack.pop();
        if (state.kind === 'mapping') {
          // JavaScript sorts integer-like object keys. Record YAML key order
          // while parsing so services named "10" and "2" keep declaration order.
          const keys = [];
          for (let i = 0; i < children.length; i += 2) {
            const key = String(children[i]);
            if (key === '<<') {
              // A YAML merge inserts the anchor's keys at this position.
              const sources = Array.isArray(children[i + 1])
                ? children[i + 1] : [children[i + 1]];
              for (const source of sources) {
                keys.push(...(mappingOrders.get(source) || Object.keys(source || {})));
              }
            } else {
              keys.push(key);
            }
          }
          mappingOrders.set(state.result, [...new Set(keys)]);
        }
        if (stack.length) stack[stack.length - 1].push(state.result);
      }
    });
  } catch (error) {
    const location = error.mark
      ? ` at line ${error.mark.line + 1}, column ${error.mark.column + 1}` : '';
    throw new ConfigError([`YAML syntax error${location}: ${error.reason || error.message}`]);
  }

  // Load validation after this module is initialized: validation itself uses
  // parseReadyCheck, and importing both modules eagerly would create a cycle.
  const { validateRaw } = require('./validator');
  const errors = validateRaw(raw);
  if (errors.length) throw new ConfigError(errors);

  const order = mappingOrders.get(raw.services) || Object.keys(raw.services);
  const services = Object.fromEntries(order.map(name => {
    const service = raw.services[name];
    return [name, {
      name,
      command: service.command,
      cwd: path.resolve(baseDir, service.cwd || '.'),
      env: Object.fromEntries(Object.entries(service.env || {}).map(
        ([key, value]) => [key, String(value)]
      )),
      dependsOn: service.depends_on ? [...service.depends_on] : [],
      readyCheck: parseReadyCheck(service.ready_check === undefined ? 'none' : service.ready_check),
      timeoutMs: service.ready_timeout_ms === undefined ? 30000 : service.ready_timeout_ms,
      intervalMs: service.ready_interval_ms === undefined ? 500 : service.ready_interval_ms,
      restart: service.restart === undefined ? 'never' : service.restart,
      maxRetries: service.max_retries === undefined ? 3 : service.max_retries
    }];
  }));
  return { services, order };
}

function parseConfig(filePath) {
  const absolutePath = path.resolve(filePath);
  let yamlText;
  try {
    yamlText = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    throw new ConfigError([`Config file not found: ${filePath}`]);
  }
  return parseConfigString(yamlText, path.dirname(absolutePath));
}

module.exports = { parseReadyCheck, parseConfigString, parseConfig };
