const { ConfigError } = require('../config/errors');
const { buildGraph, detectCycle } = require('./dag');

function topoLevels(services, order = Object.keys(services)) {
  const { dependsOn, dependents } = buildGraph(services);
  const remaining = new Map(order.map(name => [name, dependsOn[name].length]));
  const rank = new Map(order.map((name, index) => [name, index]));
  const groups = [];
  let level = order.filter(name => remaining.get(name) === 0);
  let processed = 0;

  while (level.length) {
    groups.push(level);
    processed += level.length;
    const nextLevel = [];
    for (const name of level) {
      for (const dependent of dependents[name]) {
        const count = remaining.get(dependent) - 1;
        remaining.set(dependent, count);
        if (count === 0) nextLevel.push(dependent);
      }
    }
    // Newly freed nodes wait for the next level, so a service lands one level
    // after its deepest dependency. Discovery order can differ from declaration
    // order, so sort each new level using the original declaration positions.
    level = nextLevel.sort((a, b) => rank.get(a) - rank.get(b));
  }

  if (processed !== order.length) {
    const cycle = detectCycle(services, order);
    throw new ConfigError([`Circular dependency detected: ${cycle.join(' -> ')}`]);
  }
  return groups;
}

function flatten(groups) {
  return groups.flat();
}

module.exports = { topoLevels, flatten };
