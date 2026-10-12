const { performance } = require('node:perf_hooks');
const pidfile = require('./pidfile');
const processes = require('./process-manager');

async function down({ cwd = process.cwd() } = {}) {
  let record = pidfile.read({ cwd });
  if (!record) return false;
  let stopped = processes.isPidAlive(record.cliPid);
  if (stopped) {
    const deadline = performance.now() + 10000;
    await processes.requestCliStop(record.cliPid);
    while (pidfile.read({ cwd })?.cliPid === record.cliPid) {
      // A forced Windows kill cannot remove its own file. Once the CLI dies,
      // finish cleanup from its recorded service leaders instead of waiting.
      if (!processes.isPidAlive(record.cliPid)) break;
      if (performance.now() >= deadline) throw new Error('ServiceBoot did not stop within 10 seconds');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const latest = pidfile.read({ cwd });
    if (latest?.cliPid !== record.cliPid) return true;
    // A replacement may have published its PID while the stop request was
    // reaching the CLI. Recover the final record after the CLI has died.
    record = latest;
  }
  const levels = [...new Set(record.services.map(service => service.level))].sort((a, b) => b - a);
  let failure;
  for (const level of levels) {
    await Promise.all(record.services.filter(service => service.level === level).map(async service => {
      try {
        if (processes.isGroupAlive(service.pid) ||
            (await processes.getTreePids(service.pid)).some(processes.isPidAlive)) stopped = true;
        await processes.terminatePid(service.pid, { graceMs: 1000 });
      } catch (error) { if (!failure) failure = error; }
    }));
  }
  if (failure) throw failure;
  pidfile.remove({ cwd, cliPid: record.cliPid });
  return stopped;
}

module.exports = { down };
