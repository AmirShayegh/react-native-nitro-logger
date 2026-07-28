import { NativeConsoleDestination } from '../src/destinations/NativeConsoleDestination';
import type { NativeConsoleSinkLike } from '../src/destinations/NativeConsoleDestination';
import { JsonLinesFormatter } from '../src/formatters/JsonLinesFormatter';
import { DefaultFormatter } from '../src/formatters/DefaultFormatter';
import { Logger } from '../src/Logger';
import type { LogEntry } from '../src/types';
import type { LogFormatter } from '../src/formatters/types';

function entry(partial: Partial<LogEntry>): LogEntry {
  return {
    timestamp: new Date(2026, 6, 28, 12, 0, 0, 0).getTime(),
    level: 'info',
    message: 'msg',
    ...partial,
  };
}

interface Batch {
  readonly levels: number[];
  readonly messages: string[];
}

/** A scriptable stand-in for the Nitro sink. */
class FakeConsoleSink implements NativeConsoleSinkLike {
  readonly batches: Batch[] = [];
  installed?: { subsystem: string; category: string };
  throws = false;
  installThrows = false;

  install(subsystem: string, category: string): void {
    if (this.installThrows) throw new Error('install failed');
    this.installed = { subsystem, category };
  }

  logBatch(levels: number[], messages: string[]): void {
    if (this.throws) throw new Error('logBatch failed');
    this.batches.push({ levels: [...levels], messages: [...messages] });
  }

  get entryCount(): number {
    return this.batches.reduce((n, b) => n + b.messages.length, 0);
  }
}

function build(
  options?: ConstructorParameters<typeof NativeConsoleDestination>[1]
) {
  const sink = new FakeConsoleSink();
  const destination = new NativeConsoleDestination(sink, options);
  return { sink, destination };
}

describe('NativeConsoleDestination', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('installs the subsystem and category up front', () => {
    const { sink } = build({ subsystem: 'com.example.app', category: 'net' });
    expect(sink.installed).toEqual({
      subsystem: 'com.example.app',
      category: 'net',
    });
  });

  // An empty subsystem is legal and produces a logger nobody can find in
  // Console; the native side substitutes the bundle identifier.
  test('leaves the subsystem to the native side when none is given', () => {
    const { sink } = build();
    expect(sink.installed).toEqual({ subsystem: '', category: 'log' });
  });

  test('coalesces writes into one bridge crossing per batch', () => {
    const { sink, destination } = build({ batchSize: 3 });

    destination.write(entry({ message: 'a' }));
    destination.write(entry({ message: 'b' }));
    expect(sink.batches).toHaveLength(0);

    destination.write(entry({ message: 'c' }));
    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]!.messages).toHaveLength(3);
  });

  test('levels cross as the numeric codes the native side maps', () => {
    const { sink, destination } = build({ batchSize: 6 });

    for (const level of [
      'verbose',
      'debug',
      'info',
      'warning',
      'error',
      'todo',
    ] as const) {
      destination.write(entry({ level }));
    }

    expect(sink.batches[0]!.levels).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('a partial batch goes out on the idle timer', () => {
    const { sink, destination } = build({
      batchSize: 100,
      flushIntervalMs: 50,
    });

    destination.write(entry({ message: 'lonely' }));
    expect(sink.batches).toHaveLength(0);

    jest.advanceTimersByTime(50);
    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]!.messages[0]).toContain('lonely');
  });

  // One pending timer, however many writes arrive — a timer per entry would
  // make a burst pay for scheduling it never uses.
  test('the idle timer is armed once, not once per write', () => {
    const { sink, destination } = build({
      batchSize: 100,
      flushIntervalMs: 50,
    });

    for (let i = 0; i < 10; i += 1)
      destination.write(entry({ message: `m${i}` }));
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(50);
    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]!.messages).toHaveLength(10);
  });

  test('flush drains immediately and cancels the pending timer', () => {
    const { sink, destination } = build({
      batchSize: 100,
      flushIntervalMs: 50,
    });

    destination.write(entry({ message: 'now' }));
    destination.flush(1000);

    expect(sink.batches).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);

    // And no phantom second delivery when the window would have elapsed.
    jest.advanceTimersByTime(100);
    expect(sink.batches).toHaveLength(1);
  });

  test('flushing an empty buffer is not a bridge crossing', () => {
    const { sink, destination } = build();
    destination.flush();
    expect(sink.batches).toHaveLength(0);
  });

  test('the formatter is what renders the line', () => {
    const { sink, destination } = build({
      batchSize: 1,
      formatter: new JsonLinesFormatter(),
    });

    destination.write(entry({ message: 'structured' }));

    const line = sink.batches[0]!.messages[0]!;
    expect(JSON.parse(line)).toMatchObject({ message: 'structured' });
  });

  // Entries buffered up to the moment of disposal were accepted, and disposing
  // is not a reason to drop them.
  test('dispose flushes what was accepted before it', () => {
    const { sink, destination } = build({ batchSize: 100 });

    destination.write(entry({ message: 'last words' }));
    destination.dispose();

    expect(sink.batches).toHaveLength(1);
    expect(sink.batches[0]!.messages[0]).toContain('last words');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('dispose is idempotent and stops accepting writes', () => {
    const { sink, destination } = build({ batchSize: 1 });

    destination.dispose();
    destination.dispose();
    destination.write(entry({ message: 'after' }));
    destination.flush();

    expect(sink.batches).toHaveLength(0);
    expect(destination.isEnabled).toBe(false);
  });

  describe('buffer ceiling', () => {
    test('drops newest past the ceiling and counts what it dropped', () => {
      const { sink, destination } = build({
        batchSize: 100,
        maxPendingEntries: 2,
      });

      destination.write(entry({ message: 'first' }));
      destination.write(entry({ message: 'second' }));
      destination.write(entry({ message: 'third' }));
      destination.flush();

      expect(sink.batches[0]!.messages).toHaveLength(2);
      expect(sink.batches[0]!.messages[0]).toContain('first');
      expect(destination.dropped()).toBe(1);
    });

    test('a drained buffer has room again', () => {
      const { sink, destination } = build({
        batchSize: 100,
        maxPendingEntries: 1,
      });

      destination.write(entry({ message: 'a' }));
      destination.flush();
      destination.write(entry({ message: 'b' }));
      destination.flush();

      expect(sink.entryCount).toBe(2);
      expect(destination.dropped()).toBe(0);
    });
  });

  // `levels` and `messages` are read by index natively, so they have to stay
  // the same length. Appending the level before a message that might not
  // arrive puts them one apart, and from there every entry in the batch is
  // logged at its predecessor's severity.
  describe('a throwing formatter', () => {
    function throwingOn(message: string): LogFormatter {
      const good = new DefaultFormatter();
      return {
        format(e: LogEntry): string {
          if (e.message === message) throw new Error('formatter failed');
          return good.format(e);
        },
      };
    }

    test('does not leave the level and message arrays misaligned', () => {
      const { sink, destination } = build({
        batchSize: 100,
        formatter: throwingOn('bad'),
      });

      destination.write(entry({ level: 'error', message: 'before' }));
      destination.write(entry({ level: 'todo', message: 'bad' }));
      destination.write(entry({ level: 'debug', message: 'after' }));
      destination.flush();

      const batch = sink.batches[0]!;
      expect(batch.levels).toHaveLength(batch.messages.length);
      expect(batch.messages[0]).toContain('before');
      expect(batch.messages[1]).toContain('after');
      // 4 = error, 1 = debug. A shifted array would report 'after' as todo.
      expect(batch.levels).toEqual([4, 1]);
    });

    test('counts the entry it could not render', () => {
      const { destination } = build({
        batchSize: 100,
        formatter: throwingOn('bad'),
      });
      destination.write(entry({ message: 'bad' }));
      expect(destination.dropped()).toBe(1);
    });

    // The sink is fine; the formatter is not. Disabling the channel over
    // someone else's bug takes the console down for every entry a working
    // formatter could still have rendered.
    test('does not count against the sink failure run', () => {
      const { destination } = build({
        batchSize: 100,
        formatter: throwingOn('bad'),
      });
      for (let i = 0; i < 5; i += 1)
        destination.write(entry({ message: 'bad' }));
      expect(destination.isEnabled).toBe(true);
    });
  });

  describe('a failing native sink', () => {
    test('a throwing logBatch does not escape into the caller', () => {
      const { sink, destination } = build({ batchSize: 1 });
      sink.throws = true;

      expect(() => destination.write(entry({ message: 'boom' }))).not.toThrow();
      expect(destination.dropped()).toBe(1);
    });

    // A sink throwing every time will not start working because we asked once
    // more, and a try/catch per drain forever costs the app nothing back.
    test('disables itself after a run of failures', () => {
      const { sink, destination } = build({ batchSize: 1 });
      sink.throws = true;

      destination.write(entry({ message: '1' }));
      destination.write(entry({ message: '2' }));
      expect(destination.isEnabled).toBe(true);

      destination.write(entry({ message: '3' }));
      expect(destination.isEnabled).toBe(false);

      // And stays quiet afterwards rather than retrying on every entry.
      destination.write(entry({ message: '4' }));
      expect(destination.dropped()).toBe(3);
    });

    test('a recovered sink resets the failure run', () => {
      const { sink, destination } = build({ batchSize: 1 });

      sink.throws = true;
      destination.write(entry({ message: '1' }));
      destination.write(entry({ message: '2' }));

      sink.throws = false;
      destination.write(entry({ message: '3' }));
      expect(destination.isEnabled).toBe(true);

      sink.throws = true;
      destination.write(entry({ message: '4' }));
      destination.write(entry({ message: '5' }));
      expect(destination.isEnabled).toBe(true);
    });
  });

  describe('option validation', () => {
    // Numbers reach here from application config; NaN or 0 as a batch size
    // would mean either never flushing or flushing on every entry.
    test.each([
      ['batchSize', { batchSize: 0 }],
      ['batchSize NaN', { batchSize: Number.NaN }],
      ['flushIntervalMs', { flushIntervalMs: -5 }],
      ['maxPendingEntries', { maxPendingEntries: 1.5 }],
    ])('%s falls back rather than being honoured', (_name, options) => {
      const { sink, destination } = build(options);
      destination.write(entry({ message: 'still works' }));
      destination.flush();
      expect(sink.entryCount).toBe(1);
    });
  });

  test('works as a registered Logger destination', () => {
    const { sink, destination } = build({ batchSize: 1 });
    const logger = new Logger();
    logger.removeDestination('console').addDestination(destination);

    logger.info('through the logger');

    expect(sink.entryCount).toBe(1);
    expect(sink.batches[0]!.messages[0]).toContain('through the logger');
  });

  // The Logger checks `isEnabled` before it evaluates a lazy message, so a
  // dead sink stops costing render work as well as bridge calls.
  test('a disabled destination is skipped by the Logger before formatting', () => {
    const { sink, destination } = build({ batchSize: 1 });
    const logger = new Logger();
    logger.removeDestination('console').addDestination(destination);

    sink.throws = true;
    for (let i = 0; i < 3; i += 1) logger.info(`fail ${i}`);
    expect(destination.isEnabled).toBe(false);

    let evaluated = false;
    logger.info(() => {
      evaluated = true;
      return 'never rendered';
    });
    expect(evaluated).toBe(false);
  });
});
