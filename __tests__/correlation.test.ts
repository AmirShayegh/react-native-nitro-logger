import { newCorrelationId, resetEntropyForTesting } from '../src/correlation';

/**
 * Where a correlation ID comes from, and what happens when that moves.
 *
 * The interesting behaviour is not the ID — it is the resolution policy around
 * it. `crypto` is not reliably present when this module is imported: on React
 * Native a polyfill commonly installs during startup, after the first import,
 * so a logger that decided once at import time would spend the rest of the
 * process on `Math.random` with nothing indicating why. Only success is
 * cached, and a cached source that starts throwing is evicted.
 *
 * ## What these do NOT prove
 *
 * **That the IDs are unpredictable.** Nothing in a unit test can establish
 * that. These assert which *source* was consulted, which is the part the
 * library decides. Whether `crypto.getRandomValues` is a real CSPRNG is the
 * platform's promise, and on the `Math.random` fallback it is explicitly not
 * claimed at all.
 *
 * **That `Math.random` is never used on a healthy device.** The top-up path in
 * `fromEntropy` can mix it in when a draw is almost entirely rejected — far
 * below one in a trillion, and deliberately not asserted against, because a
 * test that pinned it would be pinning the probability rather than the code.
 */

type CryptoHost = { crypto?: unknown };

const host = globalThis as CryptoHost;

/**
 * The original *descriptor*, not the original value.
 *
 * Node exposes `globalThis.crypto` through an accessor. Restoring it by
 * assigning the value back would leave a plain writable data property behind —
 * the same object, a different shape — and the next suite to look at the global
 * would see something this file invented.
 */
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

/** An entropy source that records its calls and fills the buffer. */
function spyCrypto(): { calls: number; getRandomValues: () => void } {
  const spy = {
    calls: 0,
    getRandomValues(into: Uint8Array) {
      spy.calls += 1;
      for (let i = 0; i < into.length; i += 1) into[i] = (i * 7 + 3) % 251;
      return into;
    },
  };
  return spy as unknown as { calls: number; getRandomValues: () => void };
}

function install(value: unknown): void {
  Object.defineProperty(host, 'crypto', {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  resetEntropyForTesting();
});

afterEach(() => {
  if (realCrypto) {
    Object.defineProperty(globalThis, 'crypto', realCrypto);
  } else {
    // There was no such property. Leaving one behind would be this file
    // handing every later suite a global the environment does not have.
    delete host.crypto;
  }
  resetEntropyForTesting();
});

describe('newCorrelationId', () => {
  test('answers eight lowercase base36 characters', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newCorrelationId()).toMatch(/^[a-z0-9]{8}$/);
    }
  });

  test('a fresh draw produces a fresh id', () => {
    // Driven by a counter rather than the real source. Five hundred IDs from a
    // genuine CSPRNG are *probably* distinct, and a test that asserts
    // "probably" is a test that fails in CI one morning for no reason. What is
    // worth pinning is that each ID comes from that call's bytes — a generator
    // that returned a constant, or cached its first answer, is what this
    // catches, and against a deterministic source it catches it every time.
    let call = 0;
    install({
      getRandomValues(into: Uint8Array) {
        call += 1;
        // The call number in base 36, one digit per byte. Every byte is below
        // the rejection ceiling, and `byte % 36` is the identity on it, so the
        // ID is the call number spelled in the alphabet — distinct calls give
        // distinct IDs by construction rather than by luck.
        let remaining = call;
        for (let i = 0; i < into.length; i += 1) {
          into[i] = remaining % 36;
          remaining = Math.floor(remaining / 36);
        }
        return into;
      },
    });

    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(newCorrelationId());
    expect(seen.size).toBe(500);
  });

  test('uses crypto when the platform has it', () => {
    const spy = spyCrypto();
    install(spy);
    newCorrelationId();
    expect(spy.calls).toBeGreaterThan(0);
  });

  test('a platform with no crypto still answers', () => {
    install(undefined);
    expect(newCorrelationId()).toMatch(/^[a-z0-9]{8}$/);
  });

  /**
   * The React Native case: the polyfill arrives after this module is imported.
   *
   * A once-and-done probe would have chosen `Math.random` on the first call
   * and never looked again.
   */
  test('crypto installed after the first call is adopted', () => {
    install(undefined);
    expect(newCorrelationId()).toMatch(/^[a-z0-9]{8}$/);

    const late = spyCrypto();
    install(late);
    newCorrelationId();
    expect(late.calls).toBeGreaterThan(0);
  });

  test('a source that throws is declined, not propagated', () => {
    install({
      getRandomValues() {
        throw new Error('not implemented on this platform');
      },
    });
    // A partial polyfill: the method exists and the platform behind it does
    // not. Answering is not optional — this is the call that names a unit of
    // work, and failing it fails whatever was being logged.
    expect(() => newCorrelationId()).not.toThrow();
    expect(newCorrelationId()).toMatch(/^[a-z0-9]{8}$/);
  });

  /**
   * A cached source that starts throwing is dropped, and a working
   * replacement is picked up.
   *
   * Without eviction the library would keep calling something it already knows
   * is broken, and would never notice the global being repaired.
   */
  test('a cached source that breaks is evicted and re-resolved', () => {
    // Works once, then stops — an entropy pool that went away, or a native
    // module torn down under a source that had been answering. The first call
    // has to succeed, or this would only be testing that a source broken from
    // the start is declined, which is the test above.
    let calls = 0;
    const failing = {
      getRandomValues(into: Uint8Array) {
        calls += 1;
        if (calls > 1) throw new Error('device entropy went away');
        into.fill(7);
        return into;
      },
    };
    install(failing);

    // First call: succeeds, and the source is cached.
    expect(newCorrelationId()).toMatch(/^[a-z0-9]{8}$/);
    expect(calls).toBe(1);

    // Replacing the global now proves the capture: the cached binding is the
    // function, so this call still goes to `failing` and not to the
    // replacement — which is exactly what makes eviction the only way back.
    const replacement = spyCrypto();
    install(replacement);
    expect(() => newCorrelationId()).not.toThrow();
    expect(calls).toBe(2);
    expect(replacement.calls).toBe(0);

    // Evicted by that throw, so the next call resolves what is there now.
    newCorrelationId();
    expect(replacement.calls).toBe(1);
  });

  /**
   * Bytes that would bias the alphabet are discarded, not folded in.
   *
   * `byte % 36` over the whole 0–255 range would make the first four letters
   * marginally likelier than the rest, because 256 is not a multiple of 36.
   * A statistical test for that would be slow and flaky; this feeds a crafted
   * sequence instead and pins the exact characters, which is deterministic and
   * fails the moment the ceiling stops being applied.
   */
  test('bytes at or above the rejection ceiling are discarded', () => {
    install({
      getRandomValues(into: Uint8Array) {
        // The four bytes that cannot map without bias, then 0..n.
        const head = [252, 253, 254, 255];
        for (let i = 0; i < into.length; i += 1) {
          into[i] = i < head.length ? head[i]! : i - head.length;
        }
        return into;
      },
    });
    // With the ceiling: the first four are skipped and the ID starts at 0.
    // Without it, 252 % 36 === 0 and the ID would read 'abcdabcd'.
    expect(newCorrelationId()).toBe('abcdefgh');
  });

  test('a source that fills nothing still yields a well-formed id', () => {
    // Every byte at or above the rejection ceiling: the draw contributes
    // nothing and the top-up path has to carry the whole ID.
    install({
      getRandomValues(into: Uint8Array) {
        into.fill(255);
        return into;
      },
    });
    expect(newCorrelationId()).toMatch(/^[a-z0-9]{8}$/);
  });

  test('a hostile crypto getter cannot break the call', () => {
    Object.defineProperty(host, 'crypto', {
      get() {
        throw new Error('hostile getter');
      },
      configurable: true,
    });
    expect(newCorrelationId()).toMatch(/^[a-z0-9]{8}$/);
  });

  /**
   * `Math.random` is a global too, and the fallback has to survive it.
   *
   * `(-0.5).toString(36)` is `"-0.i"` and `NaN.toString(36)` is `"NaN"`, so a
   * replaced implementation can hand the fallback a `.`, a `-` or an uppercase
   * letter. The documented shape is eight lowercase base36 characters, and it
   * stays that whatever the global has been turned into.
   */
  test('a replaced Math.random cannot change the shape of an id', () => {
    install(undefined);
    const realRandom = Math.random;
    try {
      for (const stub of [
        () => -0.5,
        () => Number.NaN,
        () => 0,
        () => 1,
        () => 1e21,
        () => Number.POSITIVE_INFINITY,
      ]) {
        Math.random = stub;
        expect(newCorrelationId()).toMatch(/^[a-z0-9]{8}$/);
      }
    } finally {
      Math.random = realRandom;
    }
  });
});
