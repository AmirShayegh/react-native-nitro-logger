import rows from '../spec/file-sink-lifecycle.rows.json';
import { MemoryWriter } from './helpers/MemoryFileSink';
import type { MemoryFileSink } from './helpers/MemoryFileSink';

/**
 * `MemoryFileSink` against the shared no-handle table.
 *
 * The table lives in `spec/file-sink-lifecycle.rows.json` and is read by three
 * suites: this one, `FileSinkLifecycleRowsTests.swift`, and
 * `FileSinkLifecycleRowsTest.kt`. Its header explains why the answers live in
 * one file rather than in three hand-written suites that drifted apart.
 *
 * Replaces `describe('MemoryFileSink — the no-handle rows both adapters
 * implement')`, which asserted the same answers by hand and could therefore
 * agree with a table nobody else was reading.
 *
 * ## What this file does NOT prove
 *
 * That the natives answer this way. Nothing in a Jest process can execute
 * Swift or Kotlin. It proves the double answers the way the table says, which
 * matters because the double is what every `FileDestination` test runs
 * against: a double that answers differently from the shipped adapters makes
 * every one of those tests a statement about nothing.
 */

/**
 * The field set each spec type actually has, pinned.
 *
 * Every dispatcher below builds a *projection* of its result, so on its own the
 * row comparison proves only that the table and the projection agree. A field
 * added to `SinkStatus` or `FlushOutcome` would be dropped before the
 * comparison and go on being unasserted by the table indefinitely — in a
 * release that is itself adding a method to this spec. Pinning the raw keys
 * makes that a failure here, which is the one suite whose job is that these
 * answers are complete.
 *
 * `deleteSupportBundle` and `getLogFilePaths` are absent because their results
 * are a boolean and an array: there are no keys to pin, and their single row
 * field is a derived count rather than a projection.
 */
const RAW_KEYS: Record<string, readonly string[]> = {
  appendBatch: [
    'accepted',
    'degraded',
    'lostBytes',
    'lostEntries',
    'queuedBytes',
    'rejectReason',
  ],
  getStatus: ['degraded', 'lostBytes', 'lostEntries', 'queuedBytes'],
  maintain: ['degraded', 'lostBytes', 'lostEntries', 'queuedBytes'],
  collectLogs: [
    'byteCount',
    'complete',
    'path',
    'sourceFileCount',
    'truncated',
  ],
  flush: [
    'degraded',
    'durable',
    'lostBytes',
    'lostEntries',
    'pendingBytes',
    'queuedBytes',
    'timedOut',
  ],
  close: [
    'degraded',
    'durable',
    'lostBytes',
    'lostEntries',
    'pendingBytes',
    'queuedBytes',
    'timedOut',
  ],
  clearLogs: ['deletedCount', 'durable', 'failedPaths', 'rebound'],
};

/** Fails if the result grew or lost a field, before it is projected away. */
function pin<T extends object>(op: string, raw: T): T {
  const expected = RAW_KEYS[op];
  if (expected) {
    expect(Object.keys(raw).sort()).toEqual([...expected].sort());
  }
  return raw;
}

const DISPATCH: Record<
  string,
  (sink: MemoryFileSink) => Record<string, string>
> = {
  appendBatch: (sink) => {
    const r = pin('appendBatch', sink.appendBatch('{"m":2}\n', 1));
    return {
      accepted: String(r.accepted),
      // `??` and not `||`: an implementation that answered `''` here would be
      // reporting "refused, and I decline to say why", which is not the row.
      rejectReason: String(r.rejectReason ?? '<absent>'),
      queuedBytes: String(r.queuedBytes),
      lostBytes: String(r.lostBytes),
      lostEntries: String(r.lostEntries),
      degraded: String(r.degraded),
    };
  },
  getStatus: (sink) => status(pin('getStatus', sink.getStatus())),
  maintain: (sink) => {
    const answer = status(pin('maintain', sink.maintain(1000)));
    // The sweep must not run. Asserted here rather than in the table because
    // it is a fact about the *call*, not about the answer, and the table's
    // shape is answer fields only.
    expect(sink.maintainCalls).toEqual([1000]);
    return answer;
  },
  collectLogs: (sink) => {
    const o = pin('collectLogs', sink.collectLogs(1000, 1_000_000));
    return {
      path: o.path,
      byteCount: String(o.byteCount),
      sourceFileCount: String(o.sourceFileCount),
      complete: String(o.complete),
      truncated: String(o.truncated),
    };
  },
  flush: (sink) => flush(pin('flush', sink.flush(1000))),
  close: (sink) => {
    const first = sink.close(1000);
    const second = sink.close(1000);
    // Idempotence is a relation between two calls, so it cannot be a row.
    // The table pins what the answer *is*; this pins that asking twice does
    // not change it.
    expect(second).toEqual(first);
    return flush(pin('close', second));
  },
  clearLogs: (sink) => {
    const o = pin('clearLogs', sink.clearLogs(1000));
    return {
      deletedCount: String(o.deletedCount),
      failedPathCount: String(o.failedPaths.length),
      durable: String(o.durable),
      rebound: String(o.rebound),
    };
  },
  deleteSupportBundle: (sink) => ({
    deleted: String(sink.deleteSupportBundle(1000)),
  }),
  getLogFilePaths: (sink) => ({
    pathCount: String(sink.getLogFilePaths().length),
  }),
};

function status(s: {
  queuedBytes: number;
  lostBytes: number;
  lostEntries: number;
  degraded: number;
}): Record<string, string> {
  return {
    queuedBytes: String(s.queuedBytes),
    lostBytes: String(s.lostBytes),
    lostEntries: String(s.lostEntries),
    degraded: String(s.degraded),
  };
}

function flush(o: {
  durable: boolean;
  timedOut: boolean;
  pendingBytes: number;
  queuedBytes: number;
  lostBytes: number;
  lostEntries: number;
  degraded: number;
}): Record<string, string> {
  return {
    durable: String(o.durable),
    timedOut: String(o.timedOut),
    pendingBytes: String(o.pendingBytes),
    ...status(o),
  };
}

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

const MAKE: Record<string, () => MemoryFileSink> = {
  neverOpened,
  openedThenClosed,
};

/**
 * The guards, which are the reason this file is worth more than the hand-
 * written suite it replaces.
 *
 * A shared table is only shared if every consumer is forced to keep up with
 * it. Each assertion below turns a way of quietly falling behind into a
 * failure: a row nobody dispatches, a mode nobody builds, a field the table
 * does not name, a table that shrank. Without them a new row would pass here
 * by being ignored, and "add a row and watch three suites go red" would be a
 * claim about a thing that does not happen.
 *
 * The floor is pinned rather than derived. `rows.length >= rows.length` is
 * the shape of gate this repository has already shipped twice by accident.
 */
const PINNED_ROW_FLOOR = 9;
const PINNED_MODES = ['neverOpened', 'openedThenClosed'];

describe('the shared no-handle table — guards', () => {
  test('has at least the rows it had when this floor was pinned', () => {
    expect(rows.rows.length).toBeGreaterThanOrEqual(PINNED_ROW_FLOOR);
  });

  test('declares exactly the modes this suite can build', () => {
    expect(rows.modes).toEqual(PINNED_MODES);
    expect(Object.keys(MAKE).sort()).toEqual([...PINNED_MODES].sort());
  });

  test('every row names an op this suite dispatches', () => {
    // A failure, never a skip. A skip here is how a row gets added to the
    // table, ignored by one target, and believed by everyone reading the file.
    const unknown = rows.rows
      .map((r) => r.op)
      .filter((op) => !(op in DISPATCH));
    expect(unknown).toEqual([]);
  });

  test('every op this suite dispatches has a row', () => {
    const covered = new Set(rows.rows.map((r) => r.op));
    expect(Object.keys(DISPATCH).filter((op) => !covered.has(op))).toEqual([]);
  });

  test('no op is listed twice', () => {
    // Without this the headline claim — add a row, watch three suites go red —
    // has a hole in it: a tenth row duplicating an existing op and its answers
    // dispatches the same code a second time and passes everywhere. The row
    // count would even rise, satisfying every floor.
    const ops = rows.rows.map((r) => r.op);
    const duplicated = ops.filter((op, i) => ops.indexOf(op) !== i);
    expect(duplicated).toEqual([]);
  });

  test('every row answers for every declared mode', () => {
    for (const row of rows.rows) {
      const entry = row as unknown as Record<string, unknown>;
      for (const mode of rows.modes) {
        expect(typeof entry[mode]).toBe('object');
      }
    }
  });

  test('every row explains itself', () => {
    // Not decoration. The answers here are not derivable from the type
    // signatures — `complete: true` over an empty collect and `durable: true`
    // over a sink that never opened both read as bugs until you know why.
    for (const row of rows.rows) {
      expect(row.why.length).toBeGreaterThan(40);
    }
  });
});

describe.each(PINNED_MODES)('MemoryFileSink — %s', (mode) => {
  const make = MAKE[mode]!;

  test.each(rows.rows.map((r) => [r.op, r] as const))('%s', (op, row) => {
    const expected = (row as unknown as Record<string, Record<string, string>>)[
      mode
    ]!;
    const actual = DISPATCH[op]!(make());

    // Field-for-field in both directions, between the TABLE and the DISPATCHER:
    // a field the table names that the dispatcher does not produce fails, and
    // so does the reverse. It is deliberately not a claim about the sink's own
    // type growing a field — the dispatcher projects, so an extra field would
    // be discarded before it got here. `RAW_KEYS` is what covers that.
    expect(actual).toEqual(expected);
  });
});
