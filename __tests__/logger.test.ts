import { Logger } from '../src/Logger';
import { ConsoleDestination } from '../src/destinations/ConsoleDestination';
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

/**
 * `flush(deadlineMs)` is a total, not an allowance each destination gets.
 *
 * It used to be the latter: a caller asking for 2000 with three destinations
 * blocked the JavaScript thread for up to six seconds, and adding a fourth
 * destination anywhere in the app silently lengthened every flush in it. The
 * number a caller passes has to mean what it says, because the call it means it
 * for is the one on the crash path.
 *
 * ## What these do NOT prove
 *
 * That the bound holds against a destination that ignores it. The budget is
 * cooperative — nothing here can interrupt a third-party `flush` that blocks —
 * and these assert what each destination is *told*, which is the only part this
 * library controls.
 */
describe('Logger.flush — one budget across every destination', () => {
  /** Records the deadline it was handed, and burns the time it was given. */
  function greedy(label: string, burnMs: number, seen: number[]) {
    return {
      label,
      isEnabled: true,
      write() {},
      flush(deadlineMs?: number) {
        seen.push(deadlineMs ?? -1);
        const until = Date.now() + burnMs;
        while (Date.now() < until) {
          /* spend it, the way a destination that waits would */
        }
      },
      dispose() {},
    } satisfies LogDestination;
  }

  test('the second destination gets what the first left', () => {
    const seen: number[] = [];
    const logger = makeLogger();
    logger.addDestination(greedy('slow', 60, seen));
    logger.addDestination(greedy('after', 0, seen));

    logger.flush(300);

    expect(seen).toHaveLength(2);
    // Bands, not values, on both: this measures real elapsed time, and even the
    // first destination can be handed 299 if the clock ticks between the
    // deadline being started and the first reading of what is left of it.
    expect(seen[0]!).toBeGreaterThan(0);
    expect(seen[0]!).toBeLessThanOrEqual(300);
    // Whatever the first spent is gone from the second's share.
    expect(seen[1]!).toBeLessThan(seen[0]!);
    expect(seen[1]!).toBeGreaterThan(0);
  });

  /**
   * A device clock correction must not lengthen the budget.
   *
   * `Date.now()` is not a stopwatch. NTP, a manual change, a leap smear — any
   * of them moves it, and a budget computed as the difference between two
   * readings of it can be handed backwards time. This drives `Date.now`
   * backwards between the two destinations and asserts the second is still
   * bounded by what the caller asked for.
   *
   * Presumes a host that provides `performance.now` — Node here, Hermes and JSC
   * in the app. On a host without one the library falls back to `Date.now` and
   * documents that this property is not delivered there; see `startDeadline`.
   */
  test('a backwards clock correction does not extend the budget', () => {
    const seen: number[] = [];
    const record = (label: string): LogDestination => ({
      label,
      isEnabled: true,
      write() {},
      flush(deadlineMs?: number) {
        seen.push(deadlineMs ?? -1);
      },
      dispose() {},
    });
    const logger = makeLogger();
    logger.addDestination(record('one'));
    logger.addDestination(record('two'));

    const realNow = Date.now;
    let drift = 0;
    Date.now = () => {
      drift += 3_600_000;
      return realNow() - drift;
    };
    try {
      logger.flush(300);
    } finally {
      Date.now = realNow;
    }

    expect(seen).toHaveLength(2);
    expect(seen[1]!).toBeLessThanOrEqual(300);
  });

  test('an exhausted budget still asks every destination, with zero', () => {
    const seen: number[] = [];
    const logger = makeLogger();
    logger.addDestination(greedy('hog', 120, seen));
    logger.addDestination(greedy('starved', 0, seen));
    logger.addDestination(greedy('also-starved', 0, seen));

    logger.flush(100);

    // Three calls, not one. `flush(0)` still drains whatever needs no waiting,
    // and skipping the rest would be a new way to lose records on the crash
    // path — which is the path this method exists for.
    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(0);
    expect(seen[2]).toBe(0);
  });

  test('a nonsense deadline becomes zero rather than a wait', () => {
    const seen: number[] = [];
    const logger = makeLogger();
    logger.addDestination(greedy('one', 0, seen));

    logger.flush(Number.NaN);
    logger.flush(-5);
    logger.flush(Number.POSITIVE_INFINITY);

    // NaN and a negative are zero; infinity is the 30s ceiling, not forever.
    expect(seen[0]).toBe(0);
    expect(seen[1]).toBe(0);
    expect(seen[2]).toBeGreaterThan(0);
    expect(seen[2]).toBeLessThanOrEqual(30_000);
  });

  test('a destination that throws does not consume what the rest get', () => {
    const seen: number[] = [];
    const logger = makeLogger();
    logger.addDestination({
      label: 'thrower',
      isEnabled: true,
      write() {},
      flush() {
        throw new Error('nope');
      },
      dispose() {},
    });
    logger.addDestination(greedy('after', 0, seen));

    expect(() => logger.flush(500)).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]!).toBeGreaterThan(0);
  });
});

/**
 * `destinations()` and the re-arm gesture.
 *
 * Auto-disablement is silent in a shipped build — the only signal is a
 * development-only `console.warn` — so before 0.3.0 an app had no way to
 * discover that a destination had been cut off, and no way to bring it back
 * short of constructing a replacement. These pin both halves.
 *
 * What they do not prove: that the reported `enabled` matches what the
 * destination itself would say. That is the point of the split, and the
 * `isEnabled` tests below pin the divergence deliberately.
 */
describe('Logger.destinations', () => {
  /** Drive `dest` past the auto-disable threshold. Five is the limit; six
   * calls leave one entry's worth of margin without depending on the exact
   * number, which is not exported. */
  function breakIt(logger: Logger, times = 6): void {
    for (let i = 0; i < times; i += 1) logger.info(`m${i}`);
  }

  test('reports every registration, in registration order, enabled', () => {
    const logger = makeLogger();
    logger
      .addDestination(new TestDestination('file'))
      .addDestination(new TestDestination('console2'));

    expect(logger.destinations()).toEqual([
      { label: 'file', enabled: true },
      { label: 'console2', enabled: true },
    ]);
  });

  test('a destination cut off after repeated failures reports enabled: false', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = makeLogger();
      const bad = new TestDestination('bad');
      bad.throwOnWrite = true;
      logger.addDestination(bad).addDestination(new TestDestination('good'));

      expect(logger.destinations()[0]).toEqual({ label: 'bad', enabled: true });
      breakIt(logger);

      expect(logger.destinations()).toEqual([
        { label: 'bad', enabled: false },
        { label: 'good', enabled: true },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test('re-adding the same instance re-arms it, and clears the failure count', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = makeLogger();
      const bad = new TestDestination('bad');
      bad.throwOnWrite = true;
      logger.addDestination(bad);
      breakIt(logger);
      expect(logger.destinations()[0]!.enabled).toBe(false);

      // The gesture: hand back the instance you fixed.
      expect(logger.addDestination(bad)).toBe(logger);
      expect(logger.destinations()[0]!.enabled).toBe(true);

      // Still broken — one more failure. The count must have been cleared, not
      // only the disabled mark: a stale count of five would re-disable here on
      // the very first write, and clearing it on the *next successful* write
      // would hide that. This is the assertion that separates the two.
      logger.info('fails once more');
      expect(logger.destinations()[0]!.enabled).toBe(true);

      bad.throwOnWrite = false;
      logger.info('lands');
      expect(bad.messages).toEqual(['lands']);
    } finally {
      warn.mockRestore();
    }
  });

  test('re-adding an instance neither replaces nor disposes it', () => {
    const logger = makeLogger();
    const dest = new TestDestination('file');
    logger.addDestination(dest).addDestination(dest);

    // The same-label path flushes and disposes what it displaces. The identity
    // path must not: the caller handed back the object it already owns.
    expect(dest.disposeCount).toBe(0);
    expect(dest.flushCount).toBe(0);
    expect(logger.destinations()).toEqual([{ label: 'file', enabled: true }]);
    logger.info('once');
    expect(dest.messages).toEqual(['once']);
  });

  test('re-adding does not read the label getter again', () => {
    const logger = makeLogger();
    let reads = 0;
    const dest: LogDestination = {
      get label() {
        reads += 1;
        return 'counted';
      },
      isEnabled: true,
      write() {},
      flush() {},
      dispose() {},
    };

    logger.addDestination(dest);
    const afterFirst = reads;
    logger.addDestination(dest);

    // Capture-once: the registration's label is fixed at registration, and the
    // identity branch works from the captured string. A second read is the leak
    // — a destination whose label getter changed its answer would be re-filed
    // under a name the failure accounting does not use.
    expect(reads).toBe(afterFirst);
  });

  test('the reported label survives a label getter that starts throwing', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = makeLogger();
      let hostile = false;
      const dest: LogDestination = {
        get label() {
          if (hostile) throw new Error('SECRET in a label getter');
          return 'stable';
        },
        isEnabled: true,
        write() {},
        flush() {},
        dispose() {},
      };
      logger.addDestination(dest);
      hostile = true;

      expect(() => logger.destinations()).not.toThrow();
      expect(logger.destinations()).toEqual([
        { label: 'stable', enabled: true },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test('enabled is the circuit breaker, not the destination own isEnabled', () => {
    const logger = makeLogger();
    const fenced = new TestDestination('fenced');
    fenced.enabled = false; // what a fenced FileDestination says about itself
    logger.addDestination(fenced);

    // The divergence proven from both sides rather than claimed from one: the
    // write path skips it *and* it reports enabled, because the two answer
    // different questions. `enabled: true` is the circuit breaker untripped,
    // not a promise that records are arriving.
    logger.info('goes nowhere');
    expect(fenced.entries).toHaveLength(0);
    expect(logger.destinations()).toEqual([{ label: 'fenced', enabled: true }]);
  });

  test('a throwing isEnabled getter cannot break a diagnostics call', () => {
    const logger = makeLogger();
    const dest: LogDestination = {
      label: 'hostile',
      get isEnabled(): boolean {
        throw new Error('SECRET from an isEnabled getter');
      },
      write() {},
      flush() {},
      dispose() {},
    };
    logger.addDestination(dest);

    expect(() => logger.destinations()).not.toThrow();
    expect(logger.destinations()).toEqual([
      { label: 'hostile', enabled: true },
    ]);
  });

  test('the array and its rows are frozen, and are not the logger state', () => {
    const logger = makeLogger();
    logger.addDestination(new TestDestination('file'));
    const rows = logger.destinations();

    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    // A fresh array each call, so keeping one cannot observe later changes.
    expect(logger.destinations()).not.toBe(rows);
  });

  test('removeDestination drops the row', () => {
    const logger = makeLogger();
    logger
      .addDestination(new TestDestination('a'))
      .addDestination(new TestDestination('b'));
    logger.removeDestination('a');
    expect(logger.destinations()).toEqual([{ label: 'b', enabled: true }]);
  });
});

/**
 * The auto-disable threshold, approached from both sides and from both
 * readings of "five failures".
 *
 * The block above drives destinations past the limit with a deliberately
 * round six, which is the right shape for tests about what a *disabled*
 * destination does and the wrong one for tests about where the line is. Six
 * failures disable a destination whether the threshold is the fifth or the
 * sixth, and whether the policy counts consecutive failures or cumulative
 * ones — so none of those distinctions is pinned by it.
 */
describe('Logger — the auto-disable policy', () => {
  /** Silences the fixed warning the threshold emits, and restores after. */
  function quietly(body: () => void): void {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      body();
    } finally {
      warn.mockRestore();
    }
  }

  test('four consecutive failures leave it enabled; the fifth disables it', () => {
    quietly(() => {
      const logger = makeLogger();
      const bad = new TestDestination('bad');
      bad.throwOnWrite = true;
      logger.addDestination(bad);

      for (let i = 0; i < 4; i += 1) logger.info(`f${i}`);
      // Both sides, in one test, because either alone is satisfied by an
      // off-by-one in the direction it does not check.
      expect(logger.destinations()[0]!.enabled).toBe(true);

      logger.info('the fifth');
      expect(logger.destinations()[0]!.enabled).toBe(false);
    });
  });

  test('a success between failures resets the count — consecutive, not cumulative', () => {
    quietly(() => {
      const logger = makeLogger();
      const bad = new TestDestination('bad');
      logger.addDestination(bad);

      // Four failures, one success, four more. Eight failures in total, and
      // never five in a row.
      for (let round = 0; round < 2; round += 1) {
        bad.throwOnWrite = true;
        for (let i = 0; i < 4; i += 1) logger.info('fails');
        bad.throwOnWrite = false;
        logger.info('lands');
      }

      // A cumulative counter would have cut this destination off during the
      // second round. The policy is that a destination which is working again
      // has stopped failing, and only an unbroken run means it is gone.
      expect(logger.destinations()[0]!.enabled).toBe(true);
      expect(bad.messages).toEqual(['lands', 'lands']);
    });
  });

  test('a failing eligibility getter counts toward the same threshold', () => {
    quietly(() => {
      const logger = makeLogger();
      const hostile = new TestDestination('hostile');
      Object.defineProperty(hostile, 'isEnabled', {
        get() {
          throw new Error('scripted getter failure');
        },
      });
      logger.addDestination(hostile);

      // Never reaches `write`, so this is the other call site of the counter.
      // A policy that only counted write failures would leave a destination
      // whose getter throws every time enabled forever.
      for (let i = 0; i < 4; i += 1) logger.info(`f${i}`);
      expect(logger.destinations()[0]!.enabled).toBe(true);

      logger.info('the fifth');
      expect(logger.destinations()[0]!.enabled).toBe(false);
    });
  });

  test('a disabled destination stops being written to at all', () => {
    quietly(() => {
      const logger = makeLogger();
      const bad = new TestDestination('bad');
      bad.throwOnWrite = true;
      logger.addDestination(bad);
      for (let i = 0; i < 5; i += 1) logger.info('fails');
      expect(logger.destinations()[0]!.enabled).toBe(false);

      // The point of cutting it off. `enabled: false` that still called
      // `write` on every record would cost exactly what the breaker exists to
      // save, and the count above would go on climbing.
      bad.throwOnWrite = false;
      logger.info('after the cutoff');
      expect(bad.messages).toEqual([]);
    });
  });
});

describe('Logger.consoleLogging', () => {
  /**
   * The default `console` destination this suite's `makeLogger` removes.
   *
   * `consoleLogging` reaches only `ConsoleDestination` instances, so a test
   * driving it needs a real one; `TestDestination` would be silently skipped
   * and every assertion below would pass against a method that does nothing.
   */
  function withConsole() {
    const logger = new Logger();
    const printed: string[] = [];
    const console2 = new ConsoleDestination();
    console2.outputSink = (line) => printed.push(line);
    logger.removeDestination('console').addDestination(console2);
    return { logger, console2, printed };
  }

  test('it is fluent, and toggles printing on the console destination', () => {
    const { logger, console2 } = withConsole();

    expect(logger.consoleLogging(false)).toBe(logger);
    expect(console2.printEnabled).toBe(false);
    expect(logger.consoleLogging(true)).toBe(logger);
    expect(console2.printEnabled).toBe(true);
  });

  test('a test sink keeps receiving lines while printing is off', () => {
    const { logger, printed } = withConsole();
    logger.consoleLogging(false);

    logger.info('still captured');

    // The documented split: turning printing off silences the platform
    // console, not the destination. A sink that went quiet too would make the
    // toggle unusable in the tests that rely on it.
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('still captured');
  });

  test('it leaves destinations that are not consoles alone', () => {
    const { logger } = withConsole();
    const file = new TestDestination('file');
    logger.addDestination(file);

    logger.consoleLogging(false);

    // Asserted on the property, not on the messages. A toggle that dropped the
    // `instanceof` guard and assigned to every destination would leave this one
    // delivering anyway — nothing here reads `printEnabled` — so a
    // messages-only assertion passes against exactly the mutant it looks like
    // it is catching. What is wrong with that mutant is that it writes a field
    // it does not own onto an object it does not understand.
    expect('printEnabled' in file).toBe(false);
    logger.info('to the file');
    expect(file.messages).toEqual(['to the file']);
  });
});
