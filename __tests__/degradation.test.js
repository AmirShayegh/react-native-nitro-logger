/* eslint-disable no-bitwise -- A test about bits builds masks. Every operator
   here is a shift or a mask, deliberate and load-bearing. */

const fs = require('fs');
const path = require('path');
const {
  DEGRADED_ROTATION,
  DEGRADED_GZIP,
  DEGRADED_PRUNE,
  DEGRADED_SIDECAR,
  DEGRADED_PROTECTION,
  DEGRADED_EXCLUSIVITY,
  describeDegradation,
} = require('../src/degradation');

/**
 * The degradation bits exist four times over, and this is what stops them
 * drifting apart.
 *
 * `LogDegradation` in `ios/LogFileWriter.swift` sets them, `LogDegradation` in
 * `android/.../LogRotationPolicy.kt` sets them, `src/degradation.ts` names them
 * for JavaScript callers, and the table in `docs/API.md` is what anybody
 * reading the docs believes. Four copies of six numbers, in four languages,
 * with no compiler between them — the only thing that can hold them together is
 * a test that reads all four.
 *
 * ## What this does NOT prove
 *
 * **The meanings.** Every assertion here is about a name and a number. That all
 * four agree `sidecar` is `1 << 3` says nothing about whether the writers
 * actually raise that bit when the age sidecar fails to write, or whether the
 * sentence describing it in API.md is true. Those are the natives' own suites
 * and a human reading, respectively.
 *
 * **Anything about a seventh bit.** A native that adds one and a TypeScript
 * side that never hears about it will fail the count guards below, which is the
 * point — but only because the counts are pinned. Nothing here can tell you
 * what the new bit is for.
 */

const ROOT = path.resolve(__dirname, '..');
const EXPECTED_ROWS = 6;

/** The names, in bit order, that all four sources must agree on. */
const NAMES = [
  'rotation',
  'gzip',
  'prune',
  'sidecar',
  'protection',
  'exclusivity',
];

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Every `name -> bit` pair a source declares, as a plain object.
 *
 * `pattern` must capture the name first and the **shift** second, which is how
 * both natives spell it (`1 << 0`, `1 shl 0`); the shift is turned into the bit
 * here so a source that wrote the literal `1` where it meant `1 << 0` still
 * disagrees loudly.
 *
 * `found` is returned alongside so the caller can assert the regex matched the
 * number of rows it was supposed to. Without that, a source that gets
 * reformatted past the pattern yields an empty map, an empty map equals an
 * empty map, and the whole file passes while proving nothing — the failure mode
 * this style of test has to defend against first.
 */
function harvest(text, pattern, normalizeName) {
  const bits = {};
  let found = 0;
  for (const match of text.matchAll(pattern)) {
    found += 1;
    bits[normalizeName(match[1])] = 1 << Number(match[2]);
  }
  return { bits, found };
}

/** The six bits as the TypeScript module has them. */
const TS_BITS = {
  rotation: DEGRADED_ROTATION,
  gzip: DEGRADED_GZIP,
  prune: DEGRADED_PRUNE,
  sidecar: DEGRADED_SIDECAR,
  protection: DEGRADED_PROTECTION,
  exclusivity: DEGRADED_EXCLUSIVITY,
};

/** `1 << n` for each name, built from the shift rather than from a literal. */
const EXPECTED_BITS = Object.fromEntries(
  NAMES.map((name, index) => [name, 1 << index])
);

describe('degradation bits — four sources, one set of numbers', () => {
  test('the TypeScript constants are the six ascending bits', () => {
    expect(TS_BITS).toEqual(EXPECTED_BITS);
    expect(Object.keys(TS_BITS)).toHaveLength(EXPECTED_ROWS);
  });

  test('iOS declares the same six', () => {
    // `public static let rotation = LogDegradation(rawValue: 1 << 0)`
    const { bits, found } = harvest(
      read('ios/LogFileWriter.swift'),
      /static let (\w+) = LogDegradation\(rawValue: 1 << (\d+)\)/g,
      (name) => name
    );
    expect(found).toBe(EXPECTED_ROWS);
    expect(bits).toEqual(EXPECTED_BITS);
  });

  test('Android declares the same six', () => {
    // `const val ROTATION = 1 shl 0`, inside `object LogDegradation`.
    const source = read(
      'android/src/main/java/com/margelo/nitro/nitrologger/LogRotationPolicy.kt'
    );
    // Both anchors are asserted before the slice. `indexOf` answers -1 for a
    // string it cannot find, and `slice(-1, …)` is a quiet, plausible-looking
    // window over the wrong part of the file — a renamed enum would leave this
    // reading almost everything and still passing, which is the block scoping
    // silently gone rather than reported.
    const start = source.indexOf('object LogDegradation');
    const end = source.indexOf('enum class LogRejectReason');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    const { bits, found } = harvest(
      block,
      /const val ([A-Z]+) = 1 shl (\d+)/g,
      (name) => name.toLowerCase()
    );
    expect(found).toBe(EXPECTED_ROWS);
    expect(bits).toEqual(EXPECTED_BITS);
  });

  test('the API.md table says the same six', () => {
    // `| `1 << 0` | rotation | The active file could not be rotated. |`
    // The shift comes first in a table row, so this one cannot go through
    // `harvest` — it reads the columns in the order the document has them.
    const rows = [
      ...read('docs/API.md').matchAll(/\|\s*`1 << (\d+)`\s*\|\s*(\w+)\s*\|/g),
    ];
    expect(rows).toHaveLength(EXPECTED_ROWS);
    const bits = {};
    for (const [, shift, name] of rows) bits[name] = 1 << Number(shift);
    expect(bits).toEqual(EXPECTED_BITS);
  });
});

describe('describeDegradation', () => {
  test('a healthy mask names nothing', () => {
    expect(describeDegradation(0)).toEqual([]);
  });

  test('names the bits that are set, in bit order', () => {
    expect(describeDegradation(DEGRADED_PRUNE | DEGRADED_EXCLUSIVITY)).toEqual([
      'prune',
      'exclusivity',
    ]);
    // Order is the bits', not the argument's: the same two bits written the
    // other way round still read out low-to-high.
    expect(describeDegradation(DEGRADED_EXCLUSIVITY | DEGRADED_PRUNE)).toEqual([
      'prune',
      'exclusivity',
    ]);
  });

  test('every bit on names all six', () => {
    const all = Object.values(TS_BITS).reduce((mask, bit) => mask | bit, 0);
    expect(describeDegradation(all)).toEqual(NAMES);
  });

  test('a bit this build has no name for is ignored, not invented', () => {
    // A newer native against an older bundle. The named bit still reads out;
    // the unknown one contributes nothing rather than a meaningless string.
    expect(describeDegradation(DEGRADED_GZIP | (1 << 20))).toEqual(['gzip']);
    expect(describeDegradation(1 << 20)).toEqual([]);
  });

  test('nonsense is the healthy answer, never a throw', () => {
    // This is read off a bridge. A native that answers with the wrong shape
    // must not take the diagnostics path down with it. Note what is NOT in
    // this list: a negative number, which is a legitimate 32-bit mask with
    // bit 31 set — see the test below.
    for (const input of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2.5,
      -0.5,
      // Outside 32 bits in both directions: not a mask either writer holds.
      0x1_0000_0000,
      -0x8000_0001,
      undefined,
      null,
      'rotation',
      {},
    ]) {
      expect(describeDegradation(input)).toEqual([]);
    }
  });

  /**
   * A high bit arrives as a negative number, and the bits beside it still count.
   *
   * Both writers hold the mask in a 32-bit signed integer. If either ever adds
   * a bit 31, every mask carrying it crosses the bridge negative — and a guard
   * that rejected negatives outright would answer "healthy" for a device that
   * had just reported six failures plus one this build has no name for.
   */
  test('a negative mask is read as its bits, not discarded', () => {
    const signBit = -0x8000_0000;

    // Bit 31 alone: unknown to this build, so nothing to name — but it must
    // reach the same answer by being ignored, not by being rejected.
    expect(describeDegradation(signBit)).toEqual([]);

    // Bit 31 alongside two it does know. `|` is itself a 32-bit signed
    // operation in JavaScript, which is what makes the result negative — the
    // same shape the value arrives in from a writer holding it in an `Int`.
    const withKnown = signBit | DEGRADED_GZIP | DEGRADED_SIDECAR;
    expect(withKnown).toBeLessThan(0);
    expect(describeDegradation(withKnown)).toEqual(['gzip', 'sidecar']);

    // -1 is every bit set, which includes all six of ours.
    expect(describeDegradation(-1)).toEqual(NAMES);
  });

  test('the result is frozen', () => {
    const result = describeDegradation(DEGRADED_ROTATION);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      result.push('nope');
    }).toThrow();
  });
});
