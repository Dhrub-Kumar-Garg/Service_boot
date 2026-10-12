// Fill release documentation only from saved, executed-command evidence.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = __dirname;
const read = name => fs.readFileSync(path.join(directory, name), 'utf8').replace(/\r\n/g, '\n').trim();
const lines = name => read(name).split('\n');
const first = (name, prefix) => {
  const result = lines(name).find(line => line.startsWith(prefix));
  assert.ok(result, `Missing real line: ${prefix} in ${name}`);
  return result;
};
const tap = name => {
  const text = read(name);
  const values = Object.fromEntries([...text.matchAll(/^# (tests|pass|fail|cancelled|skipped|duration_ms) ([\d.]+)$/gm)]
    .map(match => [match[1], Number(match[2])]));
  assert.equal(values.fail, 0, name);
  assert.equal(values.cancelled, 0, name);
  assert.equal(values.tests, values.pass + values.skipped, name);
  assert.ok(!/^not ok|(?:^| )Warning:|ERR_UNHANDLED_REJECTION/m.test(text), name);
  return values;
};

const stability = ['| Round | Unit: pass / skip; TAP ms | Engine: pass / skip; TAP ms | Exit codes; remaining processes |',
  '| --- | --- | --- | --- |'];
for (let round = 1; round <= 5; round++) {
  const unit = tap(`p2-release-${round}-unit.txt`);
  const engine = tap(`p2-release-${round}-engine.txt`);
  stability.push(`| ${round} | ${unit.pass} / ${unit.skipped}; ${unit.duration_ms} | ${engine.pass} / ${engine.skipped}; ${engine.duration_ms} | 0 / 0; 0 after both |`);
}
const summaries = lines('p2-release-stability-summary.txt').slice(1);
assert.equal(summaries.length, 10);
assert.ok(summaries.every(line => /exit=0 .*remainingTestOrMockProcesses=0 pidFilePresent=False$/.test(line)));

const cases = ['wide-sequential', 'wide-parallel', 'wide-adaptive', 'linear-adaptive', 'small-adaptive'];
const measurements = cases.map(name => {
  const ready = first(`p2-release-${name}.txt`, 'Ready:');
  const match = /algorithm=(\w+), effectiveAlgorithm=(\w+), totalMs=([\d.]+)/.exec(ready);
  assert.ok(match);
  return { name, ready, algorithm: match[1], effective: match[2], total: Number(match[3]), raw: match[3] };
});
const timingTable = ['| Sample / request | Effective algorithm | Real totalMs |', '| --- | --- | --- |',
  ...measurements.map(value => `| ${value.name} | ${value.effective} | ${value.raw} |`)].join('\n');
const sequential = measurements[0].total;
const parallel = measurements[1].total;
assert.ok(parallel < sequential * 0.6, 'wide parallel must be clearly faster');
assert.equal(measurements[2].effective, 'parallel');
assert.equal(measurements[3].effective, 'sequential');
assert.equal(measurements[4].effective, 'sequential');
const speed = `Calculated from these real runs: parallel was ${(sequential / parallel).toFixed(3)}× faster with ${(100 * (1 - parallel / sequential)).toFixed(3)}% lower startup time. These are individual CLI startup measurements.`;

const fields = [
  ['run:start', 'algorithm,total', 'wide-adaptive'],
  ['adaptive:decision', 'width,depth,chosen,reason', 'wide-adaptive'],
  ['service:starting', 'name,pid,level', 'wide-adaptive'],
  ['service:log', "name,stream:'stdout'|'stderr',line", 'wide-adaptive'],
  ['service:ready', 'name,pid,ms', 'wide-adaptive'],
  ['service:failed', 'name,reason:spawn/timeout/crash,error', 'startup-crash'],
  ['service:exited', 'name,code,signal', 'wide-adaptive'],
  ['run:done', 'algorithm,effectiveAlgorithm,totalMs', 'wide-adaptive'],
  ['run:failed', 'error', 'startup-crash'],
  ['service:restarting', 'name,attempt,maxRetries,code,signal', 'restart-events']
];
const eventRows = fields.map(([event, payload, source]) => {
  const captured = first(`p2-release-${source}.txt`, `${event} `);
  return `| ${event} | ${payload.replace(/\|/g, '\\|')} | \`${captured.replace(/\|/g, '\\|')}\` |`;
}).join('\n');
const exampleText = fields.map(([event, payload, source]) => `${source}: ${first(`p2-release-${source}.txt`, `${event} `)}`).join('\n');
fs.writeFileSync(path.join(directory, 'p2-release-event-examples.txt'), `${exampleText}\n`);

const independent = tap('p2-release-independent-files.txt');
assert.match(read('p2-release-independent-summary.txt'), /independentFiles=18 exit=0 remainingTestOrMockProcesses=0 pidFilePresent=False/);
const debug = tap('p2-release-debug-tests.txt');
const mock = read('p2-release-debug-mock.txt');
const finalChecks = read('p2-release-final-orphans.txt');
assert.match(finalChecks, /remainingMockOrCliProcesses=0 pidFilePresent=False/);

const replacements = {
  QUICK_OUTPUT: [read('p2-release-plan-wide.txt'), measurements[2].ready,
    first('p2-release-small-default.txt', 'Ready:'), read('p2-release-idle-down.txt')].join('\n'),
  TIMING_TABLE: timingTable,
  SPEED_COMPARISON: speed,
  STABILITY_TABLE: stability.join('\n'),
  STABILITY_CONCLUSION: 'All ten commands exited 0 on their own. No flaky test, warning or unhandled rejection was observed; no test/CLI/mock process or PID file remained after any suite. No engine/test changes or timing-bound changes were needed.',
  INDEPENDENT_FILES: `A separate child-process check ran all 18 test files independently: ${independent.tests} tests, ${independent.pass} passes, ${independent.skipped} POSIX skips, zero failures. All files finished naturally, with no remaining test processes. See [file list](verification/p2-release-independent-file-list.txt), [full output](verification/p2-release-independent-files.txt) and [completion check](verification/p2-release-independent-summary.txt).`,
  EVENT_ROWS: eventRows,
  RELEASE_FLAKES: 'No flaky test was observed in the five release rounds or independent-file run. Earlier Phase 6 investigations remain in verification/engine-phase6-*.txt; the release evidence here is separate.',
  DRILL_RESULTS: [first('p2-release-startup-kill.txt', 'ACTION:'), first('p2-release-startup-kill.txt', 'EXIT [down after hard kill]:'),
    first('p2-release-startup-crash.txt', 'service:failed crash'), first('p2-release-startup-crash.txt', 'EXIT [startup crash up]:'),
    first('p2-release-busy-port.txt', 'error:'), first('p2-release-busy-port.txt', 'EXIT [busy port up]:'),
    ...lines('p2-release-drill-summary.txt').slice(1)].join('\n'),
  DEBUG_RESULTS: [`Selected test result: tests=${debug.tests} pass=${debug.pass} fail=${debug.fail} skipped=${debug.skipped} duration_ms=${debug.duration_ms}`, mock].join('\n'),
  FINAL_ORPHANS: `Final real inspection: \`${finalChecks}\`. No matching rows were returned.`
};
const file = path.join(directory, '../02-person2-to-person3.md');
let document = fs.readFileSync(file, 'utf8');
const hasDraftMarkers = /@@\w+@@/.test(document);
if (hasDraftMarkers) {
  for (const [key, value] of Object.entries(replacements)) {
    const marker = `@@${key}@@`;
    assert.ok(document.includes(marker), `Missing draft marker ${marker}`);
    document = document.replace(marker, value);
  }
  fs.writeFileSync(file, document);
}
assert.ok(!/@@\w+@@/.test(document));
assert.ok(document.includes(timingTable), 'Handover timings must match real transcripts');
assert.ok(document.includes(stability.join('\n')), 'Handover test results must match real transcripts');
assert.ok(document.includes(eventRows), 'Handover events must match real transcripts');
for (const match of document.matchAll(/\]\(([^)]+)\)/g)) {
  assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[1])), `Missing handover link: ${match[1]}`);
}
console.log(stability.join('\n'));
console.log(timingTable);
console.log(speed);
console.log(`Handover ${hasDraftMarkers ? 'filled' : 'verified'} from executed-command transcripts; all ten event examples are real; linked files exist.`);
