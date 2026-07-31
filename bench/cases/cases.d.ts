/**
 * The case-module contract, shared by the three sibling declaration files.
 * See ../measure.d.ts for why these exist at all.
 */
export interface BenchCaseInstance {
  op: () => void;
  teardown?: () => void;
}

export interface BenchCase {
  name: string;
  setup: () => BenchCaseInstance;
}
