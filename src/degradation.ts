/* eslint-disable no-bitwise -- This file IS the bitmask. The rule exists to
   catch `&` where `&&` was meant; every operator below is a deliberate shift or
   mask over a wire format the two native writers define, and writing them any
   other way would hide what they are. */

/**
 * The bits `FileDestination.degradation()` returns, named.
 *
 * The mask crosses the bridge as a plain `number`, which is the right wire
 * shape and a useless thing to hold: `if (mask & 4)` is unreadable at the call
 * site and unverifiable in review. These are the same six bits with names on
 * them.
 *
 * **Hand-written, not generated.** Six constants that have never changed are
 * not worth a codegen step, and a generator would have to run in CI to be
 * trusted — which is a build that writes into shipped source, the thing this
 * repo's doc gates exist to avoid. What keeps the four copies honest instead is
 * `__tests__/degradation.test.js`, which reads this file, the table in
 * `docs/API.md`, `LogDegradation` in `ios/LogFileWriter.swift`, and
 * `LogDegradation` in `android/.../LogRotationPolicy.kt`, and fails if any of
 * them disagrees about a name or a value.
 *
 * **What that test does not pin: the meanings.** It proves all four sources
 * agree that `sidecar` is `1 << 3`. Nothing here proves the writer actually
 * sets that bit when the age sidecar fails — that is the natives' own suites.
 *
 * @module
 */

/** The active file could not be rotated. */
export const DEGRADED_ROTATION = 1 << 0;

/** An archive could not be compressed and was kept as plaintext. */
export const DEGRADED_GZIP = 1 << 1;

/** Retention could not delete something it wanted to. */
export const DEGRADED_PRUNE = 1 << 2;

/**
 * The age sidecar could not be written, so age-based rotation is guessing.
 */
export const DEGRADED_SIDECAR = 1 << 3;

/**
 * A file or directory did not get the mode, protection class or backup
 * exclusion it should have.
 */
export const DEGRADED_PROTECTION = 1 << 4;

/**
 * The filesystem would not give this writer an exclusive claim on its file, so
 * nothing stops a second process appending to it.
 */
export const DEGRADED_EXCLUSIVITY = 1 << 5;

/**
 * Every bit, in ascending order, paired with the name it is known by.
 *
 * The order is the bit order rather than an editorial one, so
 * {@link describeDegradation} returns something stable that a reader can line
 * up against the table in `docs/API.md` without re-sorting it.
 */
const NAMED_BITS: readonly (readonly [number, string])[] = Object.freeze([
  Object.freeze([DEGRADED_ROTATION, 'rotation'] as const),
  Object.freeze([DEGRADED_GZIP, 'gzip'] as const),
  Object.freeze([DEGRADED_PRUNE, 'prune'] as const),
  Object.freeze([DEGRADED_SIDECAR, 'sidecar'] as const),
  Object.freeze([DEGRADED_PROTECTION, 'protection'] as const),
  Object.freeze([DEGRADED_EXCLUSIVITY, 'exclusivity'] as const),
]);

/** One frozen empty array, so the healthy answer allocates nothing. */
const EMPTY: readonly string[] = Object.freeze([]);

/**
 * The widest and narrowest a 32-bit mask can arrive as.
 *
 * Both natives hold the mask in a 32-bit signed integer and it crosses the
 * bridge as a `double`, so the value can legitimately be anything from
 * `-2**31` (bit 31 set, read as signed) to `2**32 - 1` (every bit, read as
 * unsigned). Anything outside that is not a mask either writer produced.
 */
const MIN_MASK = -0x8000_0000;
const MAX_MASK = 0xffff_ffff;

/**
 * The names of the bits set in a degradation mask.
 *
 * `[]` for `0`, which is the healthy answer and the common one. The result is
 * frozen: a caller that mutates what a logger handed it should get an error
 * rather than a surprise on the next call.
 *
 * **Unknown high bits are ignored, not reported.** A newer native paired with
 * an older JavaScript bundle can set a bit this build has never heard of, and
 * the useful thing to do with it is nothing — inventing `'bit6'` puts a string
 * in a log line that means nothing to whoever reads it, and throwing turns a
 * cosmetic version skew into a crash in the middle of diagnostics. Compare
 * against the raw mask if you need to know that something unnamed is set.
 *
 * **A negative mask is read as its bits, not rejected.** Both natives hold this
 * in a 32-bit signed integer, so a mask with bit 31 set arrives here as a
 * negative number — refusing negatives outright would discard the five known
 * bits sitting alongside it. The value is normalized with `>>> 0` and then
 * masked, which is what the bits meant on the other side of the bridge.
 * Anything that is not an integer inside 32 bits — a fraction, a `NaN`, a
 * number too large to be a mask, a non-number — is not a mask any writer
 * produces, and answers `[]` rather than whatever JavaScript's own coercion
 * would have made of it.
 *
 * **Payload-free by construction.** The strings are the six literals above and
 * nothing else: no path, no `errno`, no filename can reach this output, which
 * is the same reason the natives report a bitmask instead of a message. See
 * `docs/PRIVACY.md`.
 *
 * ```ts
 * const problems = describeDegradation(logFile.degradation());
 * if (problems.length > 0) {
 *   Log.warning('logging degraded', { degraded: problems.join(',') }, 'diag');
 * }
 * ```
 */
export function describeDegradation(mask: number): readonly string[] {
  if (
    typeof mask !== 'number' ||
    !Number.isInteger(mask) ||
    mask < MIN_MASK ||
    mask > MAX_MASK
  ) {
    return EMPTY;
  }
  const bits = mask >>> 0;
  if (bits === 0) return EMPTY;

  const names: string[] = [];
  for (const [bit, name] of NAMED_BITS) {
    if ((bits & bit) !== 0) names.push(name);
  }
  return names.length === 0 ? EMPTY : Object.freeze(names);
}
