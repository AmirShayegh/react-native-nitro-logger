/**
 * The empty-loop control — the harness's dead-code-elimination canary.
 *
 * Not a benchmark: this case prices the measurement loop itself (one call,
 * one typeof, one integer fold, nothing else), and every other case is
 * valid evidence only while it measures ABOVE this floor. If an engine
 * ever inlines a case's op and eliminates its work — the concern is real
 * for ops whose results are invisible by design, like the filtered logger
 * calls — that case's number collapses to this one's, because an empty op
 * and an eliminated op are the same machine code. `bench/run.js` and the
 * Hermes harvest both refuse to report any case at or near the control
 * floor, which converts "trust that the engine does not eliminate the
 * call" into a per-run, per-engine measurement.
 *
 * Case authors: nothing real belongs within the check's margin of this
 * floor. A case that cheap is measuring the harness, not the library.
 */
module.exports.cases = [
  {
    name: 'control.empty-loop',
    setup() {
      return {
        op() {
          return 0;
        },
      };
    },
  },
];
