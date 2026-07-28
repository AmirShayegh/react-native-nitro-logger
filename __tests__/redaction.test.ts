import { Logger } from '../src/Logger';
import { pub, priv, DROPPED_COUNT_KEY, MAX_CATALOG_SIZE } from '../src/privacy';
import { TestDestination } from './helpers/TestDestination';

declare const globalThis: { __DEV__?: boolean };

function makeLogger() {
  const logger = new Logger();
  const dest = new TestDestination();
  logger.removeDestination('console');
  logger.addDestination(dest);
  return { logger, dest };
}

/** Metadata of the most recent entry. */
function md(dest: TestDestination) {
  return dest.entries[dest.entries.length - 1]!.metadata;
}

const originalDev = globalThis.__DEV__;

function setDev(value: boolean) {
  globalThis.__DEV__ = value;
}

afterEach(() => {
  if (originalDev === undefined) delete globalThis.__DEV__;
  else globalThis.__DEV__ = originalDev;
});

describe('privacy default', () => {
  test("'public' (the OSS default) renders bare values", () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.info('m', { state: 'running', count: 2 });
    expect(md(dest)).toEqual({ state: 'running', count: 2 });
  });

  test("'private' redacts bare values in production", () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.privacyDefault('private').metadataKeyCatalog(['note']);
    logger.info('m', { note: 'PHI leaks here' });
    expect(md(dest)).toEqual({ note: '<private>' });
  });

  test("'private' reveals bare values in dev builds", () => {
    setDev(true);
    const { logger, dest } = makeLogger();
    logger.privacyDefault('private').metadataKeyCatalog(['note']);
    logger.info('m', { note: 'visible while developing' });
    expect(md(dest)).toEqual({ note: 'visible while developing' });
  });

  test('pub() renders under a private default, even in production', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.privacyDefault('private').metadataKeyCatalog(['state', 'note']);
    logger.info('m', { state: pub('running'), note: 'PHI' });
    expect(md(dest)).toEqual({ state: 'running', note: '<private>' });
  });

  test('priv() redacts under a public default, in production', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.info('m', { state: 'running', patientRef: priv('abc') });
    expect(md(dest)).toEqual({ state: 'running', patientRef: '<private>' });
  });

  test('a forgotten wrapper hides data rather than leaking it', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.privacyDefault('private').metadataKeyCatalog(['a', 'b']);
    logger.info('m', { a: pub('ok'), b: 'forgot the wrapper' });
    expect(md(dest)).toEqual({ a: 'ok', b: '<private>' });
  });

  test('first call wins, and later calls may only tighten', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.privacyDefault('public');
    logger.privacyDefault('private'); // tightening is honored
    logger.metadataKeyCatalog(['k']);
    logger.info('m', { k: 'v' });
    expect(md(dest)).toEqual({ k: '<private>' });

    logger.privacyDefault('public'); // loosening is ignored
    logger.info('m', { k: 'v' });
    expect(md(dest)).toEqual({ k: '<private>' });
  });
});

describe('redactAllMetadata', () => {
  test('redacts every value including pub(), and is not undoable', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.redactAllMetadata();
    logger.info('m', { a: 'plain', b: pub('marked public') });
    expect(md(dest)).toEqual({ a: '<private>', b: '<private>' });
  });

  test('redacts in dev builds too', () => {
    setDev(true);
    const { logger, dest } = makeLogger();
    logger.redactAllMetadata();
    logger.info('m', { a: pub('marked public') });
    expect(md(dest)).toEqual({ a: '<private>' });
  });
});

describe('metadata keys', () => {
  test('keys outside the allowed shape are dropped and counted', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.info('m', {
      'ok': 'kept',
      'has space': 'x',
      'sql;drop': 'x',
      'nested.key-1_2': 'also kept',
      '': 'x',
      ['x'.repeat(65)]: 'x',
    });
    expect(md(dest)).toEqual({
      'ok': 'kept',
      'nested.key-1_2': 'also kept',
      [DROPPED_COUNT_KEY]: 4,
    });
  });

  test('the diagnostic reports a count only — never keys or values', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.info('m', { 'patient name': 'Jane Doe', 'ok': 'x' });
    const rendered = JSON.stringify(md(dest));
    expect(rendered).not.toContain('Jane');
    expect(rendered).not.toContain('patient');
    expect(md(dest)![DROPPED_COUNT_KEY]).toBe(1);
  });

  test('the reserved diagnostic key cannot be spoofed by a caller', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.info('m', { [DROPPED_COUNT_KEY]: 999, ok: 'x' });
    expect(md(dest)).toEqual({ ok: 'x', [DROPPED_COUNT_KEY]: 1 });
  });

  test('a configured catalog drops unapproved keys', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.metadataKeyCatalog(['sessionState']);
    logger.info('m', { sessionState: 'active', patient123: 'PHI' });
    expect(md(dest)).toEqual({
      sessionState: 'active',
      [DROPPED_COUNT_KEY]: 1,
    });
  });

  test('a PHI-lookalike literal key is dropped despite being well-formed', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.metadataKeyCatalog(['sessionState']);
    logger.info('m', { patient123: 'Jane Doe' });
    expect(JSON.stringify(md(dest))).not.toContain('Jane');
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  // The two halves of the claim the eslint-plugin README makes about what
  // survives a call site the lint rules could not see. Redaction covers
  // metadata VALUES; a KEY is stopped only by the catalog, and whether one is
  // required depends on the profile.
  test("under 'private', no catalog drops everything rather than passing keys", () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.privacyDefault('private');
    logger.info('m', { patient123: 'Jane Doe', sessionState: 'active' });
    expect(JSON.stringify(md(dest))).not.toContain('Jane');
    expect(JSON.stringify(md(dest))).not.toContain('patient');
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 2 });
  });

  test("under 'public', no catalog keeps any regex-valid key", () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    // The OSS default. `patient123` satisfies the key pattern, so nothing in
    // the runtime stops it — which is why the plugin's key rule matters and
    // why the README tells anyone logging sensitive data to set a catalog.
    logger.info('m', { patient123: 'x' });
    expect(md(dest)).toEqual({ patient123: 'x' });
  });

  test('repeat catalog calls intersect rather than replace', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.metadataKeyCatalog(['a', 'b']);
    logger.metadataKeyCatalog(['b', 'c']); // widening to 'c' is not honored
    logger.info('m', { a: '1', b: '2', c: '3' });
    expect(md(dest)).toEqual({ b: '2', [DROPPED_COUNT_KEY]: 2 });
  });

  test('a private default with no catalog fails closed: everything drops', () => {
    setDev(true); // even in dev, an unconfigured catalog approves nothing
    const { logger, dest } = makeLogger();
    logger.privacyDefault('private');
    logger.info('m', { anything: 'at all' });
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  test('a public default without a catalog keeps well-formed keys', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.info('m', { anything: 'at all' });
    expect(md(dest)).toEqual({ anything: 'at all' });
  });
});

describe('value validation at emit', () => {
  test('non-primitive values are dropped and counted', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.info('m', {
      ok: 'yes',
      nested: { phi: 'leak' } as never,
      list: ['leak'] as never,
      fn: (() => 'leak') as never,
      inf: Infinity,
      nan: NaN,
      nothing: null as never,
    });
    expect(md(dest)).toEqual({ ok: 'yes', [DROPPED_COUNT_KEY]: 6 });
  });

  test('a marker built from an object payload fails closed at emit', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.info('m', {
      smuggled: pub({ patient: 'PHI' } as never),
      ok: 'yes',
    });
    expect(JSON.stringify(md(dest))).not.toContain('PHI');
    expect(md(dest)).toEqual({ ok: 'yes', [DROPPED_COUNT_KEY]: 1 });
  });

  test('a foreign lookalike object is dropped, not treated as public', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    const impostor = {
      toString: () => '<redacted>',
      [Symbol.toStringTag]: 'RedactedLogValue',
    };
    logger.info('m', { fake: impostor as never });
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  test('scope metadata goes through the same resolution as call-site metadata', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.privacyDefault('private').metadataKeyCatalog(['user', 'state']);
    const scope = logger.scoped('s-1', undefined, {
      user: priv('u1'),
      patient123: 'PHI',
    });
    scope.info('m', { state: pub('running') });
    expect(JSON.stringify(md(dest))).not.toContain('PHI');
    expect(md(dest)).toEqual({
      user: '<private>',
      state: 'running',
      [DROPPED_COUNT_KEY]: 1,
    });
  });

  test('markers survive the scope merge with call-site precedence intact', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    const scope = logger.scoped('s-1', undefined, { state: priv('running') });
    scope.info('m', { state: pub('failed') });
    expect(md(dest)).toEqual({ state: 'failed' });
  });

  test('no metadata still means no metadata', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.info('m');
    expect(md(dest)).toBeUndefined();
  });
});

describe('fail-closed handling of untrusted configuration', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['mixed case', 'Public'],
    ['uppercase', 'PUBLIC'],
    ['padded', ' public '],
    ['arbitrary string', 'off'],
    ['empty string', ''],
    ['object', { toString: () => 'public' }],
    ['array', ['public']],
    ['number', 0],
    ['boolean', false],
  ])('privacyDefault(%s) resolves to private, not public', (_label, value) => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.privacyDefault(value as never).metadataKeyCatalog(['k']);
    logger.info('m', { k: 'PHI' });
    expect(md(dest)).toEqual({ k: '<private>' });
  });

  test('a malformed privacy default still locks the setting', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.privacyDefault(null as never); // → private, locked
    logger.privacyDefault('public'); // loosening is ignored
    logger.metadataKeyCatalog(['k']);
    logger.info('m', { k: 'PHI' });
    expect(md(dest)).toEqual({ k: '<private>' });
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain object', { a: 1 }],
    ['a bare string', 'abc'],
  ])(
    'metadataKeyCatalog(%s) approves nothing rather than throwing',
    (_label, value) => {
      setDev(false);
      const { logger, dest } = makeLogger();
      expect(() => logger.metadataKeyCatalog(value as never)).not.toThrow();
      logger.info('m', { k: 'v' });
      expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
    }
  );

  test('a throwing iterator yields an empty catalog, not an exception', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    const hostile = {
      *[Symbol.iterator]() {
        yield 'k';
        throw new Error('iterator blew up');
      },
    };
    expect(() => logger.metadataKeyCatalog(hostile)).not.toThrow();
    logger.info('m', { k: 'v' });
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  test('a non-string or malformed catalog entry rejects the whole catalog', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    logger.metadataKeyCatalog(['k', 42 as never]);
    logger.info('m', { k: 'v' });
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  test('an over-long catalog is rejected rather than hanging the thread', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    const tooMany = Array.from(
      { length: MAX_CATALOG_SIZE + 2 },
      (_, i) => `k${i}`
    );
    logger.metadataKeyCatalog(tooMany);
    logger.info('m', { k0: 'v' });
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  test('an unbounded iterable is cut off instead of looping forever', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    const infinite = {
      *[Symbol.iterator]() {
        for (let i = 0; ; i++) yield `k${i}`;
      },
    };
    expect(() => logger.metadataKeyCatalog(infinite)).not.toThrow();
    logger.info('m', { k0: 'v' });
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  test('an infinite iterable of ONE repeated key still terminates', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    // The bound has to count consumed entries, not set size: a duplicate
    // key never grows the set, so a size-based cap would spin forever.
    const repeating = {
      *[Symbol.iterator]() {
        for (;;) yield 'k';
      },
    };
    expect(() => logger.metadataKeyCatalog(repeating)).not.toThrow();
    logger.info('m', { k: 'v' });
    expect(md(dest)).toEqual({ [DROPPED_COUNT_KEY]: 1 });
  });

  test('the exported key rule cannot be mutated to disable validation', () => {
    setDev(false);
    const surface = require('../src/privacy') as Record<string, unknown>;
    // Only the source string is exported; a shared RegExp object could be
    // given an own `test` method and silently switch off key validation.
    for (const value of Object.values(surface)) {
      expect(value).not.toBeInstanceOf(RegExp);
    }
    expect(typeof surface.METADATA_KEY_PATTERN_SOURCE).toBe('string');

    const { logger, dest } = makeLogger();
    logger.info('m', { 'has space': 'PHI', 'ok': 'x' });
    expect(md(dest)).toEqual({ ok: 'x', [DROPPED_COUNT_KEY]: 1 });
  });
});

describe('key validation happens before any value is read', () => {
  test('a getter behind a malformed key never runs', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    let touched = false;
    const metadata = {
      ok: 'kept',
      get ['has space']() {
        touched = true;
        return 'PHI';
      },
    };
    logger.info('m', metadata as never);
    expect(touched).toBe(false);
    expect(md(dest)).toEqual({ ok: 'kept', [DROPPED_COUNT_KEY]: 1 });
  });

  test('a getter behind an unapproved key never runs', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    let touched = false;
    const metadata = {
      approved: 'kept',
      get patient123() {
        touched = true;
        return 'PHI';
      },
    };
    logger.metadataKeyCatalog(['approved']);
    logger.info('m', metadata as never);
    expect(touched).toBe(false);
    expect(md(dest)).toEqual({ approved: 'kept', [DROPPED_COUNT_KEY]: 1 });
  });

  test('a getter behind the reserved diagnostic key never runs', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    let touched = false;
    const metadata = {
      ok: 'kept',
      get [DROPPED_COUNT_KEY]() {
        touched = true;
        return 999;
      },
    };
    logger.info('m', metadata as never);
    expect(touched).toBe(false);
    expect(md(dest)).toEqual({ ok: 'kept', [DROPPED_COUNT_KEY]: 1 });
  });

  test('an approved key whose getter throws is counted, not silently lost', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    const metadata = {
      ok: 'kept',
      get boom(): string {
        throw new Error('getter threw');
      },
    };
    expect(() => logger.info('m', metadata)).not.toThrow();
    expect(md(dest)).toEqual({ ok: 'kept', [DROPPED_COUNT_KEY]: 1 });
  });

  test('a scoped call gets the same key-before-value guarantee', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    const scope = logger.scoped('s-1', undefined, { user: 'u1' });
    let malformed = false;
    let unapproved = false;
    let reserved = false;
    const callSite = {
      ok: 'kept',
      get ['has space']() {
        malformed = true;
        return 'PHI';
      },
      get patient123() {
        unapproved = true;
        return 'PHI';
      },
      get [DROPPED_COUNT_KEY]() {
        reserved = true;
        return 999;
      },
    };
    logger.metadataKeyCatalog(['user', 'ok']);
    scope.info('m', callSite as never);
    expect(malformed).toBe(false);
    expect(unapproved).toBe(false);
    expect(reserved).toBe(false);
    expect(md(dest)).toEqual({
      user: 'u1',
      ok: 'kept',
      [DROPPED_COUNT_KEY]: 3,
    });
  });

  test('a scoped call-site getter that throws is counted', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    const scope = logger.scoped('s-1', undefined, { user: 'u1' });
    const callSite = {
      get boom(): string {
        throw new Error('getter threw');
      },
    };
    expect(() => scope.info('m', callSite)).not.toThrow();
    expect(md(dest)).toEqual({ user: 'u1', [DROPPED_COUNT_KEY]: 1 });
  });

  test('a scope-metadata getter that throws is counted, not lost', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    // Read at construction, so the key is preserved with an unreadable
    // marker and still shows up in the count on every message it affects.
    const scope = logger.scoped('s-1', undefined, {
      ok: 'kept',
      get boom(): string {
        throw new Error('getter threw');
      },
    });
    scope.info('m');
    expect(md(dest)).toEqual({ ok: 'kept', [DROPPED_COUNT_KEY]: 1 });
  });

  test('an undefined scope value is counted, matching direct metadata', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    // A JS caller can supply undefined; it is a rejected value, not an
    // absent key, and must not under-report relative to direct metadata.
    const scope = logger.scoped('s-1', undefined, {
      ok: 'kept',
      gone: undefined as never,
    });
    scope.info('m');
    expect(md(dest)).toEqual({ ok: 'kept', [DROPPED_COUNT_KEY]: 1 });

    const direct = makeLogger();
    direct.logger.info('m', { ok: 'kept', gone: undefined as never });
    expect(md(direct.dest)).toEqual({ ok: 'kept', [DROPPED_COUNT_KEY]: 1 });
  });

  test('a hostile metadata container cannot reach the redaction path', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    // Metadata is always a plain object field — never a collection the
    // caller can make throw or iterate forever.
    const hostileArray = Object.assign([], {
      [Symbol.iterator]() {
        throw new Error('iterator blew up');
      },
    });
    expect(() => logger.info('m', hostileArray as never)).not.toThrow();
    expect(md(dest)).toBeUndefined();

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(() => logger.info('m2', revoked.proxy as never)).not.toThrow();
    expect(md(dest)).toBeUndefined();
  });

  test('a call-site override means the scope getter is never read', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    let scopeRead = 0;
    const scope = logger.scoped('s-1', undefined, { state: 'running' });
    // Precedence is settled by key first, so the losing source is not read.
    const callSite = {
      get state() {
        scopeRead += 1;
        return 'failed';
      },
    };
    scope.info('m', callSite);
    expect(scopeRead).toBe(1);
    expect(md(dest)).toEqual({ state: 'failed' });
  });

  test('metadata that cannot be enumerated at all yields nothing', () => {
    setDev(false);
    const { logger, dest } = makeLogger();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys trap threw');
        },
      }
    );
    expect(() => logger.info('m', hostile as never)).not.toThrow();
    expect(md(dest)).toBeUndefined();
  });
});
