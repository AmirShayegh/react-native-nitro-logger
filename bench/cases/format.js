/**
 * The formatters — the shapes Unit F's findings live on.
 *
 * Timestamps are fixed constants, never the wall clock: a case whose input
 * drifts between commits is comparing two different workloads. The
 * same-second case cycles milliseconds inside ONE second because that is the
 * exact hit pattern the whole-second memo (F1/F3) exists for; the
 * spread-seconds case is its miss-path control.
 *
 * Byte parity is not this file's concern — the golden suite owns it. These
 * cases only ask how long the identical bytes take.
 */
const { JsonLinesFormatter, DefaultFormatter } = require('../api');

/** 2026-01-01T00:00:00.000Z — a constant so every run formats the same instants. */
const BASE = 1767225600000;

function entry(overrides) {
  return Object.assign(
    { timestamp: BASE, level: 'info', message: 'ready' },
    overrides
  );
}

function wideMetadata(keys) {
  const metadata = {};
  for (let i = 0; i < keys; i += 1) {
    metadata['key' + ('' + i).padStart(2, '0')] = 'value-' + i;
  }
  return metadata;
}

module.exports.cases = [
  {
    name: 'format.jsonlines.minimal',
    setup() {
      const formatter = new JsonLinesFormatter();
      const fixed = entry({});
      return {
        op() {
          return formatter.format(fixed);
        },
      };
    },
  },
  {
    name: 'format.jsonlines.metadata-5',
    setup() {
      const formatter = new JsonLinesFormatter();
      const fixed = entry({
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
          return formatter.format(fixed);
        },
      };
    },
  },
  {
    name: 'format.jsonlines.subsystem-correlation',
    setup() {
      const formatter = new JsonLinesFormatter();
      const fixed = entry({
        subsystem: 'net.http.client',
        correlation: 'corr-bench-1',
      });
      return {
        op() {
          return formatter.format(fixed);
        },
      };
    },
  },
  {
    // F1's hit pattern: a burst inside one wall-clock second.
    name: 'format.jsonlines.same-second-burst',
    setup() {
      const formatter = new JsonLinesFormatter();
      let i = 0;
      return {
        op() {
          i = (i + 1) % 1000;
          return formatter.format(entry({ timestamp: BASE + i }));
        },
      };
    },
  },
  {
    // The miss-path control for the case above: every call a new second.
    name: 'format.jsonlines.spread-seconds',
    setup() {
      const formatter = new JsonLinesFormatter();
      let i = 0;
      return {
        op() {
          i = (i + 1) % 3600;
          return formatter.format(entry({ timestamp: BASE + i * 1000 }));
        },
      };
    },
  },
  {
    // F2's shape: a wide entry shed to a tight budget — what a crash-handler
    // stack entry meets.
    name: 'format.jsonlines.formatWithin-40-keys-400b',
    setup() {
      const formatter = new JsonLinesFormatter();
      const fixed = entry({ metadata: wideMetadata(40) });
      return {
        op() {
          return formatter.formatWithin(fixed, 400);
        },
      };
    },
  },
  {
    // F2's other half: the message itself is what must shrink.
    name: 'format.jsonlines.formatWithin-long-message',
    setup() {
      const formatter = new JsonLinesFormatter();
      const fixed = entry({ message: 'x'.repeat(4096) });
      return {
        op() {
          return formatter.formatWithin(fixed, 512);
        },
      };
    },
  },
  {
    // F5's fast path: nothing to escape, the identity case.
    name: 'format.default.clean-message',
    setup() {
      const formatter = new DefaultFormatter();
      const fixed = entry({});
      return {
        op() {
          return formatter.format(fixed);
        },
      };
    },
  },
  {
    name: 'format.default.escaped-message',
    setup() {
      const formatter = new DefaultFormatter();
      const fixed = entry({ message: 'line one\nline two | tail' });
      return {
        op() {
          return formatter.format(fixed);
        },
      };
    },
  },
  {
    // F3+F6: the console entry with a handful of pairs.
    name: 'format.default.metadata-4',
    setup() {
      const formatter = new DefaultFormatter();
      const fixed = entry({
        metadata: { route: '/x', status: 200, ms: 12, ok: true },
      });
      return {
        op() {
          return formatter.format(fixed);
        },
      };
    },
  },
];
