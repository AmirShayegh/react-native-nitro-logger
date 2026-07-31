/**
 * Types for the shared measurement core, for the Hermes mirror's benefit —
 * `example/src/BenchHarness.tsx` imports the same JavaScript Node executes,
 * and the example is typechecked while `bench/*.js` deliberately is not
 * (`allowJs` would drag the whole bench into tsc for no return).
 */
export interface MeasureOptions {
  now: () => number;
  gc?: (() => void) | undefined;
  targetMs: number;
  samples: number;
  warmup: number;
}

export interface MeasureResult {
  iterations: number;
  nsPerOp: number;
  samples: number[];
}

export function runCase(
  op: () => unknown,
  options: MeasureOptions
): MeasureResult;
