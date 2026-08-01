/**
 * The whole per-entry file path, measured as one number.
 *
 * `hotpath.js` prices the Logger's decision, `format.js` the rendering and
 * `batcher.js` the buffering — but a real entry pays all three plus
 * `FileDestination.renderRecord`'s limit checks in one call, and nothing
 * here measured that sum. These cases close the gap: `write(entry)` through
 * a `JsonLinesFormatter` into an accepting scripted sink is the per-record
 * cost a delivered file log actually charges the JS thread.
 *
 * The sink double answers like the batcher cases' sinks do — instantly and
 * by returning constants — so the number is the JS-side path, not I/O. The
 * `appendBatch` stub ignores its `ArrayBuffer` argument; the encode itself
 * (one `TextEncoder.encode` per BATCH, not per entry) is amortised into the
 * steady-state number exactly the way production amortises it.
 */
const { FileDestination, JsonLinesFormatter } = require('../api');

/** 2026-01-01T00:00:00.000Z — fixed, so every run formats the same instant. */
const BASE = 1767225600000;

const OK = {
  accepted: true,
  queuedBytes: 0,
  lostBytes: 0,
  lostEntries: 0,
  degraded: 0,
};
const IDLE = { queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0 };
const FLUSHED = {
  durable: true,
  timedOut: false,
  pendingBytes: 0,
  queuedBytes: 0,
  lostBytes: 0,
  lostEntries: 0,
  degraded: 0,
};

/** The full FileSinkLike surface, answering like a healthy idle writer. */
function acceptingFileSink() {
  return {
    defaultLogDirectory: '/bench/logs',
    open() {},
    appendBatch() {
      return OK;
    },
    getStatus() {
      return IDLE;
    },
    maintain() {
      return IDLE;
    },
    collectLogs() {
      return {
        path: '',
        byteCount: 0,
        sourceFileCount: 0,
        truncated: false,
        complete: false,
      };
    },
    deleteSupportBundle() {
      return false;
    },
    flush() {
      return FLUSHED;
    },
    close() {
      return FLUSHED;
    },
    getLogFilePaths() {
      return [];
    },
    clearLogs() {
      return { deletedCount: 0, failedPaths: [], durable: true, rebound: true };
    },
  };
}

function entry(overrides) {
  return Object.assign(
    { timestamp: BASE, level: 'info', message: 'request finished in 41ms' },
    overrides
  );
}

module.exports.cases = [
  {
    // The steady state a shipping app pays per delivered record: format,
    // count, limit-check, buffer — with the batch encode amortised in.
    name: 'filedest.write.minimal',
    setup() {
      const destination = new FileDestination(acceptingFileSink(), {
        formatter: new JsonLinesFormatter(),
      });
      const fixed = entry({});
      return {
        op() {
          destination.write(fixed);
          return fixed;
        },
        teardown() {
          destination.dispose();
        },
      };
    },
  },
  {
    // The realistic record: five metadata pairs, a subsystem and a
    // correlation id — the shape the T and F units benchmarked piecewise.
    name: 'filedest.write.metadata-5',
    setup() {
      const destination = new FileDestination(acceptingFileSink(), {
        formatter: new JsonLinesFormatter(),
      });
      const fixed = entry({
        subsystem: 'net.http.client',
        correlation: 'corr-bench-1',
        metadata: {
          requestId: 'req-8842',
          route: '/charts/today',
          status: 200,
          elapsedMs: 41,
          retries: 0,
        },
      });
      return {
        op() {
          destination.write(fixed);
          return fixed;
        },
        teardown() {
          destination.dispose();
        },
      };
    },
  },
];
