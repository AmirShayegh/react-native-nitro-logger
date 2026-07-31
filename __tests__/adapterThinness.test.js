const fs = require('node:fs');
const path = require('node:path');

/**
 * The two Nitro adapters have to stay marshalling, and this is what says so.
 *
 * Neither `HybridFileSink.swift` nor `HybridFileSink.kt` can be built by any
 * test target on its own platform — the first imports Nitro, whose value types
 * are C++-backed typealiases, and the second extends a nitrogen-generated base
 * that needs the native side. So logic that lives in either file is logic no
 * unit test can execute, and both had accumulated ~390 lines of it: which
 * lifecycle call each spec op makes, what it does with the answer, what it
 * returns when there is no handle. The two drifted apart on four no-handle rows
 * without anyone noticing, and the one bug found in that layer this release was
 * caught by review rather than by a test, for exactly that reason.
 *
 * The decisions now live in `FileSinkAnswers` on both platforms. Nothing stops
 * them coming back except this file.
 *
 * ## Why here and not in each platform's own suite
 *
 * The gate is symmetric and the two halves must not drift, which is the failure
 * it exists to prevent — encoding it twice would reproduce it. JavaScript is the
 * only target that can read both trees, which is the same argument that puts
 * `openFailureParity` here.
 *
 * ## What this does NOT prove
 *
 * That what is left in the adapters is *correct*. A field-for-field copy that
 * copies the wrong field is exactly the shape this cannot see, and it stays
 * covered only by the min-rn smoke jobs. Nor does a line count measure
 * complexity: one dense line can hide a decision. The `lifecycle.` ban is the
 * assertion with teeth; the ceiling is the tripwire for everything else.
 */

const ROOT = path.resolve(__dirname, '..');

const ADAPTERS = [
  {
    name: 'ios/HybridFileSink.swift',
    // Measured at 112 code lines when the extraction landed — down from 292,
    // and all of it field copies. Pinned a little above so one more spec op
    // does not need this number touched, and anything larger does. It is a
    // tripwire, not a standard: the `lifecycle.` ban below is the assertion
    // that says what "thin" means.
    ceiling: 125,
    answers: 'ios/FileSinkAnswers.swift',
    methodPattern: /^\s*func (\w+)\(/gm,
  },
  {
    name: 'android/src/main/java/com/margelo/nitro/nitrologger/HybridFileSink.kt',
    // Measured at 81, down from 293. Lower than the iOS number because Kotlin's
    // positional constructors spell a field copy in one line where Swift's
    // labelled ones take two.
    ceiling: 95,
    answers:
      'android/src/main/java/com/margelo/nitro/nitrologger/FileSinkAnswers.kt',
    methodPattern: /^\s*fun (\w+)\(/gm,
  },
];

/**
 * Comments removed, blanks removed.
 *
 * Deliberately not a parser. It handles the two comment forms both files
 * actually use, and the vacuity guard below fails if it ever strips so much
 * that nothing recognisable is left — which is what a parser going wrong looks
 * like from here.
 */
function codeLines(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0);
}

/** Operation names the answers object exposes, private helpers excluded. */
function operations(source, pattern) {
  const found = new Set();
  for (const match of source.matchAll(pattern)) found.add(match[1]);
  return found;
}

describe('the Nitro adapters stay marshalling', () => {
  describe.each(ADAPTERS.map((a) => [a.name, a]))('%s', (_name, adapter) => {
    const source = fs.readFileSync(path.join(ROOT, adapter.name), 'utf8');
    const lines = codeLines(source);

    test('is recognisably the adapter, before anything is asserted about it', () => {
      // The vacuity guard. Every assertion below passes trivially against an
      // empty file, which is what a renamed path or an over-eager strip
      // produces — and a renamed path is a real possibility here, since these
      // are the two files no compiler in this process will complain about.
      expect(lines.length).toBeGreaterThan(20);
      expect(source).toMatch(/class HybridFileSink/);
      expect(source).toMatch(/FileSinkAnswers/);
    });

    test('makes no lifecycle call', () => {
      // The assertion with teeth. A line ceiling can be satisfied by dense
      // code; this cannot be satisfied at all while a decision about the
      // handle's state lives in a file no test can run.
      //
      // Checked against stripped code on purpose: this file's own header talks
      // about `lifecycle.` calls, and a gate that its own explanation trips is
      // a gate someone deletes.
      expect(lines.filter((line) => line.includes('lifecycle.'))).toEqual([]);
    });

    test(`is at most ${adapter.ceiling} lines of code`, () => {
      expect(lines.length).toBeLessThanOrEqual(adapter.ceiling);
    });
  });

  test('both platforms answer every spec operation', () => {
    // Not a line count and not a ban: the positive statement that both
    // extracted objects carry the whole spec. The adapters drifted on four
    // no-handle rows once; the shared table pins what each op *answers*, and
    // this pins that both platforms have the op at all.
    //
    // Scoped to the spec rather than compared set-for-set, because the two
    // objects legitimately differ elsewhere: `defaultLogDirectory` is a
    // computed property on iOS and takes the app's base directory on Android,
    // since only there does reading it need a `Context`. Demanding identical
    // surfaces would have forced one of those to be wrong for its platform.
    const SPEC_OPS = [
      'open',
      'appendBatch',
      'getStatus',
      'maintain',
      'collectLogs',
      'flush',
      'close',
      'clearLogs',
      'deleteSupportBundle',
      'getLogFilePaths',
      // Not a spec op, but the same operation on both sides and named the same
      // on purpose: it used to be `dispose` on iOS and `releaseHandle` on
      // Android, which this assertion is what caught.
      'releaseHandle',
    ];

    for (const adapter of ADAPTERS) {
      const found = operations(
        fs.readFileSync(path.join(ROOT, adapter.answers), 'utf8'),
        adapter.methodPattern
      );
      // Vacuity guard: every `expect` below passes against a set that contains
      // everything, and a regex that stopped matching produces the opposite —
      // an empty one — so the count is checked in both directions.
      expect(found.size).toBeGreaterThanOrEqual(SPEC_OPS.length);
      expect(SPEC_OPS.filter((op) => !found.has(op))).toEqual([]);
    }
  });
});
