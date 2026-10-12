GLOBAL RULES (apply to every phase):
- Read CONTRACT.md and handover/01-person1-to-person2.md first. If they conflict, CONTRACT.md wins.
  CONTRACT.md sections 1-8 are fixed. Do not change them. You may ADD a section
  "## 9. Additions by Person 2" for anything new and must list it in my handover.
- Node 18+, CommonJS, NO new dependencies (built-ins only: child_process, net, http, events,
  perf_hooks, fs, path, os).
- Do NOT edit test/engine/engine.contract.test.js or test/helpers/*. If you believe a test is wrong,
  STOP and show me evidence.
- New tests: test/unit/engine-*.test.js (fast) or test/engine/*.test.js (process-based).
  `npm test` must always stay green.
- Cross-platform (Windows/macOS/Linux). Branch on process.platform ONLY inside
  src/engine/process-manager.js.
- Comment each OS concept in plain English where it is used (process groups, signals, sockets, ...);
  I must explain it in a viva.
- No leaked handles: every timer/socket/listener cleaned up so test processes exit on their own.
- NEVER claim something works without running it. Paste real output; when tests fail show test
  names and errors.
- Commit at the end of each phase.
