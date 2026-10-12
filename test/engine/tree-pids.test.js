const test = require('node:test');
const assert = require('node:assert/strict');
const manager = require('../../src/engine/process-manager');
const engine = require('../../src/engine');
const { waitDead } = require('../helpers');

test('TREE PIDS: discovers the shell, parent and grandchild for metrics and kills all descendants', { timeout: 15000 }, async t => {
  const source = `
    const { spawn } = require('node:child_process');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    console.log('TREE:' + process.pid + ':' + grandchild.pid);
    setInterval(() => {}, 1000);
  `;
  const encoded = Buffer.from(source).toString('base64');
  const service = { name: 'tree', command: `"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`,
    cwd: process.cwd(), env: {} };
  let family;
  const handle = await manager.spawnService(service, {
    level: 0, emit(name, event) {
      if (name === 'service:log' && event.line.startsWith('TREE:')) family = event.line.split(':').slice(1).map(Number);
    }
  });
  t.after(async () => {
    await manager.terminate(handle, { graceMs: 100 });
    assert.ok(await waitDead([handle.pid, ...(family || [])]));
  });
  const deadline = Date.now() + 5000;
  while (!family) {
    assert.ok(Date.now() < deadline, 'parent reports its grandchild PID');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(engine.getTreePids, manager.getTreePids);
  const pids = await engine.getTreePids(handle.pid);
  assert.equal(pids[0], handle.pid);
  assert.equal(new Set(pids).size, pids.length);
  for (const pid of family) assert.ok(pids.includes(pid), `tree contains descendant ${pid}: ${pids}`);
});
