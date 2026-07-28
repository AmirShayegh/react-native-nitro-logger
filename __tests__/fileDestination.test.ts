import { FileDestination } from '../src/destinations/FileDestination';
import type { FileDestinationOptions } from '../src/destinations/FileDestination';
import { JsonLinesFormatter } from '../src/formatters/JsonLinesFormatter';
import { DefaultFormatter } from '../src/formatters/DefaultFormatter';
import { Logger } from '../src/Logger';
import { utf8Length } from '../src/utf8';
import type { LogEntry } from '../src/types';
import type { LogFormatter } from '../src/formatters/types';
import { MemoryWriter } from './helpers/MemoryFileSink';

const at = Date.UTC(2026, 6, 27, 12, 15, 30, 842);

function entry(partial: Partial<LogEntry> = {}): LogEntry {
  return Object.freeze({
    timestamp: at,
    level: 'info' as const,
    message: 'msg',
    ...partial,
  });
}

function build(options: FileDestinationOptions = {}) {
  const writer = new MemoryWriter();
  const sink = writer.attach();
  const destination = new FileDestination(sink, {
    flushIntervalMs: 100,
    ...options,
  });
  return { destination, sink, writer };
}

/** Records actually on disk, parsed. */
function records(writer: MemoryWriter): Array<Record<string, unknown>> {
  return writer.lines().map((line) => JSON.parse(line));
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('FileDestination — opening', () => {
  test('derives a path under the sink default directory', () => {
    const { sink } = build();
    expect(sink.openedPath).toBe('/memory/logs/app.log');
    expect(sink.openCount).toBe(1);
  });

  test('an explicit path and rotation config reach the sink verbatim', () => {
    const rotation = {
      maxFileSizeBytes: 1024,
      maxArchivedFilesCount: 3,
      compressArchives: true,
    };
    const { sink } = build({ path: '/memory/logs/custom.log', rotation });
    expect(sink.openedPath).toBe('/memory/logs/custom.log');
    expect(sink.openedRotation).toEqual(rotation);
  });

  test('a failed open surfaces instead of writing nowhere', () => {
    const writer = new MemoryWriter();
    const first = writer.attach();
    const held = new FileDestination(first, { path: '/memory/logs/a.log' });
    expect(held.filePath).toBe('/memory/logs/a.log');

    const second = writer.attach();
    expect(
      () => new FileDestination(second, { path: '/memory/logs/b.log' })
    ).toThrow();
  });
});

describe('FileDestination — framing contract', () => {
  test('a formatter guaranteeing one record per line declares it', () => {
    const { sink, destination } = build({
      formatter: new JsonLinesFormatter(),
    });
    expect(sink.openedLineFramed).toBe(true);
    expect(destination.lineFramed).toBe(true);
  });

  test('a formatter that makes no such guarantee declares nothing', () => {
    // DefaultFormatter indents multi-line messages across lines on purpose,
    // so a trailing partial record is not something native can identify.
    const { sink, destination } = build({ formatter: new DefaultFormatter() });
    expect(sink.openedLineFramed).toBe(false);
    expect(destination.lineFramed).toBe(false);
  });

  test('the declaration follows the formatter, not the destination', () => {
    const opaque: LogFormatter = { format: () => 'anything' };
    const { sink } = build({ formatter: opaque });
    expect(sink.openedLineFramed).toBe(false);
  });
});

describe('FileDestination — writing', () => {
  test('records land as parseable JSON lines', () => {
    const { destination, writer } = build();
    destination.write(entry({ message: 'hello', correlation: 'job-1' }));
    destination.write(entry({ message: 'again', subsystem: 'net' }));
    destination.flush(1000);

    expect(records(writer)).toEqual([
      {
        timestamp: '2026-07-27T12:15:30.842Z',
        level: 'INFO',
        message: 'hello',
        correlation: 'job-1',
      },
      {
        timestamp: '2026-07-27T12:15:30.842Z',
        level: 'INFO',
        message: 'again',
        subsystem: 'net',
      },
    ]);
  });

  test('a message with a newline in it cannot break the framing', () => {
    const { destination, writer } = build();
    destination.write(entry({ message: 'a\nb' }));
    destination.flush(1000);

    expect(writer.lines()).toHaveLength(1);
    expect(records(writer)[0]!.message).toBe('a\nb');
  });

  test('the loss notice is itself a valid record', () => {
    const { destination, writer } = build({ maxPendingEntries: 1 });
    destination.write(entry({ message: 'kept' }));
    destination.write(entry({ message: 'dropped' }));
    destination.flush(1000);

    const written = records(writer);
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({
      level: 'WARNING',
      message: 'log entries were dropped',
      subsystem: 'logger',
      metadata: { droppedEntries: 1 },
    });
  });
});

describe('FileDestination — oversized entries', () => {
  test('a formatter that can shed structure is asked to', () => {
    const { destination, writer } = build({ maxEntryBytes: 200 });
    destination.write(
      entry({
        message: 'x'.repeat(5000),
        metadata: { a: 'one', b: 'two', c: 'three' },
      })
    );
    destination.flush(1000);

    const [written] = records(writer);
    expect(written!.truncated).toBe(true);
    expect(written!.message).not.toHaveLength(5000);
    expect(utf8Length(writer.lines()[0]!)).toBeLessThanOrEqual(200);
  });

  test('truncation never splits a surrogate pair', () => {
    const { destination, writer } = build({ maxEntryBytes: 120 });
    destination.write(entry({ message: '😀'.repeat(500) }));
    destination.flush(1000);

    const message = records(writer)[0]!.message as string;
    const lone =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(lone.test(message)).toBe(false);
    expect(message.length).toBeGreaterThan(0);
  });

  test('a formatter that cannot is replaced whole, never sliced', () => {
    // The point of the rule: a fragment of a record is not a record, and a
    // file of fragments is one no parser will read back.
    const opaque: LogFormatter = {
      framing: 'line',
      format: (e) => `OPAQUE:${e.message}`,
    };
    const { destination, writer } = build({
      formatter: opaque,
      maxEntryBytes: 200,
    });

    destination.write(entry({ message: 'y'.repeat(5000) }));
    destination.flush(1000);

    // The record is replaced in place, and the entry it stood for is still
    // counted — so the file says both what was there and that it is gone.
    expect(writer.lines()).toEqual([
      'OPAQUE:a log entry was too large to record',
      'OPAQUE:log entries were dropped',
    ]);
    expect(writer.lines().join('')).not.toContain('yyy');
  });

  test('the replacement counts as a loss, so the gap is on the record', () => {
    const opaque: LogFormatter = { format: (e) => `OPAQUE:${e.message}` };
    const { destination } = build({ formatter: opaque, maxEntryBytes: 200 });

    destination.write(entry({ message: 'y'.repeat(5000) }));
    expect(destination.unreportedLoss().entries).toBe(1);
  });

  test('an entry too large even for the notice writes nothing at all', () => {
    const { destination, writer } = build({ maxEntryBytes: 10 });
    destination.write(entry({ message: 'z'.repeat(5000) }));

    // Even the fixed replacement was over the limit, so nothing stood in for
    // the entry. Counting it is what stops that from being silent.
    expect(destination.unreportedLoss().entries).toBe(1);

    destination.flush(1000);
    // Not even the loss notice fits under a limit this small, and it is held
    // to the same limit as everything else — an exempt notice could be one
    // the sink refuses forever, jamming the pipeline with the pipeline's own
    // diagnostics. Nothing written, and the loss still owed.
    expect(writer.lines()).toHaveLength(0);
    expect(destination.unreportedLoss().entries).toBe(1);
  });

  test('the loss reported is the size of the entry, not of the floor', () => {
    // formatWithin keeps correlation and subsystem even when it cannot get
    // under budget, so a long correlation ID gives a floor that is still too
    // big. What was discarded is the whole 5 KB entry; reporting the size of
    // the fallback would understate the gap by an order of magnitude.
    const { destination, writer } = build({ maxEntryBytes: 220 });
    destination.write(
      entry({ message: 'x'.repeat(5000), correlation: 'c'.repeat(300) })
    );

    expect(destination.unreportedLoss().bytes).toBeGreaterThan(5000);

    destination.flush(1000);
    const [oversize] = records(writer);
    expect(oversize!.message).toBe('a log entry was too large to record');
    expect(
      (oversize!.metadata as { droppedBytes: number }).droppedBytes
    ).toBeGreaterThan(5000);
  });

  test('an entry inside the limit is left exactly alone', () => {
    const { destination, writer } = build({ maxEntryBytes: 64 * 1024 });
    destination.write(entry({ message: 'small' }));
    destination.flush(1000);
    expect(records(writer)[0]!.truncated).toBeUndefined();
  });

  test('a throwing formatter costs one entry, not the pipeline', () => {
    const angry: LogFormatter = {
      format: () => {
        throw new Error('formatter exploded');
      },
    };
    const { destination, writer } = build({ formatter: angry });

    expect(() => destination.write(entry())).not.toThrow();
    expect(destination.unreportedLoss().entries).toBe(1);
    destination.flush(1000);
    expect(writer.lines()).toHaveLength(0); // the notice cannot render either
  });
});

describe('FileDestination — purge', () => {
  test('discards the buffer rather than writing it into the file it deletes', () => {
    const { destination, writer } = build();
    destination.write(entry({ message: 'pre-purge' }));

    const outcome = destination.purge(1000);

    expect(outcome.durable).toBe(true);
    expect(outcome.discardedEntries).toBe(1);
    expect(outcome.discardedBytes).toBeGreaterThan(0);
    expect(writer.lines()).toHaveLength(0);
  });

  test('a durable purge rebinds the handle and logging continues', () => {
    const { destination, writer } = build();
    destination.write(entry({ message: 'before' }));
    destination.purge(1000);

    expect(destination.isEnabled).toBe(true);
    destination.write(entry({ message: 'after' }));
    destination.flush(1000);

    expect(records(writer).map((r) => r.message)).toEqual(['after']);
  });

  test('the counts come back instead of becoming a notice in the fresh file', () => {
    const { destination, writer } = build({ maxPendingEntries: 1 });
    destination.write(entry({ message: 'kept' }));
    destination.write(entry({ message: 'dropped' }));

    const outcome = destination.purge(1000);
    expect(outcome.discardedEntries).toBe(2);

    destination.write(entry({ message: 'after' }));
    destination.flush(1000);
    expect(records(writer).map((r) => r.message)).toEqual(['after']);
  });

  test('a failed purge leaves the handle disabled, not half-open', () => {
    const { destination, writer } = build();
    writer.clearFails = true;
    destination.write(entry({ message: 'before' }));

    const outcome = destination.purge(1000);

    expect(outcome.durable).toBe(false);
    expect(outcome.failedPaths).toHaveLength(1);
    // A late deletion must never race a fresh write.
    expect(destination.isEnabled).toBe(false);
  });

  test('retrying a failed purge is what re-enables the handle', () => {
    const { destination, writer } = build();
    writer.clearFails = true;
    expect(destination.purge(1000).durable).toBe(false);
    expect(destination.isEnabled).toBe(false);

    writer.clearFails = false;
    expect(destination.purge(1000).durable).toBe(true);
    expect(destination.isEnabled).toBe(true);
  });

  test('a throwing clearLogs is a failed purge, not a crash', () => {
    const { destination, sink } = build();
    sink.clearLogs = () => {
      throw new Error('native purge failed');
    };
    const outcome = destination.purge(1000);
    expect(outcome.durable).toBe(false);
    expect(destination.isEnabled).toBe(false);
  });
});

describe('FileDestination — a second handle', () => {
  function pair() {
    const writer = new MemoryWriter();
    const sinkA = writer.attach();
    const sinkB = writer.attach();
    const a = new FileDestination(sinkA, { label: 'file-a' });
    const b = new FileDestination(sinkB, { label: 'file-b' });
    return { writer, sinkA, sinkB, a, b };
  }

  test('it is fenced by the purge and does not replay pre-purge records', () => {
    const { writer, a, b } = pair();
    b.write(entry({ message: 'b-pre-purge' }));

    a.purge(1000);
    b.flush(1000);

    expect(b.isEnabled).toBe(false);
    expect(writer.lines().join('')).not.toContain('b-pre-purge');
  });

  test('the purging handle rebinds while the other stays fenced', () => {
    const { writer, a, b } = pair();
    a.purge(1000);

    a.write(entry({ message: 'a-after' }));
    b.write(entry({ message: 'b-after' }));
    a.flush(1000);
    b.flush(1000);

    expect(records(writer).map((r) => r.message)).toEqual(['a-after']);
  });

  test('losses are attributed per handle, not pooled', () => {
    // A second runtime that dies with unreported losses takes them with it.
    // Charging them to this handle would put a number in this file that
    // describes entries it never had.
    const { writer, sinkB, a } = pair();
    writer.injectLoss(sinkB.id, 12, 1200);

    a.write(entry({ message: 'mine' }));
    a.flush(1000);

    expect(records(writer).map((r) => r.message)).toEqual(['mine']);
    expect(a.unreportedLoss()).toEqual({ entries: 0, bytes: 0 });
  });
});

describe('FileDestination — lifecycle', () => {
  test('dispose drains what is buffered and closes the sink', () => {
    const { destination, sink, writer } = build();
    destination.write(entry({ message: 'last' }));
    destination.dispose();

    expect(sink.closeCalls).toBe(1);
    expect(records(writer).map((r) => r.message)).toEqual(['last']);
    expect(destination.isEnabled).toBe(false);
  });

  test('dispose is idempotent', () => {
    const { destination, sink } = build();
    destination.dispose();
    destination.dispose();
    expect(sink.closeCalls).toBe(1);
  });

  test('a closing sink that throws does not take the caller with it', () => {
    const { destination, sink } = build();
    sink.close = () => {
      throw new Error('native close failed');
    };
    expect(() => destination.dispose()).not.toThrow();
  });

  test('getLogFilePaths reports nothing rather than throwing', () => {
    const { destination, sink } = build();
    expect(destination.getLogFilePaths()).toEqual(['/memory/logs/app.log']);

    sink.getLogFilePaths = () => {
      throw new Error('native enumeration failed');
    };
    expect(destination.getLogFilePaths()).toEqual([]);
  });
});

describe('FileDestination — through the Logger', () => {
  function wired() {
    const writer = new MemoryWriter();
    const sink = writer.attach();
    const destination = new FileDestination(sink);
    const logger = new Logger();
    logger.removeDestination('console').addDestination(destination);
    return { logger, destination, writer, sink };
  }

  test('log calls reach the file with redaction already applied', () => {
    const { logger, writer } = wired();
    logger.info('served', { route: '/patients' });
    logger.flush(1000);

    expect(records(writer)).toHaveLength(1);
    expect(records(writer)[0]).toMatchObject({
      level: 'INFO',
      message: 'served',
      metadata: { route: '/patients' },
    });
  });

  test('level filtering happens before anything is formatted', () => {
    const { logger, writer, sink } = wired();
    logger.minimumLevel('error');
    logger.info('quiet');
    logger.flush(1000);

    expect(writer.lines()).toHaveLength(0);
    expect(sink.appendCalls).toHaveLength(0);
  });

  test('a purged destination stops receiving without disabling the logger', () => {
    const { logger, destination, writer } = wired();
    writer.clearFails = true;
    destination.purge(1000);

    // isEnabled is false, so the logger skips it — and keeps working.
    expect(() => logger.info('after')).not.toThrow();
    logger.flush(1000);
    expect(writer.lines()).toHaveLength(0);
  });

  test('removing the destination flushes and closes it', () => {
    const { logger, writer, sink } = wired();
    logger.info('final');
    logger.removeDestination('file');

    expect(sink.closeCalls).toBe(1);
    expect(records(writer).map((r) => r.message)).toEqual(['final']);
  });
});
