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
