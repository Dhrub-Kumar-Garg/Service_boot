const REASONS = {
  parallel: 'Width (W) > Depth (D) x 2. High independent concurrency detected. Auto-selecting PARALLEL execution.',
  sequential: 'Width (W) <= Depth (D) x 2. Graph is small or mostly linear. Auto-selecting SEQUENTIAL execution to save concurrency overhead.'
};

function analyze(groups) {
  const depth = groups.length;
  let width = 0;
  let total = 0;
  for (const group of groups) {
    width = Math.max(width, group.length);
    total += group.length;
  }
  // Equality deliberately selects sequential: the contract requires strict >.
  const chosen = width > depth * 2 ? 'parallel' : 'sequential';
  return { depth, width, total, chosen, reason: REASONS[chosen] };
}

module.exports = { analyze };
