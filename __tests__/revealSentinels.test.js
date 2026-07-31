/* global globalThis -- the reveal branches read `__DEV__` off it, and setting
   it is the only way to drive them from a test. */

const fs = require('fs');
const path = require('path');

/**
 * The reveal sentinels, and the gate that greps a release bundle for them.
 *
 * `scripts/check-release-bundle.sh` proves the `__DEV__` reveal branches are
 * stripped from a production bundle by searching the bundle for the strings
 * those branches assign. That proof rests entirely on the script and the
 * source agreeing about what the strings *are* — and a grep for a string
 * nothing assigns any more does not fail. It passes, silently, forever,
 * having checked nothing.
 *
 * The script now reconciles its array against the literals in `src/`. This
 * closes the loop from the other side: that the accessors return those same
 * literals at *runtime*, so a rename has to move the source, the script and
 * this file together or break one of them.
 *
 * ## What this does NOT prove
 *
 * **That Metro strips the branch.** Only building a release bundle shows
 * that, which is exactly what the script does. These two checks are
 * complementary and neither substitutes for the other: this one would stay
 * green under a bundler configured without the `__DEV__` substitution, and
 * the script would stay green under a sentinel nobody assigns.
 */
describe('reveal sentinels are the ones the release gate looks for', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'check-release-bundle.sh'),
    'utf8'
  );

  /** The SENTINELS array as the shell script declares it. */
  function sentinelsFromScript() {
    const block = /SENTINELS=\(([^)]*)\)/.exec(script);
    if (block === null) throw new Error('no SENTINELS array in the script');
    return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  }

  const originalDev = globalThis.__DEV__;

  afterEach(() => {
    if (originalDev === undefined) delete globalThis.__DEV__;
    else globalThis.__DEV__ = originalDev;
    jest.resetModules();
  });

  test('the script declares exactly the two sentinels, parsed not guessed', () => {
    // A regex that silently matched nothing would make every assertion below
    // vacuously true, so the parse is checked before anything trusts it.
    expect(sentinelsFromScript()).toEqual([
      '__NITRO_LOGGER_PRIVATE_REVEAL__',
      '__NITRO_LOGGER_ERROR_REVEAL__',
    ]);
  });

  test('the privacy reveal branch assigns the sentinel the gate greps for', () => {
    globalThis.__DEV__ = true;
    const privacy = require('../src/privacy');

    privacy.redactMetadata(
      undefined,
      { note: 'revealed while developing' },
      {
        privacyDefault: 'private',
        redactAll: false,
        keyCatalog: new Set(['note']),
      }
    );

    expect(privacy.__revealBranchSentinel()).toBe(sentinelsFromScript()[0]);
  });

  test('the error reveal branch assigns the sentinel the gate greps for', () => {
    globalThis.__DEV__ = true;
    const errors = require('../src/integrations/sanitizeError');

    errors.sanitizeError(new Error('revealed while developing'));

    expect(errors.__errorRevealBranchSentinel()).toBe(sentinelsFromScript()[1]);
  });

  test('a release build leaves both sentinels unassigned', () => {
    // The positive control for the two above. Without it they would also pass
    // against a module that assigned its sentinel unconditionally — which is
    // precisely the refactor (a reveal moved out from behind `__DEV__`) that
    // the release gate exists to catch. `resetModules` in `afterEach` means
    // neither module has run its branch yet when this starts.
    globalThis.__DEV__ = false;
    const privacy = require('../src/privacy');
    const errors = require('../src/integrations/sanitizeError');

    privacy.redactMetadata(
      undefined,
      { note: 'x' },
      {
        privacyDefault: 'private',
        redactAll: false,
        keyCatalog: new Set(['note']),
      }
    );
    errors.sanitizeError(new Error('x'));

    expect(privacy.__revealBranchSentinel()).toBe('');
    expect(errors.__errorRevealBranchSentinel()).toBe('');
  });

  test('the sentinels are gated on __DEV__ alone, not on any privacy setting', () => {
    // The branch a runtime-flag refactor would break. `privacyDefault` is
    // caller-controlled and `redactAll` is a kill switch, so a reveal that
    // consulted either would be a reveal a production caller could influence.
    // Under a *public* default in dev — where no redaction is even asked for —
    // the gate is still the build type and nothing else.
    globalThis.__DEV__ = true;
    const privacy = require('../src/privacy');

    privacy.redactMetadata(
      undefined,
      { note: privacy.priv('x') },
      {
        privacyDefault: 'public',
        redactAll: false,
        keyCatalog: new Set(['note']),
      }
    );

    expect(privacy.__revealBranchSentinel()).toBe(sentinelsFromScript()[0]);
  });
});
