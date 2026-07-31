/** Library unit tests run in plain Node — no RN runtime needed. Modules that
 * touch react-native APIs are tested through injected fakes. */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/__tests__/**/*.test.{ts,js}'],
  transform: {
    '^.+\\.(js|jsx|ts|tsx)$': 'babel-jest',
  },

  /*
   * Coverage is measured over `src/` only — the library, not the tests, the
   * ESLint plugin or the gates.
   *
   * The two exclusions are cosmetic, and saying so is the point. Both
   * `src/specs/*.nitro.ts` (Nitro spec declarations that nitrogen reads and
   * nothing executes) and the three `types.ts` files (interfaces and aliases
   * that Babel erases) contain no instrumentable statements at all, so
   * istanbul scores them 0-of-0 and reports `pct: 100`. Removing either
   * exclusion changes no number in this file — measured, not assumed. What
   * they buy is a readable report: the text table renders 0-of-0 as `0`, and
   * a row of zeroes beside real modules reads as untested code when it is no
   * code.
   *
   * The residual, stated because it is the cost of the tidiness: if one of
   * those files ever gains runtime content, coverage will not see it. The
   * declared surface is covered by other means — `check-doc-samples.sh`
   * type-checks it and `check-package-exports.sh` proves it is reachable from
   * the published entry point — but neither of those is a coverage gate, and
   * a `.nitro.ts` file that grows a constant is a case to notice in review.
   */
  // `text` for a human reading CI output, `json-summary` because
  // `check-coverage-groups.sh` reads the file list back out of it — see there
  // for why it reads jest's own output rather than re-deriving the glob set.
  coverageReporters: ['text', 'json-summary'],

  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/specs/*.nitro.ts',
    '!src/**/types.ts',
  ],

  /*
   * ## What these thresholds are, and what they are not
   *
   * They are a RATCHET. Each is set two points below what the suite measured
   * on 2026-07-31, so ordinary refactoring does not trip them and a module
   * arriving without tests does. They are not a target: raising them is a
   * decision someone makes on purpose, and the measured values are recorded
   * below so the next person can see the headroom rather than guess at it.
   *
   * What this does NOT prove is that any line is TESTED. Coverage records
   * that a line ran, not that anything asserted about what it did. The other
   * half of that is `check-mutants.sh`, which reintroduces sixteen real
   * defects and requires the named test to fail for each; the two are not
   * substitutes, and neither is a substitute for review.
   *
   * ## Why there are three tiers rather than one number
   *
   * A single global figure is close to uninformative here: a large share of
   * these tests are RuleTester and doc-parity cases that execute no `src/`
   * line at all, so the aggregate is dominated by whichever modules happen to
   * be biggest, and a well-covered `destinations/` can pay for an untested
   * `integrations/`. So:
   *
   *   - `global` is the whole-library aggregate. Least informative, kept
   *     because it is the only one that notices coverage draining out of the
   *     library as a whole.
   *   - the three directory keys are per-directory AGGREGATES. They notice a
   *     whole area going quiet, which the global number would absorb.
   *   - `./src/*.{ts,tsx}` is a glob, and jest applies a glob PER FILE rather
   *     than to the group. That asymmetry is not an oversight: a directory key
   *     matches every file beneath it, so `./src/` would mean "all of src" and
   *     duplicate `global`, and there is no other way to say "the modules
   *     directly in src/". Being per-file it has to clear the weakest of them
   *     (`ScopedLogger.ts`), which makes it a cliff-edge guard rather than a
   *     standard — it fails when a root module lands with no tests at all.
   *
   * Two pieces of jest behaviour this relies on, both verified against
   * `@jest/reporters` rather than assumed, and both load-bearing:
   *
   *   - a file matched by any key is removed from `global`'s set, and when
   *     that empties the set completely jest falls back to ALL covered files.
   *     Every `src/` file matches one of the keys below, so `global` is
   *     computed over the whole library, not over nothing. A mutation test
   *     covers this: raising the global numbers above the measured aggregate
   *     must fail, and would not if the group were empty. `global` therefore
   *     depends on every file matching a narrower key, which is a property of
   *     the tree rather than of this file — add `src/new-area/` and it stops
   *     holding, silently. `scripts/check-coverage-groups.sh` is what makes
   *     that fail instead, and `yarn test:coverage` runs it.
   *   - a key that matches no file at all is an ERROR ("Coverage data for X
   *     was not found"), not a skip. That is what stops a renamed directory
   *     from turning its threshold into decoration.
   *
   * Measured 2026-07-31, at 1108 tests in 26 suites:
   *
   *   all files          96.82 stmts  92.47 branch  96.68 funcs  97.43 lines
   *   src/destinations   97.65        92.77        100.00        98.82
   *   src/formatters    100.00        93.44        100.00       100.00
   *   src/integrations   92.78        87.11         95.83        93.67
   *   weakest src/*      84.61        84.61         77.77        84.61
   *
   * `integrations/` is the lowest directory and knowingly so: `appState.ts`
   * and `rejectionHandler.ts` register global handlers whose uninstall paths
   * run only when a host app tears them down, which the fakes model but do not
   * drive end to end. The weakest root module is `ScopedLogger.ts`, which is
   * mostly delegation to `Logger` and covered through it.
   */
  coverageThreshold: {
    'global': { statements: 94, branches: 90, functions: 94, lines: 95 },
    './src/destinations/': {
      statements: 95,
      branches: 90,
      functions: 98,
      lines: 96,
    },
    './src/formatters/': {
      statements: 98,
      branches: 91,
      functions: 98,
      lines: 98,
    },
    './src/integrations/': {
      statements: 90,
      branches: 85,
      functions: 93,
      lines: 91,
    },
    './src/*.{ts,tsx}': {
      statements: 82,
      branches: 82,
      functions: 75,
      lines: 82,
    },
  },
};
