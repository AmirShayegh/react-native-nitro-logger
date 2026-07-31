import { FileDestination } from '../src/destinations/FileDestination';
import type { FileDestinationOptions } from '../src/destinations/FileDestination';
import { JsonLinesFormatter } from '../src/formatters/JsonLinesFormatter';
import { DefaultFormatter } from '../src/formatters/DefaultFormatter';
import { Logger } from '../src/Logger';
import { utf8Length } from '../src/utf8';
import type { LogEntry } from '../src/types';
import type { LogFormatter } from '../src/formatters/types';
import { MemoryWriter } from './helpers/MemoryFileSink';
import type { MemoryFileSink } from './helpers/MemoryFileSink';
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
    // the new generation's. `other` has to be *open* to purge: a handle that
    // never opened has no live handle to delete through, and both natives
    // refuse it — see the no-handle rows of `FileSinkLifecycle`'s table.
    other.open(sink.openedPath!, undefined, true);
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
    // somebody else's log. `other` is opened first because a handle that never
    // opened cannot purge — the natives answer that with no deletion at all.
    other.open(sink.openedPath!, undefined, true);
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
    // The cast is the point, not a workaround. `CollectOutcome`'s fields are
    // `readonly` from 0.3.0, which tells a TypeScript caller not to do this and
    // stops nothing at runtime — the annotation is erased, and the object that
    // crosses the Nitro boundary is an ordinary mutable one. So the hazard the
    // assertion below guards is still exactly as real as it was.
    (first as { path: string }).path = '/tmp/somewhere-else';

    // A shared constant handed to every failed call would let one caller's
    // edit change what the next one is told.
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

describe('FileDestination — deleteSupportBundle', () => {
  test('the bundle a collect produced is gone afterwards', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'in the bundle' }));
    destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    expect(sink.bundleExists).toBe(true);

    // Asserted on the sink's own state, not just on the returned boolean: a
    // wrapper that answered `true` without calling anything would pass the
    // second assertion alone.
    expect(destination.deleteSupportBundle()).toBe(true);
    expect(sink.bundleExists).toBe(false);
  });

  test('deleting a bundle that was never collected is true, not an error', () => {
    const { destination, sink } = build();

    // The overwhelmingly common case for a retry, and for a support flow whose
    // collect found nothing to pack. "Already gone" is the outcome the caller
    // asked for.
    expect(destination.deleteSupportBundle()).toBe(true);
    expect(sink.bundleExists).toBe(false);
  });

  test('the deadline reaches the sink, and defaults without one', () => {
    const { destination, sink } = build();
    destination.deleteSupportBundle(250);
    destination.deleteSupportBundle();

    expect(sink.deleteBundleCalls[0]).toBe(250);
    // Three unlinks and an fsync, not a compression pass — so this takes the
    // ordinary deadline rather than the collect's longer one.
    expect(sink.deleteBundleCalls[1]).toBe(2000);
  });

  test('a disposed destination refuses, and leaves the bundle alone', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'collected before teardown' }));
    destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    destination.dispose();

    // Tempting to allow — the upload really can finish after teardown — and
    // wrong. With the handle gone there is no generation left to check, so
    // another destination may own that path by now and be mid-publish in it,
    // and the bundle removed would be *its* bundle. `getLogFilePaths` still
    // answering after dispose is not a precedent: reading a directory you no
    // longer own is harmless, deleting from it is not.
    const callsBefore = sink.deleteBundleCalls.length;

    expect(destination.deleteSupportBundle()).toBe(false);
    expect(sink.bundleExists).toBe(true);
    // The sink is never reached, which is what pins THIS guard rather than the
    // double's. Both refuse a disposed sink — the adapters do it too — so
    // without this the assertions above pass on a wrapper that has no guard at
    // all and simply relays whatever the sink says.
    expect(sink.deleteBundleCalls).toHaveLength(callsBefore);
  });

  test('a sink that never opened has nothing to delete, vacuously', () => {
    // Asserted on the sink, because a `FileDestination` opens in its
    // constructor and cannot reach this state. It is the other side of the
    // no-handle case and the reason that case is not a blanket refusal:
    // nothing was ever created, so "no bundle remains" holds with nothing to
    // check — the same `!mayHaveArtifacts` both adapters read.
    const neverOpened = new MemoryWriter().attach();

    expect(neverOpened.deleteSupportBundle(1000)).toBe(true);
  });

  test('a fenced destination refuses, and leaves the bundle alone', () => {
    const { destination, sink, writer } = build();
    destination.write(entry({ message: 'in the bundle' }));
    destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    fenceFromOutside(destination, writer.attach());

    // The opposite answer to the disposed case, and the right one: a fence
    // means a purge moved the writer on, so the bundle in that directory is
    // whoever holds the writer's now — the same reason `collectForSupport`
    // declines to pack it.
    expect(destination.deleteSupportBundle()).toBe(false);
    expect(sink.bundleExists).toBe(true);
  });

  test('a destination that has not yet noticed it is stale reports the sinks refusal', () => {
    const { destination, sink, writer } = build();
    destination.write(entry({ message: 'in the bundle' }));
    destination.collectForSupport({ maxTotalBytes: 1_000_000 });

    // A sibling purges; this destination is now stale at the sink and does not
    // know it, because fencing is not instantaneous — a handle finds out on its
    // next write, and this one has not written since. So `isEnabled` is still
    // true here while the sink refuses.
    const other = writer.attach();
    other.open('/memory/logs/app.log', undefined, true);
    other.clearLogs(1000);
    expect(destination.isEnabled).toBe(true);

    // The wrapper must return what the sink said. Answering `true` off the back
    // of its own un-updated flag would tell a support flow the copy is gone
    // while it is sitting in another generation's directory.
    expect(destination.deleteSupportBundle()).toBe(false);
    expect(sink.bundleExists).toBe(true);
  });

  test('a native throw is reported as false, not raised at the caller', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'in the bundle' }));
    destination.collectForSupport({ maxTotalBytes: 1_000_000 });
    sink.deleteBundleThrows = true;

    // A support flow can act on "the copy may still be there". It can do
    // nothing with a native error object that it cannot do with that fact.
    expect(destination.deleteSupportBundle()).toBe(false);
    expect(sink.bundleExists).toBe(true);
  });

  test('a purge removes the bundle too, so a later delete is vacuously true', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'in the bundle' }));
    destination.collectForSupport({ maxTotalBytes: 1_000_000 });

    expect(destination.purge(1000).durable).toBe(true);
    // A compliance purge that left a gzipped copy of the log behind would not
    // be a purge. Both natives sweep the three support names with everything
    // else, and this is the JS side of that claim.
    expect(sink.bundleExists).toBe(false);
    expect(destination.deleteSupportBundle()).toBe(true);
  });
});

/**
 * Fences `victim` the way production does — a second handle purges the writer,
 * and the victim finds out on its next write by having the append rejected.
 *
 * Not `victim.purge()`: that rebinds its own caller, so it produces a *live*
 * destination rather than a fenced one. The asymmetry is the whole point of
 * every test that uses this.
 */
function fenceFromOutside(
  victim: FileDestination,
  other: MemoryFileSink,
  path = '/memory/logs/app.log'
): void {
  other.open(path, undefined, true);
  other.clearLogs(1000);
  victim.write(entry({ message: 'rejected by a stale generation' }));
  victim.flush(1000);
  expect(victim.isEnabled).toBe(false);
}

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

  /**
   * The size that travels to the batcher is the size of what it is given.
   *
   * `write` now hands the batcher the byte count rendering already computed,
   * so the count is not measured twice per record. The trap is on this path:
   * the string that reaches the batcher on an oversize entry is the *notice*,
   * a couple of hundred bytes, while the number in scope a line earlier is the
   * five-kilobyte entry that caused it. Handing over that number would inflate
   * the batcher's pending total by twenty times per oversize record, which
   * would then flush early, refuse records it had room for, and report a
   * buffered figure that matches nothing on disk.
   *
   * Buffered bytes are the assertion because they are the batcher's own
   * arithmetic — the one number that comes from what it was told rather than
   * from what it can see.
   */
  test('an oversize entry buffers the notice size, not the entry size', () => {
    // `maxPendingBytes` is the instrument: 1000 is roomy for the notice, which
    // fits inside `maxEntryBytes` by construction, and far too small for the
    // 5 KB entry. So if the entry's size were the number handed over, the
    // batcher would believe its buffer had just overflowed and drop the notice
    // — and the file would end up with nothing in it at all.
    const { destination, writer } = build({
      maxEntryBytes: 220,
      maxPendingBytes: 1000,
    });
    destination.write(
      entry({ message: 'x'.repeat(5000), correlation: 'c'.repeat(300) })
    );
    destination.flush(1000);

    const [written] = records(writer);
    expect(written!.message).toBe('a log entry was too large to record');
    // One loss — the entry — not two.
    expect(destination.unreportedLoss().entries).toBe(0);
  });

  test('a shortened entry buffers its shortened size', () => {
    // The same hazard one branch over: `formatWithin` got under the limit, so
    // what reaches the batcher is the shortened record — not the original that
    // was measured before shortening was attempted.
    const { destination, writer } = build({
      maxEntryBytes: 400,
      maxPendingBytes: 1000,
    });
    destination.write(entry({ message: 'x'.repeat(5000) }));
    destination.flush(1000);

    // Asserting on the CONTENT, not the line count. Overstate the size and the
    // batcher drops the record as an overflow — then writes a loss notice
    // about it, which is also one line and also parses. A count would be
    // satisfied by exactly the failure this test exists to catch.
    const written = records(writer);
    expect(written).toHaveLength(1);
    expect(written[0]!.message).toMatch(/^x+/);
    expect(destination.unreportedLoss()).toEqual({ entries: 0, bytes: 0 });
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
 * The double, against the table both native adapters implement.
 *
 * Every row here is a question asked with **no live handle**, which is the
 * whole of `FileSinkLifecycle`'s no-handle contract: what a sink answers when
 * it was never opened, and what it answers once it has been closed. The two
 * differ on exactly one bit — whether files may exist — and both adapters
 * derive every answer below from it.
 *
 * This double had drifted from that table on four rows: it accepted batches on
 * a sink that was never opened, reported an unfinished collect where the
 * natives report a finished one with nothing in it, drained on a flush after
 * close, and named a `failedPath` for a deletion nobody attempted. None was
 * reachable through `FileDestination`, which short-circuits first — which is
 * exactly why they survived. A double is only worth having if it answers the
 * way the real thing answers, including on the paths today's callers guard.
 *
 * ## What these do NOT prove
 *
 * That the natives answer this way. Nothing in a Jest process can execute
 * Swift or Kotlin. These pin the double against the table as read; the paired
 * native suites pin each adapter against the same table, and until W3's
 * `FileSinkAnswers` extraction lands the adapters' own answers are reachable
 * only through the min-rn smoke jobs.
 */
describe('MemoryFileSink — the no-handle rows both adapters implement', () => {
  /** A sink that was never opened: no handle, and nothing can exist yet. */
  function neverOpened(): MemoryFileSink {
    return new MemoryWriter().attach();
  }

  /** A sink that opened, wrote, and closed: no handle, and files may exist. */
  function openedThenClosed(): MemoryFileSink {
    const sink = new MemoryWriter().attach();
    sink.open('/memory/logs/app.log', undefined, true);
    sink.appendBatch('{"m":1}\n', 1);
    sink.close(1000);
    return sink;
  }

  describe.each([
    ['never opened', neverOpened, true],
    ['opened then closed', openedThenClosed, false],
  ])('%s', (_label, make, vacuous) => {
    test('refuses a batch as closed, with a zeroed status', () => {
      const result = make().appendBatch('{"m":2}\n', 1);

      expect(result.accepted).toBe(false);
      expect(result.rejectReason).toBe('closed');
      // Zeroed, not the last status the handle had. There is no handle to ask.
      expect(result.queuedBytes).toBe(0);
      expect(result.degraded).toBe(0);
    });

    test('reports a zeroed status', () => {
      expect(make().getStatus()).toEqual({
        queuedBytes: 0,
        lostBytes: 0,
        lostEntries: 0,
        degraded: 0,
      });
    });

    test('sweeps nothing and says so', () => {
      const sink = make();
      expect(sink.maintain(1000)).toEqual({
        queuedBytes: 0,
        lostBytes: 0,
        lostEntries: 0,
        degraded: 0,
      });
      // The sweep belongs to whoever holds the writer now. It must not run.
      expect(sink.maintainCalls).toEqual([1000]);
    });

    test('has finished collecting, with nothing to collect', () => {
      const outcome = make().collectLogs(1000, 1_000_000);

      expect(outcome.path).toBe('');
      expect(outcome.byteCount).toBe(0);
      // The row that matters: `true`. A support flow that treated this as a
      // failure would show an error for an app that simply has no logs yet.
      expect(outcome.complete).toBe(true);
      expect(outcome.truncated).toBe(false);
    });

    test(`flushes without draining, durable=${vacuous}`, () => {
      const outcome = make().flush(1000);

      expect(outcome.durable).toBe(vacuous);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.pendingBytes).toBe(0);
    });

    test('closes idempotently, with the same answer', () => {
      const sink = make();
      const first = sink.close(1000);
      const second = sink.close(1000);

      expect(second).toEqual(first);
      expect(second.durable).toBe(vacuous);
    });

    test(`purges vacuously=${vacuous}, attempting nothing`, () => {
      const outcome = make().clearLogs(1000);

      expect(outcome.durable).toBe(vacuous);
      expect(outcome.deletedCount).toBe(0);
      // Nothing was attempted, so nothing failed. A path here reports a
      // deletion failure for a file no one tried to delete.
      expect(outcome.failedPaths).toEqual([]);
      // Nothing to rebind onto, whichever side of the bit this is.
      expect(outcome.rebound).toBe(false);
    });
  });

  /**
   * Closing releases a handle. It does not delete files, and the paths have to
   * keep coming back — `[]` from a closed sink tells a support-upload flow
   * there is nothing to collect over logs still sitting on the device.
   */
  test('a closed sink still lists what it left behind', () => {
    expect(openedThenClosed().getLogFilePaths()).toEqual([
      '/memory/logs/app.log',
    ]);
    expect(neverOpened().getLogFilePaths()).toEqual([]);
  });

  test('and lists archives when a test stages them', () => {
    const sink = openedThenClosed();
    sink.artifactPaths = [
      '/memory/logs/app.log',
      '/memory/logs/app.log.20260101T000000Z_abcd.gz',
    ];
    expect(sink.getLogFilePaths()).toHaveLength(2);
  });

  /**
   * A failed open forfeits vacuous success, and does not get it back.
   *
   * `acquire` creates the log directory before it opens the file, so a throw
   * is not evidence that nothing was written. A double that only set the bit
   * on success would let a half-failed open claim a durable compliance purge
   * over a directory it had just made.
   */
  test('a sink whose open threw cannot claim a vacuous purge', () => {
    const writer = new MemoryWriter();
    const first = writer.attach();
    first.open('/memory/logs/app.log', undefined, true);

    const second = writer.attach();
    // Same writer, different path: the double refuses, the way the registry
    // refuses a conflicting configuration.
    expect(() =>
      second.open('/memory/logs/other.log', undefined, true)
    ).toThrow();

    expect(second.clearLogs(1000).durable).toBe(false);
    expect(second.flush(1000).durable).toBe(false);
  });

  /**
   * The hatch, and its limits.
   *
   * The double must be able to lie the way a native across a bridge can lie —
   * a status reporting bytes queued on a sink that has none is a real thing a
   * caller has to survive. It is deliberately confined to two answers, because
   * a double that can be told what to say about its own *lifecycle* cannot
   * disagree with the caller, and disagreeing is the entire job.
   */
  test('a hostile status is merged over the computed one', () => {
    const sink = neverOpened();
    sink.hostileStatus = { queuedBytes: 4096, degraded: 0b100 };

    const status = sink.getStatus();
    expect(status.queuedBytes).toBe(4096);
    expect(status.degraded).toBe(0b100);
    // Merged, not replaced: the fields it does not name keep their real values.
    expect(status.lostEntries).toBe(0);
  });

  test('a hostile clear outcome is merged over the computed one', () => {
    const sink = openedThenClosed();
    sink.hostileClear = { durable: true, deletedCount: 99 };

    const outcome = sink.clearLogs(1000);
    expect(outcome.durable).toBe(true);
    expect(outcome.deletedCount).toBe(99);
    expect(outcome.rebound).toBe(false);
  });

  /**
   * Answers are fresh objects, not shared constants.
   *
   * The no-handle answers are built from module-level constants, and handing
   * one back unchanged would let a caller that mutates a status it was given
   * change what every later call on every sink reports. A real bridge marshals
   * a new value each time and has no such failure mode; a double that does is
   * a source of cross-test contamination that looks like a real bug.
   */
  test('a mutated status does not poison the next one', () => {
    const first = neverOpened();
    const status = first.getStatus();
    (status as { queuedBytes: number }).queuedBytes = 9999;

    expect(first.getStatus().queuedBytes).toBe(0);
    expect(neverOpened().getStatus().queuedBytes).toBe(0);
    expect(neverOpened().maintain(1000).queuedBytes).toBe(0);
  });

  /**
   * A live handle comes from `open`, and there is no other way to get one.
   *
   * Staging "this sink's handle is gone" is legitimate; staging "this sink has
   * a handle it never acquired" is a state no adapter can be in, and the point
   * of computing every answer from the state is that a test cannot script its
   * way into one.
   */
  test('a handle cannot be conjured by assignment', () => {
    const sink = neverOpened();
    expect(() => {
      sink.closed = false;
    }).toThrow(/open\(\)/);
  });

  /**
   * A purge deletes artifacts, including the archives a test staged.
   *
   * The two outcomes differ: a purge that rebound recreated the log file and
   * nothing else, and one that could not reopen left the directory empty.
   * Reporting the pre-purge list for either would have a support flow offer
   * files a compliance deletion has already removed.
   */
  test('a durable purge takes the staged archives with it', () => {
    const sink = new MemoryWriter().attach();
    sink.open('/memory/logs/app.log', undefined, true);
    sink.artifactPaths = [
      '/memory/logs/app.log',
      '/memory/logs/app.log.20260101T000000Z_abcd.gz',
    ];
    sink.appendBatch('{"m":1}\n', 1);
    sink.flush(1000);

    expect(sink.clearLogs(1000).rebound).toBe(true);
    sink.close(1000);
    expect(sink.getLogFilePaths()).toEqual(['/memory/logs/app.log']);
  });

  test('a purge that cannot reopen leaves nothing to list', () => {
    const writer = new MemoryWriter();
    const sink = writer.attach();
    sink.open('/memory/logs/app.log', undefined, true);
    sink.artifactPaths = ['/memory/logs/app.log', '/memory/logs/app.log.gz'];
    writer.reopenFails = true;

    const outcome = sink.clearLogs(1000);
    expect(outcome.durable).toBe(true);
    expect(outcome.rebound).toBe(false);

    sink.close(1000);
    expect(sink.getLogFilePaths()).toEqual([]);
  });

  /**
   * A failed deletion leaves the list alone, because the files are still there.
   */
  test('a failed purge keeps listing what it could not delete', () => {
    const writer = new MemoryWriter();
    const sink = writer.attach();
    sink.open('/memory/logs/app.log', undefined, true);
    sink.artifactPaths = ['/memory/logs/app.log', '/memory/logs/app.log.gz'];
    writer.clearFails = true;

    expect(sink.clearLogs(1000).durable).toBe(false);
    sink.close(1000);
    expect(sink.getLogFilePaths()).toHaveLength(2);
  });

  /**
   * Rotation is a forwarding pin, not an implementation, and that is on
   * purpose.
   *
   * A second rotation implementation living in a test double drifts from the
   * two real ones and produces confidence that is worse than a stated gap. So
   * the double records what it was handed and rotates nothing; size, age and
   * archive limits are pinned in the native suites, where the code that
   * implements them lives.
   */
  test('rotation config is recorded and not acted on', () => {
    const sink = new MemoryWriter().attach();
    const rotation = {
      maxFileSizeBytes: 8,
      maxArchivedFilesCount: 3,
      compressArchives: false,
    };
    sink.open('/memory/logs/app.log', rotation, true);

    sink.appendBatch('{"m":"much longer than eight bytes"}\n', 1);
    sink.flush(1000);

    expect(sink.openedRotation).toBe(rotation);
    expect(sink.getLogFilePaths()).toEqual(['/memory/logs/app.log']);
  });
});

/**
 * `reopen()` — the way back from a fence.
 *
 * A fence is permanent by design, and until 0.3.0 it was permanent in
 * practice: `purge` promised "disabled until an explicit retry" twice over and
 * there was no retry to make. These pin what the retry does and, just as
 * importantly, what it refuses to do.
 *
 * What none of them prove: that the file behind the new handle holds what the
 * old one wrote. It does not, after a purge, and that is the purge working.
 */
describe('FileDestination.reopen', () => {
  /** Fence `victim` from the outside — a second handle purges the writer out
   * from under it, exactly as a compliance deletion on another destination
   * does. The rejection arrives on the next append, so one is forced. */
  test('a handle fenced by another purge writes again after reopen', () => {
    const { destination, sink, writer } = build();
    fenceFromOutside(destination, writer.attach());
    const opensBefore = sink.openCount;

    expect(destination.reopen(1000)).toBe(true);
    expect(destination.isEnabled).toBe(true);
    expect(sink.openCount).toBe(opensBefore + 1);

    destination.write(entry({ message: 'after the retry' }));
    destination.flush(1000);
    expect(records(writer).map((r) => r.message)).toContain('after the retry');
  });

  /**
   * "The config the first one had" means the values at construction, not the
   * caller's object as it stands now.
   *
   * The caller owns what it passed and may keep mutating it. Reopening with a
   * drifted policy is not a quiet difference: the native registry compares
   * policies to decide whether two handles may share a writer, so a reopen
   * carrying a changed one is a `CONFIG_CONFLICT` against a sibling handle
   * that is still open — a recovery path that fails because of an edit made
   * somewhere else entirely.
   */
  test('the new handle is opened with the config the first one had', () => {
    const rotation = {
      maxFileSizeBytes: 4096,
      maxArchivedFilesCount: 3,
      compressArchives: true,
    };
    const { destination, sink, writer } = build({
      path: '/memory/logs/custom.log',
      rotation,
      formatter: new DefaultFormatter(),
    });
    fenceFromOutside(destination, writer.attach(), '/memory/logs/custom.log');

    // The caller edits its own object between the two opens.
    rotation.maxFileSizeBytes = 999;
    rotation.compressArchives = false;

    expect(destination.reopen(1000)).toBe(true);
    expect(sink.openedPath).toBe('/memory/logs/custom.log');
    expect(sink.openedRotation).toEqual({
      maxFileSizeBytes: 4096,
      maxArchivedFilesCount: 3,
      compressArchives: true,
    });
    // A copy, not the caller's object — which is the whole point.
    expect(sink.openedRotation).not.toBe(rotation);
    // Framing follows the formatter, and DefaultFormatter makes no guarantee.
    expect(sink.openedLineFramed).toBe(false);
  });

  test('the first open already gets the snapshot, not the caller object', () => {
    const rotation = {
      maxFileSizeBytes: 4096,
      maxArchivedFilesCount: 3,
      compressArchives: true,
    };
    const { sink } = build({ rotation });

    expect(sink.openedRotation).toEqual(rotation);
    expect(sink.openedRotation).not.toBe(rotation);
    // Frozen, so nothing downstream can edit the record of what was opened.
    expect(Object.isFrozen(sink.openedRotation)).toBe(true);
  });

  test('an unfenced destination is left completely alone', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'still buffered' }));
    const opens = sink.openCount;
    const closes = sink.closeCalls;

    expect(destination.reopen(1000)).toBe(true);
    // No close, no open: the buffer and the file position are worth more than
    // a proof that reopening would have worked.
    expect(sink.openCount).toBe(opens);
    expect(sink.closeCalls).toBe(closes);
    expect(destination.isEnabled).toBe(true);
  });

  test('a disposed destination refuses, and stays disposed', () => {
    const { destination, sink } = build();
    destination.dispose();
    const opens = sink.openCount;

    expect(destination.reopen(1000)).toBe(false);
    expect(destination.isEnabled).toBe(false);
    // Not reopened behind its owner's back: dispose is a release, not a pause.
    expect(sink.openCount).toBe(opens);
  });

  test('an open that fails leaves the destination exactly as fenced as it was', () => {
    const { destination, sink, writer } = build();
    fenceFromOutside(destination, writer.attach());

    sink.throwNextOpens = 1;
    expect(destination.reopen(1000)).toBe(false);
    expect(destination.isEnabled).toBe(false);

    // And the fence still means what it meant: records go nowhere, and the
    // retry can be made again.
    destination.write(entry({ message: 'must not appear' }));
    destination.flush(1000);
    expect(records(writer).map((r) => r.message)).not.toContain(
      'must not appear'
    );
    expect(destination.reopen(1000)).toBe(true);
  });

  test('a close that throws does not stop the reopen', () => {
    const { destination, sink, writer } = build();
    fenceFromOutside(destination, writer.attach());

    sink.throwNextCloses = 1;
    // The close is best-effort — there was nothing drainable behind a fence,
    // and the open is what decides.
    expect(destination.reopen(1000)).toBe(true);
    expect(destination.isEnabled).toBe(true);
    destination.write(entry({ message: 'through despite the close' }));
    destination.flush(1000);
    expect(records(writer).map((r) => r.message)).toContain(
      'through despite the close'
    );
  });

  /**
   * The reopened file starts clean, and this is the assertion that says so.
   *
   * Two separate decisions produce it and neither is stated as a rule here:
   * `Batcher.fence` clears the owed delta on the way in, because a notice about
   * deliberately deleted data would describe the deletion; and `write` refuses
   * while fenced, so nothing piles up behind the fence to be owed later. A
   * post-purge file opening with "4,182 entries dropped" would be a statement
   * about data someone was legally obliged to delete.
   */
  test('the reopened file does not open with a notice about the old one', () => {
    const { destination, sink, writer } = build();
    fenceFromOutside(destination, writer.attach());

    // Written while fenced: refused at the door, and not counted as a drop
    // either — the logger never routes to a destination reporting
    // `isEnabled: false`, so these can only arrive by a direct call.
    destination.write(entry({ message: 'refused while fenced' }));
    destination.write(entry({ message: 'also refused while fenced' }));

    expect(destination.reopen(1000)).toBe(true);
    destination.write(entry({ message: 'the first record of the new file' }));
    destination.flush(1000);

    const written = records(writer);
    expect(written.map((r) => r.message)).toEqual([
      'the first record of the new file',
    ]);
    // Neither the refused records nor a count of them.
    const text = JSON.stringify(written);
    expect(text).not.toContain('refused while fenced');
    expect(text).not.toContain('dropped');
    expect(sink.openCount).toBeGreaterThan(1);
  });

  test('reopen after a purge through this same handle is a no-op', () => {
    const { destination, sink } = build();
    destination.write(entry({ message: 'pre-purge' }));
    const outcome = destination.purge(1000);
    expect(outcome.rebound).toBe(true);
    const opens = sink.openCount;

    // The purge already rebound this handle — `clearLogs` does that itself,
    // and re-opening a live writer is a config conflict.
    expect(destination.reopen(1000)).toBe(true);
    expect(sink.openCount).toBe(opens);
  });

  test('reopen recovers a purge that deleted durably but could not reopen', () => {
    const { destination, sink, writer } = build();
    writer.reopenFails = true;
    const outcome = destination.purge(1000);

    // The compliance answer is still true; the destination is still dead.
    expect(outcome.durable).toBe(true);
    expect(outcome.rebound).toBe(false);
    expect(destination.isEnabled).toBe(false);

    writer.reopenFails = false;
    expect(destination.reopen(1000)).toBe(true);
    destination.write(entry({ message: 'writing again' }));
    destination.flush(1000);
    expect(records(writer).map((r) => r.message)).toContain('writing again');
    expect(sink.openCount).toBeGreaterThan(1);
  });

  test('the deadline goes to the close, which is the half that waits', () => {
    const { destination, sink, writer } = build();
    fenceFromOutside(destination, writer.attach());
    const seen: number[] = [];
    const realClose = sink.close.bind(sink);
    sink.close = (deadlineMs: number) => {
      seen.push(deadlineMs);
      return realClose(deadlineMs);
    };

    destination.reopen(250);
    expect(seen).toEqual([250]);
  });
});

/**
 * Records turned away before they are rendered.
 *
 * Formatting is the expensive half of writing a log line, and under sustained
 * backpressure every record the buffer will refuse is formatted for the
 * wastebasket. `Batcher.hasRoom()` is asked first so that work is not done.
 *
 * The cost is stated rather than hidden: a record dropped before rendering has
 * no length to report, so `LossCounts.bytes` becomes a lower bound while
 * `entries` stays exact. These pin both halves — that the render really is
 * skipped, and that the entry is still counted.
 */
describe('FileDestination — dropping before rendering', () => {
  /** A formatter that reports how often it was actually asked to work. */
  function counting(): { formatter: LogFormatter; calls: () => number } {
    const inner = new JsonLinesFormatter();
    let calls = 0;
    return {
      formatter: {
        get framing() {
          return inner.framing;
        },
        format(e: LogEntry): string {
          calls += 1;
          return inner.format(e);
        },
      },
      calls: () => calls,
    };
  }

  test('a record the full buffer will refuse is never formatted', () => {
    const { formatter, calls } = counting();
    const { destination } = build({ maxPendingEntries: 1, formatter });

    destination.write(entry({ message: 'fills the buffer' }));
    expect(calls()).toBe(1);

    destination.write(entry({ message: 'never rendered' }));
    destination.write(entry({ message: 'nor this one' }));
    expect(calls()).toBe(1);
  });

  test('the refused records are still counted, exactly', () => {
    const { destination } = build({ maxPendingEntries: 1 });

    destination.write(entry({ message: 'kept' }));
    destination.write(entry({ message: 'refused' }));
    destination.write(entry({ message: 'refused too' }));

    const loss = destination.unreportedLoss();
    expect(loss.entries).toBe(2);
    // No bytes, because producing a byte count means rendering. This is the
    // documented asymmetry, not an oversight.
    expect(loss.bytes).toBe(0);
  });

  test('the notice still reaches the file and names the right count', () => {
    const { destination, writer } = build({ maxPendingEntries: 1 });

    destination.write(entry({ message: 'kept' }));
    destination.write(entry({ message: 'refused' }));
    destination.flush(1000);

    const written = records(writer);
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({
      message: 'log entries were dropped',
      metadata: { droppedEntries: 1 },
    });
  });

  test('rendering resumes once a flush frees the buffer', () => {
    const { formatter, calls } = counting();
    const { destination, writer } = build({ maxPendingEntries: 1, formatter });

    destination.write(entry({ message: 'first' }));
    destination.write(entry({ message: 'refused' }));
    const before = calls();

    destination.flush(1000);
    destination.write(entry({ message: 'after the flush' }));

    expect(calls()).toBeGreaterThan(before);
    destination.flush(1000);
    expect(records(writer).map((r) => r.message)).toContain('after the flush');
  });

  /**
   * The byte cap exactly, which is the only place `<` and `<=` differ.
   *
   * A buffer sitting precisely on `maxPendingBytes` has room for nothing: the
   * smallest possible record still costs its own newline. Reading that as room
   * is not a lost record — `add` drops it either way — but it is the render
   * this whole change exists to skip, done at the one moment the buffer is
   * provably full. Approached at the boundary rather than near it, because
   * near it is where an off-by-one hides.
   */
  test('a buffer sitting exactly on the byte cap has room for nothing', () => {
    // The exact on-the-wire cost of the record below: its rendered bytes plus
    // the newline the batcher adds. Measured rather than guessed, so the cap
    // lands on the boundary and not one byte to either side.
    const first = entry({ message: 'exactly filling' });
    const exact = utf8Length(new JsonLinesFormatter().format(first)) + 1;

    const { formatter, calls } = counting();
    const { destination } = build({
      maxPendingEntries: 100,
      maxPendingBytes: exact,
      formatter,
    });

    destination.write(first);
    expect(calls()).toBe(1);

    // pendingBytes === maxPendingBytes now. Nothing fits, so nothing renders.
    destination.write(entry({ message: 'x' }));
    expect(calls()).toBe(1);
    expect(destination.unreportedLoss()).toEqual({ entries: 1, bytes: 0 });
  });

  /**
   * The asymmetry in `hasRoom()`'s contract, from the side that matters.
   *
   * `false` must mean *no* record fits. A byte cap with room left in it still
   * admits the record for rendering, and if it then turns out not to fit, it
   * is dropped by `add` with its bytes counted exactly. Getting this backwards
   * would silently discard records that had room, which is far worse than
   * rendering one that did not.
   */
  test('a record is still rendered when only its own size will not fit', () => {
    const { formatter, calls } = counting();
    // Room for many entries, and a byte budget the second record overruns on
    // its own. `batchBytes` is raised past the cap so nothing drains in
    // between and empties the buffer under the test.
    const { destination } = build({
      maxPendingEntries: 100,
      maxPendingBytes: 600,
      batchBytes: 4096,
      formatter,
    });

    destination.write(entry({ message: 'a'.repeat(300) }));
    const afterFirst = calls();
    expect(afterFirst).toBe(1);

    // Buffer is under its byte cap, so this is admitted, rendered, and only
    // then found not to fit.
    destination.write(entry({ message: 'b'.repeat(1000) }));
    expect(calls()).toBe(afterFirst + 1);

    const loss = destination.unreportedLoss();
    expect(loss.entries).toBe(1);
    // Rendered, so its bytes are known exactly — this is the other side of the
    // contract, and the reason `bytes` is a lower bound rather than a fiction.
    expect(loss.bytes).toBeGreaterThan(1000);
  });
});

/**
 * Which entries a formatter is actually asked to render.
 *
 * `LogFormatter.format` has never been called once per logged entry — level
 * filters and a fenced destination have always skipped it — and 0.3.0 widened
 * that by skipping records the buffer is too full to accept. A formatter that
 * carries state across calls therefore sees a sequence with holes in it.
 *
 * These pin that shape deliberately rather than leaving it to be discovered.
 * They are not an endorsement of stateful formatters; they are what makes the
 * documented requirement checkable.
 */
describe('FileDestination — what the formatter is asked to render', () => {
  /** Stamps its own call number, which is exactly what the contract forbids
   * relying on — used here as an instrument, not as a recommendation. */
  function sequencing(): { formatter: LogFormatter; seen: string[] } {
    const inner = new JsonLinesFormatter();
    const seen: string[] = [];
    return {
      formatter: {
        get framing() {
          return inner.framing;
        },
        format(e: LogEntry): string {
          seen.push(e.message);
          return inner.format(e);
        },
      },
      seen,
    };
  }

  test('a level-filtered entry never reaches the formatter', () => {
    const { formatter, seen } = sequencing();
    const { destination } = build({ minimumLevel: 'warning', formatter });
    const logger = new Logger();
    logger.removeDestination('console');
    logger.addDestination(destination);

    logger.info('below the floor');
    logger.warning('above it');

    expect(seen).toEqual(['above it']);
  });

  test('a fenced destination renders nothing, and counts nothing', () => {
    const { formatter, seen } = sequencing();
    const { destination, writer } = build({ formatter });
    const other = writer.attach();
    other.open('/memory/logs/app.log', undefined, true);
    other.clearLogs(1000);
    destination.write(entry({ message: 'trips the fence' }));
    destination.flush(1000);
    expect(destination.isEnabled).toBe(false);
    const rendered = seen.length;

    destination.write(entry({ message: 'after the fence' }));

    expect(seen).toHaveLength(rendered);
    // Refused at the door, not dropped by the buffer: nothing accepted this
    // record, so nothing owes a notice for it.
    expect(destination.unreportedLoss()).toEqual({ entries: 0, bytes: 0 });
  });

  test('an overloaded buffer skips the formatter for what it will refuse', () => {
    const { formatter, seen } = sequencing();
    const { destination } = build({ maxPendingEntries: 2, formatter });

    destination.write(entry({ message: 'one' }));
    destination.write(entry({ message: 'two' }));
    destination.write(entry({ message: 'three' }));
    destination.write(entry({ message: 'four' }));

    // The holes a stateful formatter would see, spelled out.
    expect(seen).toEqual(['one', 'two']);
    expect(destination.unreportedLoss().entries).toBe(2);
  });
});
