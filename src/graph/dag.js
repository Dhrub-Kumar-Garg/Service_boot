function buildGraph(services) {
  const names = Object.keys(services);
  const dependsOn = Object.fromEntries(names.map(name => [name, [...services[name].dependsOn]]));
  const dependents = Object.fromEntries(names.map(name => [name, []]));

  for (const name of names) {
    for (const dependency of dependsOn[name]) dependents[dependency].push(name);
  }
  return { dependsOn, dependents };
}

function detectCycle(services, order = Object.keys(services)) {
  // topoLevels supplies the parser's explicit order, including numeric names.
  const rank = new Map(order.map((name, index) => [name, index]));
  const neighbours = new Map(order.map(name => [name, [...services[name].dependsOn]
    .sort((a, b) => rank.get(a) - rank.get(b))]));
  const colours = new Map(order.map(name => [name, 'white']));

  for (const root of order) {
    if (colours.get(root) !== 'white') continue;
    const stack = [{ name: root, next: 0 }];
    colours.set(root, 'grey');

    // The stack is the current DFS path. Explicit frames avoid call-stack
    // overflow for long chains while retaining white/grey/black colouring.
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const dependencies = neighbours.get(frame.name);
      if (frame.next === dependencies.length) {
        colours.set(frame.name, 'black');
        stack.pop();
        continue;
      }

      const dependency = dependencies[frame.next++];
      if (colours.get(dependency) === 'grey') {
        // A grey node is still on this path: the edge back to it closes a cycle.
        const start = stack.findIndex(entry => entry.name === dependency);
        return [...stack.slice(start).map(entry => entry.name), dependency];
      }
      if (colours.get(dependency) === 'white') {
        colours.set(dependency, 'grey');
        stack.push({ name: dependency, next: 0 });
      }
    }
  }
  return null;
}

module.exports = { buildGraph, detectCycle };
