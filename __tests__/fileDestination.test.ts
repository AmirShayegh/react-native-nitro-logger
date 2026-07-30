import { FileDestination } from '../src/destinations/FileDestination';
import type { FileDestinationOptions } from '../src/destinations/FileDestination';
import { JsonLinesFormatter } from '../src/formatters/JsonLinesFormatter';
import { DefaultFormatter } from '../src/formatters/DefaultFormatter';
import { Logger } from '../src/Logger';
import { utf8Length } from '../src/utf8';
import type { LogEntry } from '../src/types';
import type { LogFormatter } from '../src/formatters/types';
import { MemoryWriter } from './helpers/MemoryFileSink';
import type { ClearOutcome } from '../src/specs/FileSink.nitro';

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

describe('FileDestination — degradation reporting', () => {
  test('a healthy sink reports nothing wrong', () => {
    const { destination } = build();
    destination.write(entry({ message: 'fine' }));
    destination.flush(1000);
    expect(destination.degradation()).toBe(0);
  });

  test('the sink bitmask reaches the caller', () => {
    const { destination, writer } = build();
    // Rotation | gzip, in the sink's payload-free encoding.
    writer.degraded = 0b011;
    destination.write(entry({ message: 'still fine' }));
    destination.flush(1000);

    expect(destination.degradation()).toBe(0b011);
  });

  test('degradation is not loss', () => {
    const { destination, writer } = build();
    writer.degraded = 0b100;
    destination.write(entry({ message: 'landed anyway' }));
    destination.flush(1000);

    // A failed compression or prune costs disk, not data — the two questions
    // have to be answerable separately.
    expect(destination.degradation()).toBe(0b100);
    expect(destination.unreportedLoss()).toEqual({ entries: 0, bytes: 0 });
    expect(writer.lines()).toHaveLength(1);
  });

  test('a poll picks it up even with nothing to write', () => {
    const { destination, writer } = build();
    destination.flush(1000);
    expect(destination.degradation()).toBe(0);

    writer.degraded = 0b10000;
    destination.flush(1000);
    expect(destination.degradation()).toBe(0b10000);
  });

  test('a durable purge clears it', () => {
    const { destination, writer } = build();
    writer.degraded = 0b011;
    destination.write(entry({ message: 'x' }));
    destination.flush(1000);
    expect(destination.degradation()).toBe(0b011);

    // A purge baselines the sink's counters, degradation included.
    writer.degraded = 0;
    expect(destination.purge(1000).durable).toBe(true);
    expect(destination.degradation()).toBe(0);
  });
});

describe('FileDestination — maintain', () => {
  test('the sweep reaches the sink with the deadline it was given', () => {
    const { destination, sink } = build();
    destination.maintain(250);
    expect(sink.maintainCalls).toEqual([250]);
  });

  test('a bit the sweep raised is reported by that same call', () => {
    const { destination, sink, writer } = build();
    expect(destination.degradation()).toBe(0);

    // The prune that maintenance exists to run is the one that fails, and it
    // fails inside this call — so the mask has to be read after the sweep, not
    // before. Reading it first would report the sweep's own findings one call
    // late, which for a destination nothing is writing to means never.
    sink.onMaintain = () => {
      writer.degraded = 0b100;
    };

    expect(destination.maintain(1000)).toBe(0b100);
    expect(destination.degradation()).toBe(0b100);
  });

  test('it moves no records and reports no loss', () => {
    const { destination, writer } = build();
    destination.write(entry({ message: 'buffered' }));
    destination.maintain(1000);

    // Maintenance is not a flush. A caller that used it as one would find its
    // records still in the buffer, so this pins that it is not one.
    expect(writer.lines()).toEqual([]);
    expect(destination.unreportedLoss()).toEqual({ entries: 0, bytes: 0 });
  });

  test('a disposed destination sweeps nothing and keeps the mask it had', () => {
    const { destination, sink, writer } = build();
    writer.degraded = 0b010;
    destination.flush(1000);
    destination.dispose();

    // The sink is closed; asking it to sweep would get the zeroed status a
    // released handle answers with, and folding that in would quietly retract
    // a degradation the app has already been told about.
    expect(destination.maintain(1000)).toBe(0b010);
    expect(sink.maintainCalls).toEqual([]);
  });

  test('a fenced destination sweeps nothing and keeps the mask it had', () => {
    const { destination, sink, writer } = build();
    const other = writer.attach();
    writer.degraded = 0b001;
    destination.write(entry({ message: 'pre-purge' }));
    destination.flush(1000);
    expect(destination.degradation()).toBe(0b001);

    // Someone else purged underneath it. The files this one would sweep are
    // the new generation's.
    other.clearLogs(1000);
    destination.write(entry({ message: 'fences it' }));
    destination.flush(1000);
    expect(destination.isEnabled).toBe(false);

    const before = sink.maintainCalls.length;
    expect(destination.maintain(1000)).toBe(destination.degradation());
    expect(sink.maintainCalls).toHaveLength(before);
  });

  test('a sweep that throws leaves the mask where it stood', () => {
    const { destination, sink, writer } = build();
    writer.degraded = 0b100;
    destination.flush(1000);
    sink.maintainThrows = true;

    // Nothing is watching a timer tick, so a native throw has to stop here.
    expect(() => destination.maintain(1000)).not.toThrow();
    expect(destination.degradation()).toBe(0b100);
  });
});

describe('FileDestination — collectForSupport', () => {
  test('the buffer is flushed into the bundle before it is packed', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'still buffered' }));

    const outcome = destination.collectForSupport({ maxTotalBytes: 1_000_000 });

    // The native side flushes its own queue, but records the batcher has not
    // handed over yet are not in that queue. A bundle missing the last few
    // seconds is missing the part somebody is asking about.
    expect(outcome.complete).toBe(true);
    expect(sink.collectedBundles).toHaveLength(1);
    expect(sink.collectedBundles[0]).toContain('still buffered');
  });

  test('the bundle path is the sinks own, never the callers', () => {
    const { destination, sink } = build({ path: '/memory/logs/custom.log' });
    destination.write(entry());

    const outcome = destination.collectForSupport({ maxTotalBytes: 1_000_000 });

    expect(outcome.path).toBe('/memory/logs/custom.log.support.gz');
    expect(sink.bundlePath).toBe('/memory/logs/custom.log.support.gz');
  });

  test('the ceiling and the deadline reach the sink', () => {
    const { destination, sink } = build();
    destination.collectForSupport({ maxTotalBytes: 4096, deadlineMs: 250 });
    expect(sink.collectCalls).toEqual([
      { deadlineMs: 250, maxTotalBytes: 4096 },
    ]);
  });

  test('the default deadline is longer than a flush deadline', () => {
    const { destination, sink } = build();
    destination.collectForSupport({ maxTotalBytes: 4096 });

    // Compressing a log is not draining a buffer. A caller that took the
    // default and got a 2s bound would see `complete: false` on ordinary logs,
    // which reads as a broken feature rather than as a bound they chose.
    expect(sink.collectCalls[0]?.deadlineMs).toBeGreaterThan(2000);
  });

  test('a ceiling of zero collects nothing, and says it finished doing that', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'secret' }));

    const outcome = destination.collectForSupport({ maxTotalBytes: 0 });

    expect(outcome.path).toBe('');
    expect(outcome.truncated).toBe(true);
    expect(outcome.complete).toBe(true);
    expect(sink.collectedBundles).toEqual([]);
  });

  test.each([
    [NaN],
    [-1],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
  ])('a ceiling of %p is refused rather than interpreted', (ceiling) => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'secret' }));

    // The dangerous reading of a broken number is "no ceiling", and every one
    // of these has a plausible path to it: `Infinity` most obviously, `NaN`
    // through a comparison that is false either way. A throw puts the bug
    // where the arithmetic is instead of shipping the whole log.
    expect(() =>
      destination.collectForSupport({ maxTotalBytes: ceiling })
    ).toThrow(RangeError);
    expect(sink.collectCalls).toEqual([]);
  });

  test('a destination with nothing to collect is not an error', () => {
    const { destination } = build();

    const outcome = destination.collectForSupport({ maxTotalBytes: 1_000_000 });

    // `complete: true` with no path. A support flow showing "collection
    // failed" to a user whose app simply has not logged anything would send
    // them chasing a fault that is not there.
    expect(outcome).toEqual({
      path: '',
      byteCount: 0,
      sourceFileCount: 0,
      truncated: false,
      complete: true,
    });
  });

  test('a disposed destination collects nothing', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'written' }));
    destination.dispose();

    const outcome = destination.collectForSupport({ maxTotalBytes: 1_000_000 });

    expect(outcome.complete).toBe(false);
    expect(outcome.path).toBe('');
    expect(sink.collectCalls).toEqual([]);
  });

  test('a fenced destination collects nothing', () => {
    const { destination, sink, writer } = build();
    const other = writer.attach();
    destination.write(entry({ message: 'pre-purge' }));
    destination.flush(1000);

    // Someone else purged underneath it. The files this one would pack are the
    // new generation's, and a bundle built from them would be a stale read of
    // somebody else's log.
    other.clearLogs(1000);
    destination.write(entry({ message: 'fences it' }));
    destination.flush(1000);
    expect(destination.isEnabled).toBe(false);

    const outcome = destination.collectForSupport({ maxTotalBytes: 1_000_000 });

    expect(outcome.complete).toBe(false);
    expect(sink.collectCalls).toEqual([]);
  });

  test('a native throw is reported as an unfinished collect', () => {
    const { destination, sink } = build();
    destination.write(entry());
    sink.collectThrows = true;

    // The caller is a support flow. It can do nothing with a native error
    // object that it cannot do with "there is no bundle".
    let outcome!: ReturnType<FileDestination['collectForSupport']>;
    expect(() => {
      outcome = destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    }).not.toThrow();
    expect(outcome.complete).toBe(false);
    expect(outcome.path).toBe('');
  });

  test('a bit the collect raised is reported by the same call', () => {
    const { destination, sink, writer } = build();
    destination.write(entry());
    expect(destination.degradation()).toBe(0);

    // `CollectOutcome` carries no status, so the destination has to go and read
    // one. Without that, a bundle written without its file protections would
    // leave the app believing the sink is healthy until some unrelated later
    // append happened to notice — which for a quiet destination means never.
    sink.onCollect = () => {
      writer.degraded = 0b10000;
    };

    destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    expect(destination.degradation()).toBe(0b10000);
  });

  test('a status read that throws does not discard the bundle', () => {
    const { destination, sink } = build();
    destination.write(entry());
    sink.statusThrows = true;

    // The collect already succeeded on its own terms. Losing its result to a
    // failed follow-up read would throw away a bundle that is on disk.
    const outcome = destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    expect(outcome.complete).toBe(true);
    expect(outcome.path).not.toBe('');
  });

  test('two failed collects do not share one outcome object', () => {
    const { destination } = build();
    destination.dispose();

    const first = destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    first.path = '/tmp/somewhere-else';

    // `CollectOutcome` crosses the Nitro boundary with mutable fields. A shared
    // constant handed to every failed call would let one caller's edit change
    // what the next one is told.
    const second = destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    expect(second.path).toBe('');
  });

  test('collecting twice replaces the bundle rather than adding one', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'first' }));
    const first = destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    destination.write(entry({ message: 'second' }));
    const second = destination.collectForSupport({ maxTotalBytes: 1_000_000 });

    expect(second.path).toBe(first.path);
    expect(sink.collectedBundles[1]).toContain('second');
    expect(sink.collectedBundles[1]).toContain('first');
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
    expect(outcome.rebound).toBe(false);
    expect(destination.isEnabled).toBe(false);
  });

  // A complete deletion with no file to write to afterwards is the case that
  // reads as success and behaves as data loss: resuming on `durable` alone
  // hands every record to a sink that accepts it, refuses it as stale, and
  // drops it — silently, because the purge said it worked.
  test('a complete deletion the sink could not reopen keeps the handle fenced', () => {
    const { destination, writer } = build();
    writer.reopenFails = true;
    destination.write(entry({ message: 'before' }));

    const outcome = destination.purge(1000);

    expect(outcome.durable).toBe(true);
    expect(outcome.rebound).toBe(false);
    expect(outcome.failedPaths).toHaveLength(0);
    expect(destination.isEnabled).toBe(false);
  });

  // A JS bundle can be updated over the air without the native binary under it
  // changing, so "new JS, old native" is a real pairing — and the sink most
  // likely to omit `rebound` is one that predates it, including a build that
  // deletes by closing and never reopens at all. Reading silence as success
  // there rebuilds the very loss the flag exists to stop.
  test('a sink that does not report rebound at all is not assumed to have rebound', () => {
    const { destination, sink } = build();
    // Deliberately missing `rebound` — the cast has to go through `unknown`
    // precisely because the current spec makes the field mandatory. This is a
    // stand-in for a binary compiled before it existed.
    sink.clearLogs = () =>
      ({
        deletedCount: 3,
        failedPaths: [],
        durable: true,
      }) as unknown as ClearOutcome;

    const outcome = destination.purge(1000);

    expect(outcome.durable).toBe(true);
    expect(outcome.rebound).toBe(false);
    expect(destination.isEnabled).toBe(false);
  });

  test('records written after an unrebound purge are held, not silently lost', () => {
    const { destination, writer } = build();
    writer.reopenFails = true;
    expect(destination.purge(1000).rebound).toBe(false);

    destination.write(entry({ message: 'after' }));
    destination.flush(1000);
    expect(records(writer)).toHaveLength(0);

    // And an explicit retry, once there is somewhere to write again, is what
    // brings the destination back.
    writer.reopenFails = false;
    const retry = destination.purge(1000);
    expect(retry.durable).toBe(true);
    expect(retry.rebound).toBe(true);
    expect(destination.isEnabled).toBe(true);

    destination.write(entry({ message: 'later' }));
    destination.flush(1000);
    expect(records(writer).map((r) => r.message)).toEqual(['later']);
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

  test('purging a disposed destination reports failure, not a silent success', () => {
    const { destination, writer } = build();
    destination.write(entry({ message: 'on disk' }));
    destination.dispose();

    // The sequence this guards is ordinary, not contrived: remove the file
    // destination, then honour a "delete my data" request. Answering
    // `durable: true` there tells a caller under a legal obligation that
    // patient data is gone while it is still sitting on disk.
    const outcome = destination.purge(1000);

    expect(outcome.durable).toBe(false);
    expect(outcome.rebound).toBe(false);
    expect(outcome.deletedCount).toBe(0);
    expect(records(writer).map((r) => r.message)).toEqual(['on disk']);
  });

  test('a disposed destination does not consult the sink at all to answer a purge', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'on disk' }));
    destination.dispose();

    // `FileSinkLike` is a structural, public interface — the two adapters this
    // package ships are not the only implementations, and one of them
    // answering `durable: true` for a released handle must not be able to
    // become this destination's answer. So the guard refuses locally rather
    // than trusting whatever comes back.
    sink.clearLogs = () => ({
      deletedCount: 99,
      failedPaths: [],
      durable: true,
      rebound: true,
    });

    const outcome = destination.purge(1000);

    expect(sink.clearCalls).toBe(0);
    expect(outcome.durable).toBe(false);
    expect(outcome.deletedCount).toBe(0);
    // And the fence must not lift on a lie, either.
    expect(destination.isEnabled).toBe(false);
  });

  test('a purge that never opened anything is still durable', () => {
    // The other side of the same distinction. Nothing was ever created, so
    // there is nothing to delete and the vacuous answer is the true one — this
    // is what the disposed guard above must not accidentally swallow.
    const { destination, writer } = build();
    const outcome = destination.purge(1000);

    expect(outcome.durable).toBe(true);
    expect(writer.file).toEqual([]);
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

/**
 * The double is only worth anything if it can fail the way the real thing
 * fails, and answer the way the real thing answers.
 *
 * These are `FileSinkLifecycle`'s no-live-handle rules — the table both native
 * adapters derive from — asserted against the in-memory sink. The double had
 * two divergences from it: it named a `failedPath` for a deletion nobody
 * attempted, and it hardcoded `durable: false` even for a sink that never
 * opened, where the claim is vacuously true. Neither was reachable through
 * `FileDestination`, which short-circuits before a disposed sink; both would
 * have been inherited by the next caller that was not guarded.
 */
describe('MemoryFileSink — the no-handle rules the natives follow', () => {
  test('a closed sink that wrote files cannot claim a durable purge', () => {
    const writer = new MemoryWriter();
    const sink = writer.attach();
    sink.open('/memory/logs/app.log', undefined, true);
    sink.appendBatch('{"m":1}\n', 1);
    sink.close(1000);

    const outcome = sink.clearLogs(1000);

    expect(outcome.durable).toBe(false);
    expect(outcome.deletedCount).toBe(0);
    expect(outcome.rebound).toBe(false);
    // Nothing was attempted, so nothing failed. A path here reports a deletion
    // failure for a file no one tried to delete.
    expect(outcome.failedPaths).toEqual([]);
  });

  test('a sink that never opened purges vacuously, not falsely', () => {
    const writer = new MemoryWriter();
    const sink = writer.attach();
    sink.close(1000);

    const outcome = sink.clearLogs(1000);

    // Nothing was ever created, so "every artifact is gone" holds with nothing
    // to check. `false` here would re-arm a compliance failure for a sink that
    // cannot owe one.
    expect(outcome.durable).toBe(true);
    expect(outcome.failedPaths).toEqual([]);
    expect(outcome.rebound).toBe(false);
  });
});
