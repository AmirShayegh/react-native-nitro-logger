import { Logger } from '../src/Logger';
import { TestDestination } from './helpers/TestDestination';
import type { LogMetadata } from '../src/types';

function makeLogger() {
  const logger = new Logger();
  const dest = new TestDestination();
  logger.removeDestination('console');
  logger.addDestination(dest);
  return { logger, dest };
}

describe('ScopedLogger', () => {
  test('tags every message with correlation and subsystem', () => {
    const { logger, dest } = makeLogger();
    const job = logger.scoped('job-1', 'decoder');
    job.info('started');
    expect(dest.entries[0]).toMatchObject({
      correlation: 'job-1',
      subsystem: 'decoder',
      message: 'started',
    });
  });

  test('auto-generates a correlation ID when omitted', () => {
    const { logger, dest } = makeLogger();
    logger.scoped().info('anon');
    expect(dest.entries[0]!.correlation).toMatch(/^[a-z0-9]{4,}$/);
  });

  /**
   * A generated correlation belongs to one unit of work, not to the logger.
   *
   * The shape assertion above holds just as well for a logger that generated
   * one ID and handed the same one to every scope for the rest of the
   * process — and that logger is useless in the exact situation correlation
   * exists for, which is telling two concurrent units of work apart in a file
   * where their lines are interleaved. `newCorrelationId`'s own suite proves
   * successive *draws* differ; what is unpinned until here is that
   * `Logger.scoped` takes a fresh draw per scope rather than reusing one.
   *
   * This is deliberately the opposite of what a *child* scope does — a child
   * inherits, because it is the same unit of work seen closer up. Both rules
   * are pinned; they are not in tension.
   *
   * Driven by a counter rather than the real generator, for the reason
   * `correlation.test.ts` gives at length: twenty real IDs are *probably*
   * distinct, and a test asserting "probably" is one that fails in CI one
   * morning for no reason. What is worth pinning is the policy — one draw per
   * scope — which a deterministic source pins exactly.
   */
  test('each generated correlation is its own, never the logger reusing one', () => {
    const { logger, dest } = makeLogger();
    let drawn = 0;
    const draw = jest
      .spyOn(logger, 'newCorrelationId')
      .mockImplementation(() => `id-${drawn++}`);

    for (let i = 0; i < 20; i += 1) logger.scoped().info(`unit ${i}`);

    // Both halves: a logger that drew once and reused it fails the count, and
    // one that drew twenty times but tagged every message with the last fails
    // the sequence.
    expect(draw).toHaveBeenCalledTimes(20);
    expect(dest.entries.map((e) => e.correlation)).toEqual(
      Array.from({ length: 20 }, (_, i) => `id-${i}`)
    );
  });

  test('scope metadata rides every message; call-site wins on collision', () => {
    const { logger, dest } = makeLogger();
    const session = logger.scoped('s-1', undefined, {
      user: 'u1',
      state: 'running',
    });
    session.info('started');
    session.error('failed', { state: 'failed' });
    expect(dest.entries[0]!.metadata).toEqual({ user: 'u1', state: 'running' });
    expect(dest.entries[1]!.metadata).toEqual({ user: 'u1', state: 'failed' });
  });

  test('child scopes merge parent metadata and inherit subsystem', () => {
    const { logger, dest } = makeLogger();
    const pipeline = logger.scoped('p-1', 'pipeline', { user: 'u1' });
    const child = pipeline.scoped('c-1', undefined, { task: 'sync' });
    child.info('working');
    expect(dest.entries[0]).toMatchObject({
      correlation: 'c-1',
      subsystem: 'pipeline',
    });
    expect(dest.entries[0]!.metadata).toEqual({ user: 'u1', task: 'sync' });
  });

  test('child scope can override the subsystem', () => {
    const { logger, dest } = makeLogger();
    const parent = logger.scoped('p-1', 'pipeline');
    parent.scoped('io-1', 'io').info('io work');
    expect(dest.entries[0]!.subsystem).toBe('io');
  });

  test('scope subsystem participates in level filtering', () => {
    const { logger, dest } = makeLogger();
    logger.minimumLevel('error').subsystem('sync', 'debug');
    logger.scoped('job', 'sync').debug('allowed by subsystem');
    logger.scoped('job2', 'other').debug('blocked by global');
    expect(dest.messages).toEqual(['allowed by subsystem']);
  });

  test('mutating the original metadata object after scope creation has no effect', () => {
    const { logger, dest } = makeLogger();
    const original: LogMetadata = { user: 'u1' };
    const scope = logger.scoped('s-1', undefined, original);
    original.user = 'changed';
    original.extra = 'added later';
    scope.info('m');
    expect(dest.entries[0]!.metadata).toEqual({ user: 'u1' });
  });

  test('the exposed scope metadata is frozen', () => {
    const { logger } = makeLogger();
    const scope = logger.scoped('s-1', undefined, { user: 'u1' });
    expect(Object.isFrozen(scope.metadata)).toBe(true);
    expect(() => {
      (scope.metadata as Record<string, unknown>).user = 'changed';
    }).toThrow();
  });

  test('hostile call-site metadata cannot crash a scoped log call', () => {
    const { logger, dest } = makeLogger();
    const scope = logger.scoped('s-1', undefined, { user: 'u1' });
    const hostile = {
      ok: 'yes',
      get boom(): string {
        throw new Error('property getter threw');
      },
    };
    expect(() => scope.info('m', hostile)).not.toThrow();
    // The unreadable key is counted rather than silently vanishing.
    expect(dest.entries[0]!.metadata).toEqual({
      user: 'u1',
      ok: 'yes',
      droppedMetadataCount: 1,
    });
  });

  test('hostile metadata cannot crash child-scope construction', () => {
    const { logger, dest } = makeLogger();
    const parent = logger.scoped('p-1', undefined, { user: 'u1' });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys trap threw');
        },
      }
    );
    const child = parent.scoped('c-1', undefined, hostile as never);
    child.info('m');
    expect(dest.entries[0]!.metadata).toEqual({ user: 'u1' });
  });
});

/**
 * A nested scope is the same unit of work, seen closer up.
 *
 * `Logger.scoped()` starts a unit of work and generates a correlation ID for
 * it. `ScopedLogger.scoped()` does the opposite by default and inherits one,
 * because giving a child a fresh ID severs the trail at exactly the point
 * somebody reading the logs is trying to follow it through.
 */
describe('ScopedLogger.scoped — correlation inheritance', () => {
  test('a child inherits its parent correlation by default', () => {
    const { logger, dest } = makeLogger();
    const parent = logger.scoped('unit-1', 'sync');

    parent.scoped().info('deep');

    expect(dest.entries[0]!.correlation).toBe('unit-1');
    expect(dest.entries[0]!.subsystem).toBe('sync');
  });

  test('and an explicit one still starts a separate unit', () => {
    const { logger, dest } = makeLogger();
    logger.scoped('unit-1').scoped('unit-2').info('deep');

    expect(dest.entries[0]!.correlation).toBe('unit-2');
  });

  test('inheritance survives more than one level', () => {
    const { logger, dest } = makeLogger();
    logger.scoped('unit-1').scoped().scoped().info('deep');

    expect(dest.entries[0]!.correlation).toBe('unit-1');
  });

  test('metadata still merges when correlation is omitted', () => {
    const { logger, dest } = makeLogger();
    logger
      .scoped('unit-1', undefined, { a: '1' })
      .scoped(undefined, undefined, { b: '2' })
      .info('deep');

    expect(dest.entries[0]!.metadata).toEqual({ a: '1', b: '2' });
    expect(dest.entries[0]!.correlation).toBe('unit-1');
  });
});

/**
 * The 0.3.0 signature break, pinned from the caller's side.
 *
 * `log` took `(message, level?, metadata?)` and now takes
 * `(message, options?)`. TypeScript catches the change at every call site,
 * which is the point of making it loudly rather than adding an overload — but
 * a JavaScript caller gets no such help, so what the old spelling does now is
 * worth pinning too.
 */
describe('ScopedLogger.log — options rather than positionals', () => {
  test('level and metadata come off the options object', () => {
    const { logger, dest } = makeLogger();
    const scope = logger.scoped('c1', 'net');

    scope.log('with options', { level: 'error', metadata: { attempt: 2 } });

    expect(dest.entries).toHaveLength(1);
    expect(dest.entries[0]).toMatchObject({
      level: 'error',
      message: 'with options',
      subsystem: 'net',
      correlation: 'c1',
      metadata: { attempt: 2 },
    });
  });

  test('omitting options logs at info, as the positional default did', () => {
    const { logger, dest } = makeLogger();
    logger.scoped('c1').log('bare');
    expect(dest.entries[0]).toMatchObject({ level: 'info', message: 'bare' });
  });

  test('the six level methods are unchanged', () => {
    const { logger, dest } = makeLogger();
    const scope = logger.scoped('c1');

    scope.warning('still positional', { attempt: 1 });

    expect(dest.entries[0]).toMatchObject({
      level: 'warning',
      message: 'still positional',
      metadata: { attempt: 1 },
    });
  });

  /**
   * A JavaScript caller that missed the change passes a level string where an
   * options object goes. The runtime reads `options?.level` off a string,
   * which is `undefined`, so the entry is logged at the default level — the
   * message still reaches the file, which is the behaviour a logger owes, and
   * the level is wrong in the safe direction rather than read out of an object
   * that is not one.
   */
  test('a stale positional call still logs, at the default level', () => {
    const { logger, dest } = makeLogger();
    const scope = logger.scoped('c1');

    (scope.log as (m: string, o?: unknown) => void)('stale call', 'error');

    expect(dest.entries).toHaveLength(1);
    expect(dest.entries[0]).toMatchObject({
      level: 'info',
      message: 'stale call',
    });
  });

  test('a scope keeps its subsystem and correlation whatever a call says', () => {
    const { logger, dest } = makeLogger();
    const scope = logger.scoped('owned', 'billing');

    // Not in `ScopedLogOptions`, so this is a type error — and inert at
    // runtime, which is what makes the omission safe rather than merely tidy.
    (scope.log as (m: string, o?: unknown) => void)('hijack attempt', {
      subsystem: 'other',
      correlation: 'someone-elses',
    });

    expect(dest.entries[0]).toMatchObject({
      subsystem: 'billing',
      correlation: 'owned',
    });
  });

  /**
   * The call-site twin of this lives in `logger.test.ts`, and it does not
   * cover this path.
   *
   * Scope metadata is snapshotted at construction by `safeSnapshotMetadata`,
   * which builds its own null-prototype object; call-site metadata is never
   * snapshotted and reaches `redactMetadata` directly. Two objects, two
   * `Object.create(null)` calls, and only one of them was pinned — so a plain
   * `{}` here would route `__proto__` through the legacy setter on
   * `Object.prototype`, silently losing the value and letting a caller reshape
   * the snapshot every later message is built from.
   */
  test('a __proto__ key in scope metadata is stored as data, not routed to a setter', () => {
    const { logger, dest } = makeLogger();
    // `JSON.parse`, not a literal: an object literal's `__proto__` is the
    // prototype-setting form and would never become an own property, so the
    // test would be staging a case the hazard does not arise from.
    const hostile = JSON.parse(
      '{"__proto__":"value","ok":"yes"}'
    ) as LogMetadata;
    const scope = logger.scoped('s', undefined, hostile);

    scope.info('m');
    const metadata = dest.entries[0]!.metadata!;

    expect(Object.keys(metadata).sort()).toEqual(['__proto__', 'ok']);
    // An own data property, and specifically not something reached through the
    // prototype chain.
    expect(Object.getOwnPropertyDescriptor(metadata, '__proto__')?.value).toBe(
      'value'
    );
    // And the snapshot did not become somebody's prototype.
    expect(Object.getPrototypeOf(metadata)).toBe(null);
  });

  test('the scope snapshot is taken at construction, not read at emit', () => {
    const { logger, dest } = makeLogger();
    const live: LogMetadata = { state: 'running' };
    const scope = logger.scoped('s', undefined, live);

    // The caller still owns the object it passed and may keep using it. A
    // scope that read it at emit would let a mutation after construction
    // change what every earlier-configured message carries — and would re-run
    // getters that were already read once.
    live.state = 'mutated';
    scope.info('m');

    expect(dest.entries[0]!.metadata).toEqual({ state: 'running' });
  });
});
