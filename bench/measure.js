/**
 * The measurement core, shared verbatim between engines.
 *
 * This file must stay runnable on Node (the `bench/run.js` harness) and on
 * Hermes (the mirror in `example/src/BenchHarness.tsx`), because the entire
 * point of the mirror is that BOTH engines execute the SAME loop over the
 * SAME cases — a mirror with its own timing logic would be measuring its own
 * timing logic. So: CommonJS, no Node APIs, no syntax newer than the RN 0.78
 * floor. The clock is injected for the same reason — Node has
 * `process.hrtime.bigint`, Hermes has `performance.now`, and neither name can
 * appear here.
 *
 * Method: double the batch size until one batch costs at least `targetMs`
 * (so the clock's resolution is amortised into noise), then run
 * `warmup + samples` batches and keep the MINIMUM ns/op of the counted ones.
 * Best-of, not mean-of: an interrupted batch can only ever read slower, so
 * the minimum is the least-contaminated observation of the code itself.
 *
 * WHAT THIS DOES NOT PROVE. Numbers from this harness compare two commits on
 * one machine, one engine, same session. They are not device numbers, not
 * cross-machine comparable, and never CI-gated — shared runners lie.
 */

/**
 * @param {() => unknown} op returns its result so the loop below can consume
 *   it — see `runCase.blackhole`.
 * @param {{
 *   now: () => number,
 *   gc?: (() => void) | undefined,
 *   targetMs: number,
 *   samples: number,
 *   warmup: number,
 * }} options `now` returns milliseconds (fractional allowed).
 * @returns {{ iterations: number, nsPerOp: number, samples: number[] }}
 */
function runCase(op, options) {
  var now = options.now;
  var gc = options.gc;

  // Every `op()` result lands here and is published on `runCase.blackhole`
  // after the loops, so no engine can prove the results unused and delete
  // the work. A pure helper — `utf8Length`, a formatter — is exactly the
  // call an inliner would otherwise be entitled to eliminate, and a bench
  // that measures an eliminated call reports the cost of an empty loop.
  var blackhole;

  var iterations = 1;
  for (;;) {
    var start = now();
    for (var i = 0; i < iterations; i += 1) blackhole = op();
    var elapsed = now() - start;
    // The cap is a runaway stop for a sub-nanosecond op, not a tuning knob.
    if (elapsed >= options.targetMs || iterations >= 16777216) break;
    iterations *= 2;
  }

  var counted = [];
  var total = options.warmup + options.samples;
  for (var s = 0; s < total; s += 1) {
    // Collect between batches, not during them, when the engine allows it.
    if (gc) gc();
    var batchStart = now();
    for (var j = 0; j < iterations; j += 1) blackhole = op();
    var batchElapsed = now() - batchStart;
    if (s >= options.warmup) {
      counted.push((batchElapsed * 1e6) / iterations);
    }
  }

  runCase.blackhole = blackhole;

  var best = counted[0];
  for (var k = 1; k < counted.length; k += 1) {
    if (counted[k] < best) best = counted[k];
  }

  return { iterations: iterations, nsPerOp: best, samples: counted };
}

module.exports = { runCase: runCase };
