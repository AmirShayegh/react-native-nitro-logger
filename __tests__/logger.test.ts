import { Logger } from '../src/Logger';
import { TestDestination } from './helpers/TestDestination';
import type { LogDestination } from '../src/destinations/types';
import type { LogLevel } from '../src/types';

function makeLogger() {
  const logger = new Logger();
  logger.removeDestination('console');
  return logger;
}

describe('Logger pipeline', () => {
  test('fluent methods return the same instance', () => {
    const logger = makeLogger();
    expect(logger.minimumLevel('info')).toBe(logger);
    expect(logger.subsystem('a', 'debug')).toBe(logger);
    expect(logger.addDestination(new TestDestination())).toBe(logger);
    expect(logger.removeDestination('test')).toBe(logger);
  });

  test('messages below the global minimum are discarded', () => {
    const logger = makeLogger();
    const dest = new TestDestination();
    logger.addDestination(dest).minimumLevel('warning');
    logger.info('nope');
    logger.warning('yes');
    expect(dest.messages).toEqual(['yes']);
  });

  test('lazy message is not evaluated when level-filtered', () => {
    const logger = makeLogger();
    logger.addDestination(new TestDestination()).minimumLevel('error');
    const thunk = jest.fn(() => 'expensive');
    logger.debug(thunk);
    expect(thunk).not.toHaveBeenCalled();
    logger.error(thunk);
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  test('lazy message is not evaluated when no destination is eligible', () => {
    const logger = makeLogger();
    const dest = new TestDestination();
    dest.enabled = false;
    logger.addDestination(dest);
    const thunk = jest.fn(() => 'expensive');
    logger.info(thunk);
    expect(thunk).not.toHaveBeenCalled();
  });

  test('a throwing thunk becomes a fixed safe entry, never a crash', () => {
    const logger = makeLogger();
    const dest = new TestDestination();
    logger.addDestination(dest);
    logger.info(() => {
      throw new Error('SECRET detail that must not surface');
    });
    expect(dest.messages).toEqual(['[Logger] message thunk threw']);
  });

  test('per-destination minimumLevel filters independently', () => {
    const logger = makeLogger();
    const chatty = new TestDestination('chatty');
    const strict = new TestDestination('strict', 'warning');
    logger.addDestination(chatty).addDestination(strict);
    logger.debug('detail');
    logger.warning('important');
    expect(chatty.messages).toEqual(['detail', 'important']);
    expect(strict.messages).toEqual(['important']);
  });

  test('one throwing destination never blocks its siblings', () => {
    const logger = makeLogger();
    const bad = new TestDestination('bad');
    const good = new TestDestination('good');
    bad.throwOnWrite = true;
    logger.addDestination(bad).addDestination(good);
    logger.info('survives');
    expect(good.messages).toEqual(['survives']);
  });

  test('a repeatedly failing destination is disabled with a payload-free notice', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = makeLogger();
      const bad = new TestDestination('bad');
      const good = new TestDestination('good');
      bad.throwOnWrite = true;
      logger.addDestination(bad).addDestination(good);
      for (let i = 0; i < 6; i++) logger.info(`m${i}`);
      // After disablement, writes stop reaching the bad destination…
      bad.throwOnWrite = false;
      logger.info('after');
      expect(bad.entries).toHaveLength(0);
      // …siblings never missed a message…
      expect(good.messages).toHaveLength(7);
      // …and the notice carries no payload from any log entry.
      const notice = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(notice).toContain('disabled after repeated write failures');
      expect(notice).not.toContain('m0');
      // …nor the caller-controlled label (log-injection surface).
      expect(notice).not.toContain('bad');
    } finally {
      warn.mockRestore();
    }
  });

  test('addDestination with an existing label flushes and disposes the old one', () => {
    const logger = makeLogger();
    const first = new TestDestination('file');
    const second = new TestDestination('file');
    logger.addDestination(first).addDestination(second);
    expect(first.flushCount).toBe(1);
    expect(first.disposeCount).toBe(1);
    logger.info('goes to the replacement');
    expect(first.entries).toHaveLength(0);
    expect(second.messages).toEqual(['goes to the replacement']);
  });

  test('non-primitive metadata values are dropped and counted', () => {
    const logger = makeLogger();
    const dest = new TestDestination();
    logger.addDestination(dest);
    logger.info('m', {
      ok: 'yes',
      count: 3,
      // @ts-expect-error — runtime hardening against JS callers
      nested: { phi: 'leak' },
      // @ts-expect-error — runtime hardening against JS callers
      fn: () => 'leak',
      inf: Infinity,
    });
    // Privacy resolution lives in redaction.test.ts; this asserts only that
    // the pipeline routes metadata through it.
    expect(dest.entries[0]!.metadata).toEqual({
      ok: 'yes',
      count: 3,
      droppedMetadataCount: 3,
    });
  });

  test('flush isolates per-destination failures', () => {
    const logger = makeLogger();
    const bad = new TestDestination('bad');
    bad.flush = () => {
      throw new Error('disk gone');
    };
    const good = new TestDestination('good');
    logger.addDestination(bad).addDestination(good);
    expect(() => logger.flush()).not.toThrow();
    expect(good.flushCount).toBe(1);
  });

  test('dispose still runs when flush throws during removal', () => {
    const logger = makeLogger();
    const dest = new TestDestination('file');
    dest.flush = () => {
      throw new Error('flush failed');
    };
    logger.addDestination(dest);
    expect(() => logger.removeDestination('file')).not.toThrow();
    expect(dest.disposeCount).toBe(1);
  });

  test('a throwing isEnabled getter is skipped without starving siblings', () => {
    const logger = makeLogger();
    const good = new TestDestination('good');
    const evil: LogDestination = {
      label: 'evil',
      get isEnabled(): boolean {
        throw new Error('config getter threw');
      },
      write() {},
      flush() {},
      dispose() {},
    };
    logger.addDestination(evil).addDestination(good);
    const thunk = jest.fn(() => 'survives');
    logger.info(thunk);
    expect(thunk).toHaveBeenCalledTimes(1);
    expect(good.messages).toEqual(['survives']);
  });

  test('a throwing minimumLevel getter is skipped without starving siblings', () => {
    const logger = makeLogger();
    const good = new TestDestination('good');
    const evil: LogDestination = {
      label: 'evil',
      isEnabled: true,
      get minimumLevel(): LogLevel {
        throw new Error('config getter threw');
      },
      write() {},
      flush() {},
      dispose() {},
    };
    logger.addDestination(evil).addDestination(good);
    logger.info('survives');
    expect(good.messages).toEqual(['survives']);
  });

  test('repeated config-getter throws count toward disablement', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = makeLogger();
      const good = new TestDestination('good');
      const evil: LogDestination = {
        label: 'evil',
        get isEnabled(): boolean {
          throw new Error('config getter threw');
        },
        write() {},
        flush() {},
        dispose() {},
      };
      logger.addDestination(evil).addDestination(good);
      for (let i = 0; i < 6; i++) logger.info('m');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(good.messages).toHaveLength(6);
    } finally {
      warn.mockRestore();
    }
  });

  test('metadata whose enumeration throws is dropped without crashing', () => {
    const logger = makeLogger();
    const dest = new TestDestination();
    logger.addDestination(dest);
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys trap threw');
        },
      }
    );
    expect(() => logger.info('m', hostile as never)).not.toThrow();
    expect(dest.messages).toEqual(['m']);
    expect(dest.entries[0]!.metadata).toBeUndefined();
  });

  test('a throwing metadata getter drops only that key', () => {
    const logger = makeLogger();
    const dest = new TestDestination();
    logger.addDestination(dest);
    const hostile = {
      ok: 'yes',
      get boom(): string {
        throw new Error('property getter threw');
      },
    };
    expect(() => logger.info('m', hostile)).not.toThrow();
    // The failed read is counted rather than silently vanishing.
    expect(dest.entries[0]!.metadata).toEqual({
      ok: 'yes',
      droppedMetadataCount: 1,
    });
  });

  test('re-adding an already registered instance is a no-op, not a dispose', () => {
    const logger = makeLogger();
    const dest = new TestDestination('file');
    logger.addDestination(dest).addDestination(dest);
    expect(dest.disposeCount).toBe(0);
    expect(dest.flushCount).toBe(0);
    logger.info('still live');
    expect(dest.messages).toEqual(['still live']);
  });

  test('a destination whose label cannot be read is rejected, payload-free', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = makeLogger();
      const good = new TestDestination('good');
      const evil: LogDestination = {
        get label(): string {
          throw new Error('SECRET label detail');
        },
        isEnabled: true,
        write() {},
        flush() {},
        dispose() {},
      };
      expect(() => logger.addDestination(evil)).not.toThrow();
      logger.addDestination(good);
      logger.info('m');
      expect(good.messages).toEqual(['m']);
      const notice = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(notice).toContain('label could not be read');
      expect(notice).not.toContain('SECRET');
    } finally {
      warn.mockRestore();
    }
  });

  test('the label captured at registration survives a getter that starts throwing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = makeLogger();
      const good = new TestDestination('good');
      let labelThrows = false;
      let labelReads = 0;
      const flaky: LogDestination = {
        get label(): string {
          labelReads += 1;
          if (labelThrows) throw new Error('label getter threw');
          return 'flaky';
        },
        get isEnabled(): boolean {
          throw new Error('config getter threw');
        },
        write() {},
        flush() {},
        dispose() {},
      };
      logger.addDestination(flaky).addDestination(good);
      labelThrows = true;

      // Re-adding the same instance must not touch the label getter again…
      expect(() => logger.addDestination(flaky)).not.toThrow();
      expect(labelReads).toBe(1);
      expect(warn).not.toHaveBeenCalled();

      // …failure accounting still has a stable key, so it can be disabled…
      for (let i = 0; i < 6; i++) logger.info('m');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(good.messages).toHaveLength(6);

      // …and removal by that captured label still works.
      expect(() => logger.removeDestination('flaky')).not.toThrow();
      logger.info('after');
      expect(good.messages).toHaveLength(7);
    } finally {
      warn.mockRestore();
    }
  });

  test('a __proto__ metadata key is stored as data, not routed to a setter', () => {
    const logger = makeLogger();
    const dest = new TestDestination();
    logger.addDestination(dest);
    logger.info('m', JSON.parse('{"__proto__":"value","ok":"yes"}'));
    const metadata = dest.entries[0]!.metadata!;
    expect(Object.getPrototypeOf(metadata)).toBeNull();
    expect(Object.keys(metadata).sort()).toEqual(['__proto__', 'ok']);
    expect(Object.getOwnPropertyDescriptor(metadata, '__proto__')?.value).toBe(
      'value'
    );
  });

  test('a destination cannot mutate the timestamp its siblings receive', () => {
    const logger = makeLogger();
    const good = new TestDestination('good');
    const mutator: LogDestination = {
      label: 'mutator',
      isEnabled: true,
      write(entry) {
        // A Date would still be mutable through a frozen entry; a number is
        // not, so this cannot take effect.
        try {
          (entry as { timestamp: number }).timestamp = 0;
        } catch {
          // strict-mode TypeError on the frozen entry
        }
      },
      flush() {},
      dispose() {},
    };
    const before = Date.now();
    logger.addDestination(mutator).addDestination(good);
    logger.info('m');
    const seen = good.entries[0]!.timestamp;
    expect(typeof seen).toBe('number');
    expect(seen).toBeGreaterThanOrEqual(before);
  });

  test('entries are frozen; a mutating destination cannot affect siblings', () => {
    const logger = makeLogger();
    const good = new TestDestination('good');
    const mutator: LogDestination = {
      label: 'mutator',
      isEnabled: true,
      write(entry) {
        (entry as { message: string }).message = 'tampered';
        (entry.metadata as Record<string, unknown>).k = 'tampered';
      },
      flush() {},
      dispose() {},
    };
    logger.addDestination(mutator).addDestination(good);
    logger.info('original', { k: 'v' });
    expect(good.messages).toEqual(['original']);
    expect(good.entries[0]!.metadata).toEqual({ k: 'v' });
    expect(Object.isFrozen(good.entries[0])).toBe(true);
    expect(Object.isFrozen(good.entries[0]!.metadata)).toBe(true);
  });
});
