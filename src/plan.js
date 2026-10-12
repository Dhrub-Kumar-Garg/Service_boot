const { parseConfig } = require('./config/parser');
const { topoLevels } = require('./graph/topo');
const { analyze } = require('./graph/adaptive');

function loadPlan(configPath) {
  const { services, order } = parseConfig(configPath);
  const groups = topoLevels(services, order);
  return { services, order, groups, analysis: analyze(groups) };
}

module.exports = { loadPlan };
