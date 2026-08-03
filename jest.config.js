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
   * Coverage is measured over the runtime library and the published ESLint
   * plugin, not the tests or shell gates. The plugin has its own aggregate
   * threshold below so its branch-heavy analyzer cannot trade coverage with
   * runtime modules under `src/`.
   *
   * The two exclusions are cosmetic, and saying so is the point. Both
   * `src/specs/*.nitro.ts` (Nitro spec declarations that nitrogen reads and
   * nothing executes) and the `types.ts` files (interfaces and aliases
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
    'eslint-plugin/**/*.js',
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
   * half of that is `check-mutants.sh`, which reintroduces the defects in its
   * manifest and requires the named test to fail for each; the two are not
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
   *   - `./src/` and `./eslint-plugin/` are independent whole-product
   *     aggregates. Keeping them separate is load-bearing: a large,
   *     well-covered runtime module cannot pay for an untested analyzer branch,
   *     and the analyzer cannot weaken the runtime floor that existed before
   *     plugin coverage joined this gate.
   *   - the runtime directory keys are per-directory AGGREGATES. They notice a
   *     whole area going quiet, which the `./src/` number would absorb.
   *   - `./src/*.{ts,tsx}` is a glob, and jest applies a glob PER FILE rather
   *     than to the group. That asymmetry is not an oversight: a directory key
   *     matches every file beneath it, while the glob is the only way to say
   *     "the modules directly in src/". Being per-file it has to clear the
   *     weakest of them (`ScopedLogger.ts`), which makes it a cliff-edge guard
   *     rather than a standard — it fails when a root module lands with no
   *     tests at all.
   *
   * Two pieces of jest behaviour this relies on, both verified against
   * `@jest/reporters` rather than assumed, and both load-bearing:
   *
   *   - a directory key is an aggregate over every covered file below that
   *     path, even when narrower directory or glob thresholds also match it.
   *     That is what lets `./src/` preserve the old whole-runtime floor while
   *     its directories and root files keep their sharper local floors.
   *   - a key that matches no file at all is an ERROR ("Coverage data for X
   *     was not found"), not a skip. That is what stops a renamed directory
   *     from turning its threshold into decoration.
   *
   * Measured 2026-08-02, at 2177 tests in 34 suites:
   *
   *   src/               98.45 stmts  96.62 branch  98.80 funcs  99.11 lines
   *   eslint-plugin/     90.04        83.95         95.32        92.86
   *   src/analytics      96.04        92.00        100.00        96.89
   *   src/destinations   97.49        92.55        100.00        98.63
   *   src/formatters    100.00        96.11        100.00       100.00
   *   src/integrations   93.42        89.05         96.42        94.23
   *   weakest src/*      96.00        90.00         96.66        97.33
   *
   * `integrations/` is the lowest directory and knowingly so: `appState.ts`
   * and `rejectionHandler.ts` register global handlers whose uninstall paths
   * run only when a host app tears them down, which the fakes model but do not
   * drive end to end. The weakest root module is `ScopedLogger.ts`, which is
   * mostly delegation to `Logger` and covered through it.
   */
  coverageThreshold: {
    './src/': { statements: 94, branches: 90, functions: 94, lines: 95 },
    './src/analytics/': {
      statements: 94,
      branches: 90,
      functions: 98,
      lines: 94,
    },
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
    './eslint-plugin/': {
      statements: 87,
      branches: 81,
      functions: 93,
      lines: 90,
    },
    './src/*.{ts,tsx}': {
      statements: 82,
      branches: 82,
      functions: 75,
      lines: 82,
    },
  },
};
