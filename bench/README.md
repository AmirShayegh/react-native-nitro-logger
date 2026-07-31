# bench — the performance harness

Four instruments, one discipline: **numbers compare two commits on one
machine in one session, and nothing gates on them.** CI runs executes-only
passes; a bench case that stops constructing is a failure, a slow number
never is — shared runners lie about time.

## The JS bench (Node/V8)

```sh
corepack yarn prepare          # the bench measures lib/commonjs, the shipped artifact
node bench/run.js              # every case, one child process each, best-of-7
node bench/run.js --filter utf8
node bench/run.js --json before.json
```

Cases live in `bench/cases/*.js`: the per-call hot path (`hotpath`), the
formatters (`format`), and the batcher plus `utf8Length` corpora
(`batcher`). One child process per case — a shared process lets one case's
JIT tiering and heap shape leak into the next case's numbers. The runner
refuses to run when any part of `lib/commonjs` predates the newest `src`
edit, because measuring a stale build under a fresh commit message is the
harness's one silent-lie mode.

### The control floor

`bench/cases/control.js` measures an empty op — the harness's own cost —
and every full run checks that every other case lands clearly above it
(`bench/floor.js`, shared with the Hermes harvest). An op whose work an
engine eliminated compiles to the same thing as an empty op, so it
collapses onto the control; this is how the harness demonstrates, per run
and per engine, that it measured real work instead of asserting it. The
`--filter` flag never removes the control, and `--quick` skips the check —
its 2 ms batches are too coarse for a ratio, and CI, which runs `--quick`,
gates on nothing numeric.

## The Hermes mirror

V8 numbers do not transfer: Hermes has its own regex engine, weaker escape
analysis, and its own `toISOString`. The SAME case files and the SAME
measurement core (`bench/measure.js`) run on-device through the example app —
`example/src/BenchHarness.tsx` — and `scripts/bench-hermes-android.sh`
automates the Android run end to end, harvesting one JSON line per case from
logcat. Any finding gated on Hermes behaviour (B1, B6 in the 0.4.0 audit) is
decided by that run, never by the Node one.

## The native harnesses

- **Swift**: `LogPerfTests.swift` in `swift-tests/`, `measure {}` around the
  writer burst shapes. Runs with `swift test` like every other suite; XCTest
  prints the timings, asserts nothing about them.
- **Kotlin**: allocation-count tests in the Android unit suite, measuring
  allocated bytes per burst on the JVM via `ThreadMXBean` (the
  `Debug.startAllocCounting` shape needs a device; the JVM counter gives the
  same relative signal per-commit on the machine where the work happens, and
  the trade is recorded in the test file).

## What this proves, and does not

It proves a change moved a number on the engine it ran on, and that every
case still executes. It does not prove device performance, does not compare
across machines, and does not stand in for the golden suite, the parity
locks, or any correctness gate — an optimisation whose guard test fails is
wrong no matter what these numbers say.
