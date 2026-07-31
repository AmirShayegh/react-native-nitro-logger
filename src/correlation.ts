/**
 * Where a correlation ID comes from.
 *
 * **This is hardening, not a leak fix.** The privacy requirement on a
 * correlation ID is *provenance* — that it was generated rather than derived
 * from a patient, visit or record identifier — and `Math.random` satisfied that
 * completely; the ESLint rule `no-derived-correlation` is what enforces it, and
 * nothing here changes. What changes is predictability inside a session: an ID
 * from `Math.random` is drawn from a PRNG whose state another `Math.random`
 * caller in the same JavaScript context can narrow, so IDs are guessable by
 * anything already running in the app. That matters less than it sounds — the
 * IDs are not secrets and grant nothing — but a logger for medical software is
 * the wrong place to leave a guessable identifier when the platform ships a
 * real random source.
 *
 * `Math.random` remains the fallback and always answers, because the one thing
 * this must never do is fail the call that asked for an ID. "Fallback" is meant
 * precisely: it carries the whole ID on a platform with no `crypto`, and it
 * also tops up an ID on a platform that has one, in the vanishingly rare case
 * where a draw yields too few usable bytes. So the honest claim is not "crypto
 * or `Math.random`" but "crypto, with a bounded `Math.random` remainder".
 */

/**
 * Lowercase base36, which is what `Math.random().toString(36)` produced and
 * what the rest of the library has always seen.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Characters per ID. Eight base36 characters is a little over 41 bits. */
const LENGTH = 8;

/**
 * The largest multiple of 36 that fits in a byte (36 × 7).
 *
 * Bytes at or above it are discarded rather than folded in with `%`. Taking
 * `byte % 36` over the full range would make the first four letters of the
 * alphabet marginally likelier than the rest — a bias too small to matter for
 * an identifier and too easy to avoid to be worth defending.
 */
const UNBIASED_CEILING = 252;

/**
 * Bytes drawn per ID.
 *
 * Four times what is needed, so the rejection above is a filter over one draw
 * rather than a loop that asks for more. A byte is usable with probability
 * 252/256; the chance that fewer than eight of thirty-two are usable is far
 * below one in a trillion, and the last line of {@link fromEntropy} tops the ID
 * up from `Math.random` anyway, because "cannot happen" is not a thing to write
 * into a loop bound.
 */
const DRAW = 32;

/** A resolved, receiver-bound entropy source, once one has actually worked. */
let cached: ((into: Uint8Array) => void) | undefined;

/**
 * A fresh correlation ID: eight lowercase base36 characters.
 *
 * The entropy source is resolved on first successful use and cached from then
 * on. **Only success is cached.** A once-and-done probe that also remembered
 * failure would be wrong on React Native specifically: a `crypto` polyfill
 * commonly installs during app startup, after this module has been imported,
 * and a logger that decided at import time would use `Math.random` for the
 * rest of the process without anything indicating why.
 *
 * A cached implementation that later throws is **evicted**, not retried: the
 * global it came from was replaced with something broken, this call answers
 * from `Math.random`, and the next call resolves again — so a working
 * replacement is picked up too.
 */
export function newCorrelationId(): string {
  const fill = cached ?? resolveEntropy();
  if (fill !== undefined) {
    cached = fill;
    try {
      return fromEntropy(fill);
    } catch {
      cached = undefined;
    }
  }
  return fromMathRandom(LENGTH);
}

/**
 * `crypto.getRandomValues` bound to its host, if there is one to bind.
 *
 * Deliberately **not** probed with a throwaway call. A probe would only move
 * where a broken source is discovered, not whether: a partial polyfill that
 * defines the method and throws `not implemented` from it is caught by the
 * eviction path in {@link newCorrelationId} either way, and ends in the same
 * state — nothing cached, `Math.random` answering, the next call resolving
 * again. Two mechanisms for one outcome, and the mutation that deleted the
 * probe passed every test, which is the argument against keeping it.
 *
 * The `try` here is for the lookup itself, which is a different hazard: a host
 * whose `crypto` is a getter that throws must not take the call down with it.
 *
 * The **function** is captured, not a live property lookup on `globalThis`.
 * Once a source has been resolved, reassigning `globalThis.crypto` does not
 * redirect it: the implementation an ID comes from is the one that worked, and
 * swapping it mid-process takes an eviction. That is why the only way back to
 * resolution is the cached source itself failing.
 */
function resolveEntropy(): ((into: Uint8Array) => void) | undefined {
  try {
    const host = globalThis as {
      crypto?: { getRandomValues?: (into: Uint8Array) => Uint8Array };
    };
    const source = host.crypto;
    const getRandomValues = source?.getRandomValues;
    if (typeof getRandomValues !== 'function') return undefined;

    return (into: Uint8Array): void => {
      getRandomValues.call(source, into);
    };
  } catch {
    // Not an entropy source. `Math.random` still answers.
    return undefined;
  }
}

/** Eight characters drawn from one buffer, biased bytes discarded. */
function fromEntropy(fill: (into: Uint8Array) => void): string {
  const bytes = new Uint8Array(DRAW);
  fill(bytes);

  let id = '';
  for (let i = 0; i < bytes.length && id.length < LENGTH; i += 1) {
    const byte = bytes[i]!;
    if (byte >= UNBIASED_CEILING) continue;
    id += ALPHABET[byte % ALPHABET.length];
  }
  // See DRAW: reachable only if nearly every byte in the draw was rejected.
  return id.length === LENGTH ? id : id + fromMathRandom(LENGTH - id.length);
}

/**
 * The fallback, and the only path that is guaranteed to answer.
 *
 * `Math.random` is a global, which means it is replaceable, which means every
 * assumption about it has to be defended rather than believed:
 *
 * - **The loop is bounded.** `slice(2)` drops the leading `"0."`, and a draw of
 *   exactly `0` leaves nothing behind it, so `while (id.length < length)` is a
 *   hung JavaScript thread waiting for a global anyone can reassign. A round
 *   normally yields about ten characters; `length` rounds is already far more
 *   than this needs.
 * - **Characters are filtered, not trusted.** `(-0.5).toString(36)` is
 *   `"-0.i"` and `NaN.toString(36)` is `"NaN"`, so a replaced `Math.random`
 *   can put a `.`, a `-` or an uppercase letter into what is documented as
 *   eight lowercase base36 characters. Anything outside the alphabet is
 *   dropped, and a draw that yields nothing usable ends in the padding below.
 */
function fromMathRandom(length: number): string {
  let id = '';
  for (let round = 0; round < length && id.length < length; round += 1) {
    const draw = Math.random().toString(36).slice(2);
    for (let i = 0; i < draw.length && id.length < length; i += 1) {
      const character = draw[i]!;
      if (ALPHABET.includes(character)) id += character;
    }
  }
  return id.length === length ? id : id.padEnd(length, ALPHABET[0]!);
}

/** Drops the cached source so a test can watch resolution happen again. */
export function resetEntropyForTesting(): void {
  cached = undefined;
}
