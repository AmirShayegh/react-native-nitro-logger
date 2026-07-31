import { Logger } from '../src/Logger';
import { pub, priv, DROPPED_COUNT_KEY } from '../src/privacy';
import { TestDestination } from './helpers/TestDestination';

declare const globalThis: { __DEV__?: boolean };

/**
 * Markers are exercised through the logging pipeline on purpose. The module
 * exports no way to recover a payload — that is the point of the design — so
 * a test that unwrapped one directly would be testing an API that must not
 * exist.
 */
function makeLogger() {
  const logger = new Logger();
  const dest = new TestDestination();
  logger.removeDestination('console');
  logger.addDestination(dest);
  return { logger, dest };
}

function md(dest: TestDestination) {
  return dest.entries[dest.entries.length - 1]!.metadata;
}

const originalDev = globalThis.__DEV__;

afterEach(() => {
  if (originalDev === undefined) delete globalThis.__DEV__;
  else globalThis.__DEV__ = originalDev;
});

/**
 * Whether the probe payload is anywhere inside a returned value.
 *
 * `JSON.stringify` is the wrong tool: a `Set` and a `Map` both stringify to
 * `{}` regardless of contents, and `buildCatalog` returns a `Set` — so the
 * one export whose return type hides its members from `JSON` would be swept
 * with an assertion that could never fail. This walks the structure instead,
 * and reads keys as well as values because a payload used as a key leaks
 * exactly as much as one used as a value.
 *
 * Every decision here is made in the fail-*closed* direction, because the
 * opposite ones are what make a privacy sweep quietly worthless:
 *
 *   - **No depth cap.** A cap returns "clean" for a structure it declined to
 *     look at. `seen` alone terminates the walk on any finite object graph,
 *     which is the only thing a bound was needed for.
 *   - **Functions are invoked, not skipped.** A closure over the payload is a
 *     leak, and skipping one calls it clean. A marker's own
 *     `toString`/`toJSON`/`Symbol.toPrimitive` are functions, and they answer
 *     with the placeholder, which is the design and passes. Functions that
 *     take arguments are called too, with a small fixed corpus — otherwise
 *     `(ignored) => payload` is a recovery path that reads clean on arity
 *     alone.
 *
 * The one thing it still cannot see: a function needing a *specific*
 * argument to give up its payload. Nothing in this module returns a function
 * at all, so that shape would have to be introduced deliberately.
 */
const CALL_CORPUS: readonly unknown[] = [undefined, 'probe', 0];

function containsPayload(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === 'string') return value.includes('SECRET');
  if (typeof value === 'symbol') return String(value).includes('SECRET');
  if (typeof value === 'function') {
    if (seen.has(value)) return false;
    seen.add(value);
    const attempts: unknown[][] =
      value.length === 0
        ? [[]]
        : CALL_CORPUS.map((arg) => new Array(value.length).fill(arg));
    return attempts.some((args) => {
      try {
        return containsPayload(
          (value as (...a: unknown[]) => unknown)(...args),
          seen
        );
      } catch {
        return false; // A refusal to answer is not an answer that leaks.
      }
    });
  }
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  const nested: unknown[] = [];
  if (value instanceof Set) nested.push(...value);
  else if (value instanceof Map)
    nested.push(...value.keys(), ...value.values());
  else if (Array.isArray(value)) nested.push(...value);
  else {
    for (const key of Reflect.ownKeys(value)) {
      nested.push(key);
      // A throwing getter is the module refusing to answer, not a leak.
      try {
        nested.push((value as Record<PropertyKey, unknown>)[key]);
      } catch {
        /* empty */
      }
    }
  }
  // Markers render as a fixed placeholder, so a marker that reached the output
  // is not itself a leak — only its payload showing through would be, and that
  // is what the recursion looks for.
  return nested.some((child) => containsPayload(child, seen));
}

/**
 * Arguments each export is happy to be called with, marker aside.
 *
 * The sweep injects the marker into one position at a time and needs the
 * *other* positions to be values the export will accept — otherwise it throws
 * on a companion argument and the probe never reaches the code it was meant
 * to exercise. That is not a hypothetical: filling every other position with
 * `undefined` makes `redactMetadata` throw on `settings.keyCatalog` before it
 * reads any metadata at all, so the position markers most often arrive in was
 * being counted as swept while executing nothing.
 *
 * The table is also the sweep's inventory. An export missing from it fails
 * the test rather than being skipped, so a new one has to be given arguments
 * deliberately instead of silently going unchecked.
 */
const PROBE_BASELINE: Record<string, readonly unknown[]> = {
  isValidMetadataKey: ['ok'],
  __revealBranchSentinel: [],
  normalizePrivacyDefault: ['public'],
  buildCatalog: [['ok', 'probe']],
  redactMetadata: [
    { ok: 'scope value' },
    { ok: 'call-site value' },
    {
      privacyDefault: 'public',
      redactAll: false,
      // `probe` is in the catalog on purpose: an unapproved key is dropped
      // before redaction runs, which would route the marker away from the
      // path this sweep exists to walk.
      keyCatalog: new Set(['ok', 'probe']),
    },
  ],
};

describe('privacy markers', () => {
  test('never expose the payload through any standard channel', () => {
    const marker = priv('SECRET');

    expect(String(marker)).toBe('<redacted>');
    expect(`${marker}`).toBe('<redacted>');
    expect(marker.toString()).toBe('<redacted>');
    expect(JSON.stringify(marker)).toBe('"<redacted>"');
    expect(JSON.stringify({ v: marker })).toBe('{"v":"<redacted>"}');
    expect(Object.keys(marker)).toEqual([]);
    expect(Object.values(marker)).toEqual([]);
    expect(Object.entries(marker)).toEqual([]);
    expect({ ...marker }).toEqual({});
    expect(JSON.stringify({ ...marker })).toBe('{}');
  });

  test('the payload is unreachable by enumeration or serialization', () => {
    const marker = pub('SECRET');
    const seen = [
      JSON.stringify(marker),
      JSON.stringify({ ...marker }),
      String(marker),
      Object.getOwnPropertyNames(marker).join(','),
      Object.getOwnPropertySymbols(marker).map(String).join(','),
      Object.getOwnPropertyNames(marker)
        .map((k) => String((marker as unknown as Record<string, unknown>)[k]))
        .join(','),
    ].join('|');
    expect(seen).not.toContain('SECRET');
  });

  test('markers are frozen and identify themselves as redacted', () => {
    const marker = priv('x');
    expect(Object.isFrozen(marker)).toBe(true);
    expect(Object.prototype.toString.call(marker)).toBe(
      '[object RedactedLogValue]'
    );
  });

  test('the module exposes no payload-recovery export, in any position', () => {
    // A deep import of the compiled module must not hand back a payload, so
    // nothing here may return one. If this fails, a reveal path was added:
    // co-locate it with redaction and keep it module-private.
    //
    // Three things this sweep gets wrong if written the obvious way, each of
    // which leaves it green while checking less than it claims:
    //
    //   1. Sweeping argument *zero* only. `redactMetadata`'s call-site
    //      parameter is where markers actually arrive, and it is position 1.
    //   2. Filling the other positions with `undefined`. `redactMetadata`
    //      then throws on `settings.keyCatalog` before reading any metadata,
    //      so the position is counted as probed having executed nothing.
    //      Hence `PROBE_BASELINE`, and hence `completed` below — a call that
    //      threw is not a call that was checked.
    //   3. `JSON.stringify` as the detector. `buildCatalog` returns a `Set`,
    //      which stringifies to `{}` whatever is in it.
    const surface: Record<string, unknown> = require('../src/privacy');
    const fns = Object.entries(surface)
      .filter(([, v]) => typeof v === 'function')
      .filter(([name]) => name !== 'pub' && name !== 'priv') as Array<
      [string, (...args: unknown[]) => unknown]
    >;

    // Fail closed on an export nobody gave arguments to, rather than sweeping
    // it with `undefined`s and reporting a pass.
    expect(fns.map(([name]) => name).sort()).toEqual(
      Object.keys(PROBE_BASELINE).sort()
    );

    const completed = new Set<string>();
    const leaked: string[] = [];

    for (const [name, fn] of fns) {
      const baseline = PROBE_BASELINE[name]!;
      // A zero-arity export is still called once: it can close over state.
      const arity = Math.max(fn.length, baseline.length, 1);
      for (let position = 0; position < arity; position += 1) {
        // The bare marker, and the container shape the library actually
        // receives markers in — a metadata object with one under a key.
        for (const shape of [priv('SECRET'), { probe: priv('SECRET') }]) {
          const args = Array.from({ length: arity }, (_, i) => baseline[i]);
          args[position] = shape;
          let result: unknown;
          try {
            result = fn(...args);
          } catch {
            continue; // A rejected argument is a refusal, not a leak.
          }
          completed.add(`${name}:${position}`);
          if (containsPayload(result)) leaked.push(`${name}:${position}`);
        }
      }
    }

    expect(leaked).toEqual([]);

    // The exact set, not a floor. A floor of seven is met just as well by an
    // export vanishing while another gains a parameter, and it cannot say
    // *which* surface stopped being checked. These are the positions that ran
    // to completion — anything that only threw is absent by construction.
    expect([...completed].sort()).toEqual([
      '__revealBranchSentinel:0',
      'buildCatalog:0',
      'isValidMetadataKey:0',
      'normalizePrivacyDefault:0',
      'redactMetadata:0',
      'redactMetadata:1',
      'redactMetadata:2',
    ]);
  });

  test('a foreign lookalike is not treated as a marker', () => {
    globalThis.__DEV__ = false;
    const { logger, dest } = makeLogger();
    const impostor = {
      toString: () => '<redacted>',
      toJSON: () => '<redacted>',
      [Symbol.toPrimitive]: () => '<redacted>',
      [Symbol.toStringTag]: 'RedactedLogValue',
    };
    // Not registered in the module-private map, so it resolves to nothing
    // rather than being trusted as a public value.
    logger.info('m', { fake: impostor as never });
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  test('non-primitive payloads are rejected at construction, not thrown', () => {
    globalThis.__DEV__ = false;
    const hostile: unknown[] = [
      { patient: 'PHI' },
      ['PHI'],
      new Proxy({ patient: 'PHI' }, {}),
      () => 'PHI',
      Symbol('PHI'),
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      10n,
    ];
    for (const value of hostile) {
      // `as never`: exactly the JS-caller bypasses TypeScript would block.
      expect(() => pub(value as never)).not.toThrow();
      expect(() => priv(value as never)).not.toThrow();

      const { logger, dest } = makeLogger();
      logger.info('m', { a: pub(value as never), b: priv(value as never) });
      expect(JSON.stringify(md(dest))).not.toContain('PHI');
      expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 2 });
    }
  });

  test('a nested marker is not a valid payload', () => {
    globalThis.__DEV__ = false;
    const { logger, dest } = makeLogger();
    logger.info('m', { a: pub(priv('SECRET') as never) });
    expect(JSON.stringify(md(dest))).not.toContain('SECRET');
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  test('only finite primitives survive as values', () => {
    globalThis.__DEV__ = false;
    const { logger, dest } = makeLogger();
    logger.info('m', {
      s: pub('s'),
      n: pub(-1.5),
      zero: pub(0),
      b: pub(true),
      nan: pub(NaN),
      inf: pub(Infinity),
    });
    expect(md(dest)).toEqual({
      s: 's',
      n: -1.5,
      zero: 0,
      b: true,
      [DROPPED_COUNT_KEY]: 2,
    });
  });
});
