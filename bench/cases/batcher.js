/**
 * The buffering layer and its one expensive helper — Unit B's shapes.
 *
 * The B audit's headline was proportion, not size: the whole batcher's
 * bookkeeping is ~49 ns/entry while one `utf8Length` scan of a 163-byte
 * record is ~213 ns. So the corpora here give `utf8Length` more cases than
 * the batcher itself, including the short-ASCII and CJK shapes where the
 * proposed `search`-handover (B1) is expected to LOSE — the case list is the
 * adopt-or-decline evidence, so it has to contain the losing shapes too.
 *
 * Batcher cases run against scripted sinks, same as the unit tests: an
 * accepting sink for the steady state (every `batchBytes` worth of adds
 * drains through `loseHead`, which is B2's path), and a congested sink whose
 * queue sits above the watermark, which pauses the batcher and turns every
 * further add into the overflow drop path.
 */
const { Batcher, utf8Length } = require('../api');

/** A 163-byte record — the B audit's baseline record size. */
const RECORD_163 = (function () {
  const skeleton =
    '{"t":"2026-01-01T00:00:00.000Z","l":"info","m":"request finished ' +
    'in 41ms","md":{"requestId":"req-8842","route":"/charts/today"}}';
  return skeleton + '#'.repeat(163 - skeleton.length);
})();

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

function acceptingSink() {
  return {
    appendBatch() {
      return OK;
    },
    getStatus() {
      return IDLE;
    },
    maintain() {
      return IDLE;
    },
    flush() {
      return FLUSHED;
    },
  };
}

/** Accepts, but reports a queue far above any watermark: pauses the batcher. */
function congestedSink() {
  const gigabyte = 1073741824;
  const drowning = {
    accepted: true,
    queuedBytes: gigabyte,
    lostBytes: 0,
    lostEntries: 0,
    degraded: 0,
  };
  const status = {
    queuedBytes: gigabyte,
    lostBytes: 0,
    lostEntries: 0,
    degraded: 0,
  };
  return {
    appendBatch() {
      return drowning;
    },
    getStatus() {
      return status;
    },
    maintain() {
      return status;
    },
    flush() {
      return FLUSHED;
    },
  };
}

const NOTICE = function (lost) {
  return '[bench] dropped ' + lost.entries + ' entries';
};

module.exports.cases = [
  {
    // Steady state at defaults: ~25 adds per drain, every drain a full
    // `loseHead` splice (B2's path), amortised into the per-add number.
    name: 'batcher.add.steady-163b',
    setup() {
      const batcher = new Batcher(acceptingSink(), { renderNotice: NOTICE });
      return {
        op() {
          return batcher.add(RECORD_163);
        },
        teardown() {
          batcher.dispose();
        },
      };
    },
  },
  {
    // B5's call shape: the byte count arrives precomputed, as
    // FileDestination.renderRecord provides it.
    name: 'batcher.add.steady-163b-precounted',
    setup() {
      const batcher = new Batcher(acceptingSink(), { renderNotice: NOTICE });
      const bytes = utf8Length(RECORD_163);
      return {
        op() {
          return batcher.add(RECORD_163, bytes);
        },
        teardown() {
          batcher.dispose();
        },
      };
    },
  },
  {
    // Saturated overflow: the sink's queue never comes down, the buffer is
    // pinned at its byte ceiling, and every add is a drop with loss
    // accounting (B3's snapshot allocations live here).
    name: 'batcher.add.saturated-drop',
    setup() {
      const batcher = new Batcher(congestedSink(), {
        renderNotice: NOTICE,
        maxPendingBytes: 8 * 1024,
        watermarkBytes: 1024,
      });
      // Saturate before measuring: fill until adds are pure drops.
      for (let i = 0; i < 128; i += 1) batcher.add(RECORD_163);
      return {
        op() {
          return batcher.add(RECORD_163);
        },
        teardown() {
          batcher.dispose();
        },
      };
    },
  },
  {
    // B4's catch-up shape: a large buffered backlog joined and pushed in one
    // flush. Heavier per op by construction; the calibrator just runs fewer.
    name: 'batcher.flush.catchup-256kb',
    setup() {
      const sink = acceptingSink();
      const batcher = new Batcher(sink, {
        renderNotice: NOTICE,
        // A batch budget above the backlog so the whole thing joins at once.
        batchBytes: 512 * 1024,
        maxPendingBytes: 1024 * 1024,
        maxPendingEntries: 4096,
        maxBatchBytes: 512 * 1024,
      });
      const perBatch = Math.ceil((256 * 1024) / (RECORD_163.length + 1));
      return {
        op() {
          for (let i = 0; i < perBatch; i += 1) batcher.add(RECORD_163);
          return batcher.flush(1000);
        },
        teardown() {
          batcher.dispose();
        },
      };
    },
  },

  // ── utf8Length corpora (B1's adopt-or-decline evidence) ────────────────
  {
    name: 'utf8.ascii-163b',
    setup() {
      return {
        op() {
          return utf8Length(RECORD_163);
        },
      };
    },
  },
  {
    // The crossover regression zone: engine-primitive handover is expected
    // to lose to the plain loop here. Keep losing shapes in the evidence.
    name: 'utf8.ascii-16b',
    setup() {
      const short = 'request finished';
      return {
        op() {
          return utf8Length(short);
        },
      };
    },
  },
  {
    name: 'utf8.ascii-3.3kb',
    setup() {
      const big = RECORD_163.repeat(21);
      return {
        op() {
          return utf8Length(big);
        },
      };
    },
  },
  {
    name: 'utf8.stack-trace-2kb',
    setup() {
      const trace =
        'Error: request failed\n' +
        '    at fetchChart (/app/node_modules/charts/index.js:123:45)\n'.repeat(
          32
        );
      return {
        op() {
          return utf8Length(trace);
        },
      };
    },
  },
  {
    // All multi-byte from the first unit: the handover fires immediately and
    // buys nothing — the other losing shape.
    name: 'utf8.cjk-300b',
    setup() {
      const cjk = '診療記録の同期が完了しました'.repeat(8);
      return {
        op() {
          return utf8Length(cjk);
        },
      };
    },
  },
  {
    name: 'utf8.emoji-mixed-1kb',
    setup() {
      const mixed = 'sync ok 👍 latency 41ms 🚑 retry 0 '.repeat(28);
      return {
        op() {
          return utf8Length(mixed);
        },
      };
    },
  },
];
