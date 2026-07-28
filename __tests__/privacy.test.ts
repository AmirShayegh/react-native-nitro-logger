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

  test('the module exposes no payload-recovery export', () => {
    // A deep import of the compiled module must not hand back a payload,
    // so nothing here may return one. If this fails, a reveal path was
    // added: co-locate it with redaction and keep it module-private.
    const surface: Record<string, unknown> = require('../src/privacy');
    const returnsPayload = Object.entries(surface)
      .filter(([, v]) => typeof v === 'function')
      .filter(([name]) => name !== 'pub' && name !== 'priv')
      .map(([name, fn]) => {
        try {
          return [name, (fn as (x: unknown) => unknown)(priv('SECRET'))];
        } catch {
          return [name, undefined];
        }
      })
      .filter(([, result]) => JSON.stringify(result ?? '').includes('SECRET'));
    expect(returnsPayload).toEqual([]);
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
