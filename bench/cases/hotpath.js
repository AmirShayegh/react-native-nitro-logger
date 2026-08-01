/**
 * The per-call hot path — the shapes Unit T's findings live on.
 *
 * A production logger spends most calls on the FILTERED path (an `info` under
 * a `warn` minimum costs the subsystem walk and delivers nothing), so that
 * path leads. The delivered shapes then step through the allocations T2–T8
 * name: the options object, the redaction walk, the marker probe, the
 * per-entry eligible array.
 *
 * ## Why every op here returns a literal zero
 *
 * `logger.info` is a void API: on the filtered path it returns nothing and
 * touches nothing, which is precisely the path being priced. So no return
 * value can prove the call ran, and the harness must not pretend otherwise.
 * The arrangement instead is:
 *
 *   * `op` runs the call and returns the literal `0` — byte for byte the
 *     control case's body. If an engine ever eliminated the call, what
 *     remained would BE `control.empty-loop`, and `bench/floor.js` catches
 *     it. Returning anything else (a counter read, say) would leave a
 *     residual the floor could mistake for real work.
 *   * `teardown` asserts what the case claims about delivery — filtered
 *     cases wrote nothing, delivered cases wrote something — which fails
 *     the run outright if the shape was never what the name says.
 *
 * The destinations still consume each entry rather than ignoring it, so a
 * delivered case's write is a heap effect and not a no-op.
 */
const { Logger, pub, priv } = require('../api');

/** Written by every destination and exported, keyed by label. Read only by
 * `teardown` — never inside a measured op, see the note above. */
const observed = {};
module.exports.observed = observed;

/** A destination that costs as close to nothing as a call can while still
 * consuming what it is handed. */
function noopDestination(label) {
  const key = label || 'noop';
  observed[key] = { entry: undefined, writes: 0 };
  const slot = observed[key];
  return {
    label: key,
    isEnabled: true,
    write(entry) {
      slot.entry = entry;
      slot.writes += 1;
    },
    flush() {},
    dispose() {},
  };
}

function quietLogger() {
  return new Logger().removeDestination('console');
}

/** The filtered path's claim: the burst reached no destination at all. */
function expectNoWrites(slot) {
  return function teardown() {
    if (slot.writes !== 0) {
      throw new Error(
        'filtered case delivered ' +
          slot.writes +
          ' entries; it was measuring the delivered path'
      );
    }
  };
}

/** The delivered path's claim, and the stronger one: the calls really ran.
 * An engine that eliminated them would leave this at zero. */
function expectWrites(slots) {
  return function teardown() {
    for (let i = 0; i < slots.length; i += 1) {
      if (slots[i].writes === 0) {
        throw new Error(
          'delivered case wrote nothing to destination ' +
            i +
            '; the calls did not run'
        );
      }
    }
  };
}

/**
 * How many filtered calls one filtered op makes.
 *
 * The filtered path is the cheapest thing this library does — after the
 * subsystem memo landed it is a Map hit and two integer compares, which V8
 * inlines to a few instructions. Measured one call at a time it read 0.46 ns
 * against a 0.45 ns empty-loop control, and at that point `bench/floor.js`
 * is right to refuse the number: a case sitting ON the floor is
 * indistinguishable from a case whose work was eliminated, whichever it
 * actually is.
 *
 * Sixteen calls per op restores the distance without weakening anything.
 * The DCE guard still holds — sixteen eliminated calls collapse to the
 * control exactly as one would — and the comparison the harness exists for
 * is unaffected, since both sides of a before/after run the same batch. The
 * `-x16` in these case names is there so nobody reads the number as a
 * per-call cost; divide by sixteen for that.
 */
const FILTERED_BATCH = 16;

const CATALOG = ['requestId', 'route', 'status', 'elapsedMs', 'retries'];

module.exports.cases = [
  {
    // T1's dominant case: no override anywhere on THIS chain, so the walk
    // visits every segment before falling back to the global minimum. The
    // unrelated override matters: an empty config Map short-circuits in
    // resolveSubsystemLevel before any walking, and this case exists to
    // price the walk, not the short-circuit.
    name: 'hotpath.filtered.deep-subsystem-x16',
    setup() {
      const destination = noopDestination();
      const logger = quietLogger()
        .addDestination(destination)
        .minimumLevel('warn')
        .subsystem('media', 'error');
      return {
        op() {
          for (let i = 0; i < FILTERED_BATCH; i += 1) {
            logger.info('cache warm', undefined, 'ui.checkout.payment.card');
          }
          return 0;
        },
        teardown: expectNoWrites(observed.noop),
      };
    },
  },
  {
    name: 'hotpath.filtered.no-subsystem-x16',
    setup() {
      const destination = noopDestination();
      const logger = quietLogger()
        .addDestination(destination)
        .minimumLevel('warn');
      return {
        op() {
          for (let i = 0; i < FILTERED_BATCH; i += 1) logger.info('cache warm');
          return 0;
        },
        teardown: expectNoWrites(observed.noop),
      };
    },
  },
  {
    // The walk that FINDS an override, on the delivered path (T1+T2 together
    // is what must not regress this).
    name: 'hotpath.delivered.subsystem-override',
    setup() {
      const destination = noopDestination();
      const logger = quietLogger()
        .addDestination(destination)
        .minimumLevel('warn')
        .subsystem('net', 'verbose');
      return {
        op() {
          logger.info('response', undefined, 'net.http.client');
          return 0;
        },
        teardown: expectWrites([observed.noop]),
      };
    },
  },
  {
    name: 'hotpath.delivered.bare',
    setup() {
      const destination = noopDestination();
      const logger = quietLogger().addDestination(destination);
      return {
        op() {
          logger.info('ready');
          return 0;
        },
        teardown: expectWrites([observed.noop]),
      };
    },
  },
  {
    // T4/T6: single metadata source, all keys in the catalog — the common
    // delivered-with-metadata shape.
    name: 'hotpath.delivered.metadata-5-catalog',
    setup() {
      const destination = noopDestination();
      const logger = quietLogger()
        .addDestination(destination)
        .metadataKeyCatalog(CATALOG);
      return {
        op() {
          logger.info('request finished', {
            requestId: pub('req-8842'),
            route: pub('/charts/today'),
            status: pub(200),
            elapsedMs: pub(41),
            retries: pub(0),
          });
          return 0;
        },
        teardown: expectWrites([observed.noop]),
      };
    },
  },
  {
    // T8: both marker kinds through inspectMarker.
    name: 'hotpath.delivered.markers-mixed',
    setup() {
      const destination = noopDestination();
      const logger = quietLogger().addDestination(destination);
      return {
        op() {
          logger.info('session', { device: pub('ios'), owner: priv('carol') });
          return 0;
        },
        teardown: expectWrites([observed.noop]),
      };
    },
  },
  {
    // T5's trap values: falsy survivors must cost the same as any other.
    name: 'hotpath.delivered.metadata-all-falsy',
    setup() {
      const destination = noopDestination();
      const logger = quietLogger().addDestination(destination);
      return {
        op() {
          logger.info('flags', { a: pub(0), b: pub(false), c: pub('') });
          return 0;
        },
        teardown: expectWrites([observed.noop]),
      };
    },
  },
  {
    // T2's scoped shape: two threaded objects per call today.
    name: 'hotpath.delivered.scoped-default-metadata',
    setup() {
      const destination = noopDestination();
      const logger = quietLogger().addDestination(destination);
      const scoped = logger.scoped('corr-bench', 'net.http', {
        app: pub('bench'),
      });
      return {
        op() {
          scoped.info('tick', { seq: pub(7) });
          return 0;
        },
        teardown: expectWrites([observed.noop]),
      };
    },
  },
  {
    name: 'hotpath.filtered.scoped-x16',
    setup() {
      const destination = noopDestination();
      const logger = quietLogger()
        .addDestination(destination)
        .minimumLevel('warn');
      const scoped = logger.scoped('corr-bench', 'net.http');
      return {
        op() {
          for (let i = 0; i < FILTERED_BATCH; i += 1) scoped.info('tick');
          return 0;
        },
        teardown: expectNoWrites(observed.noop),
      };
    },
  },
  {
    // T7 and the format-once fan-out: the same entry, two destinations.
    name: 'hotpath.delivered.two-destinations',
    setup() {
      const logger = quietLogger()
        .addDestination(noopDestination('first'))
        .addDestination(noopDestination('second'));
      return {
        op() {
          logger.info('ready');
          return 0;
        },
        // Both slots checked: a fan-out that quietly stopped reaching the
        // second destination would otherwise still look delivered.
        teardown: expectWrites([observed.first, observed.second]),
      };
    },
  },
];
