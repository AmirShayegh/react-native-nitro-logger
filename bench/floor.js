/**
 * The control-floor check — shared verbatim by the Node runner and the
 * Hermes harvest so both engines are held to the same standard.
 *
 * The problem it solves: some cases have no result worth folding into the
 * measurement loop's accumulator. A filtered `logger.info` returns nothing
 * and touches no destination by design — that IS the path being priced —
 * so no return value can prove the call happened, and an engine that
 * inlined the call and proved it side-effect-free would be entitled to
 * delete it. Arguments about escape analysis do not settle that; a
 * measurement does.
 *
 * So: `control.empty-loop` measures the harness's own floor — one call,
 * one typeof, one integer add — and every other case must measure clearly
 * above it. An eliminated op and an empty op compile to the same machine
 * code, so a case whose work was deleted collapses onto the control. The
 * margin is a multiple rather than an absolute, because the floor differs
 * by engine and machine, which is exactly why it is re-measured per run.
 *
 * WHAT IT DOES NOT PROVE: that a case measures the RIGHT work — only that
 * it measures some. A case configured wrongly (the empty-Map short-circuit
 * that once made the deep-subsystem walk read 7.6 ns) clears this bar
 * comfortably while pricing the wrong thing.
 */
const CONTROL = 'control.empty-loop';

/**
 * Cases must measure above `MULTIPLE ×` the control. Three is chosen from
 * the observed spread: the cheapest real case on V8 (`filtered.no-subsystem`,
 * ~7 ns) sits an order of magnitude above the floor, so three leaves room
 * for a slower engine to compress the ratio without ever admitting an
 * eliminated op, which reads AT the floor and not near it.
 */
const MULTIPLE = 3;

/**
 * @param {{ name: string, nsPerOp: number }[]} results
 * @returns {string[]} one message per case that failed the floor; empty
 *   means every case measured real work.
 */
function checkControlFloor(results) {
  const problems = [];
  const control = results.filter((r) => r.name === CONTROL)[0];
  if (!control) {
    return [
      'the control case ' +
        CONTROL +
        ' is missing; nothing validates the other numbers',
    ];
  }
  const floor = control.nsPerOp * MULTIPLE;
  for (const result of results) {
    if (result.name === CONTROL) continue;
    if (result.nsPerOp > floor) continue;
    problems.push(
      result.name +
        ' measured ' +
        result.nsPerOp.toFixed(2) +
        ' ns/op, inside ' +
        MULTIPLE +
        '× the empty-loop control (' +
        control.nsPerOp.toFixed(2) +
        ' ns/op): its work was eliminated, or the case measures nothing'
    );
  }
  return problems;
}

module.exports = { CONTROL: CONTROL, MULTIPLE: MULTIPLE, checkControlFloor };
