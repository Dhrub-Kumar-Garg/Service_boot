# ServiceBoot

A Node.js OS lab CLI that reads `serviceboot.yml`, validates services, and plans their startup in dependency levels. The project supports Sequential, Parallel, and Adaptive execution; Person 1's foundation is complete, and Person 2 must implement the process engine.

Requires Node.js 18+. Plain JavaScript (CommonJS), no build step; `js-yaml` is the only direct runtime dependency.

## Install and check

```sh
npm install
npm test
npm run test:engine
```

At the Person 1 handover, the macOS fresh clone has 106 passing unit tests. All 18 engine acceptance tests intentionally fail with `NOT IMPLEMENTED` until Person 2 implements the engine. Some signal tests skip on Windows.

## Commands

```sh
node bin/serviceboot.js plan --config samples/wide.yml
node bin/serviceboot.js up --config samples/wide.yml --algorithm parallel
```

`plan` works now; add `--json` for the complete plan. `up` currently exits 3 with the engine stub message. Defaults are `./serviceboot.yml` and algorithm `adaptive`; `up` also accepts `--max-parallel N` and `--exit-after-ready`. Use `--help` for usage.

## Folder map

| Path | Purpose |
| --- | --- |
| `bin/`, `src/cli/` | CLI entry point, argument parsing, plain output, signal wiring |
| `src/config/` | YAML parsing, validation, normalized Service objects |
| `src/graph/`, `src/plan.js` | DAG, cycles, deterministic levels, adaptive analysis |
| `src/engine/` | Person 2's process engine (currently a stub) |
| `mock/`, `samples/` | Real TCP/HTTP mock and five example configurations |
| `test/unit/` | Foundation, CLI, mock, and helper tests |
| `test/engine/`, `test/helpers/` | Engine acceptance tests and process helpers |
| `handover/` | Continuation guide and real verification output |

Read [CONTRACT.md](CONTRACT.md) and the [Person 1 → Person 2 handover](handover/01-person1-to-person2.md) before implementing the engine. The final Person 1 release is tagged `p1-done`.
