/**
 * The per-call hot path — the shapes Unit T's findings live on.
 *
 * A production logger spends most calls on the FILTERED path (an `info` under
 * a `warn` minimum costs the subsystem walk and delivers nothing), so that
 * path leads. The delivered shapes then step through the allocations T2–T8
 * name: the options object, the redaction walk, the marker probe, the
 * per-entry eligible array.
 *
 * Every case runs against a no-op destination. The point is the logger's own
 * bookkeeping; a real destination would drown it in I/O.
 */
const { Logger, pub, priv } = require('../api');

/** A destination that costs as close to nothing as a call can. */
function noopDestination(label) {
  return {
    label: label || 'noop',
    isEnabled: true,
    write() {},
    flush() {},
    dispose() {},
  };
}

function quietLogger() {
  return new Logger().removeDestination('console');
}

const CATALOG = ['requestId', 'route', 'status', 'elapsedMs', 'retries'];

module.exports.cases = [
  {
    // T1's dominant case: no override anywhere on THIS chain, so the walk
    // visits every segment before falling back to the global minimum. The
    // unrelated override matters: an empty config Map short-circuits in
    // resolveSubsystemLevel before any walking, and this case exists to
    // price the walk, not the short-circuit.
    name: 'hotpath.filtered.deep-subsystem',
    setup() {
      const logger = quietLogger()
        .addDestination(noopDestination())
        .minimumLevel('warn')
        .subsystem('media', 'error');
      return {
        op() {
          logger.info('cache warm', undefined, 'ui.checkout.payment.card');
        },
      };
    },
  },
  {
    name: 'hotpath.filtered.no-subsystem',
    setup() {
      const logger = quietLogger()
        .addDestination(noopDestination())
        .minimumLevel('warn');
      return {
        op() {
          logger.info('cache warm');
        },
      };
    },
  },
  {
    // The walk that FINDS an override, on the delivered path (T1+T2 together
    // is what must not regress this).
    name: 'hotpath.delivered.subsystem-override',
    setup() {
      const logger = quietLogger()
        .addDestination(noopDestination())
        .minimumLevel('warn')
        .subsystem('net', 'verbose');
      return {
        op() {
          logger.info('response', undefined, 'net.http.client');
        },
      };
    },
  },
  {
    name: 'hotpath.delivered.bare',
    setup() {
      const logger = quietLogger().addDestination(noopDestination());
      return {
        op() {
          logger.info('ready');
        },
      };
    },
  },
  {
    // T4/T6: single metadata source, all keys in the catalog — the common
    // delivered-with-metadata shape.
    name: 'hotpath.delivered.metadata-5-catalog',
    setup() {
      const logger = quietLogger()
        .addDestination(noopDestination())
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
        },
      };
    },
  },
  {
    // T8: both marker kinds through inspectMarker.
    name: 'hotpath.delivered.markers-mixed',
    setup() {
      const logger = quietLogger().addDestination(noopDestination());
      return {
        op() {
          logger.info('session', { device: pub('ios'), owner: priv('carol') });
        },
      };
    },
  },
  {
    // T5's trap values: falsy survivors must cost the same as any other.
    name: 'hotpath.delivered.metadata-all-falsy',
    setup() {
      const logger = quietLogger().addDestination(noopDestination());
      return {
        op() {
          logger.info('flags', { a: pub(0), b: pub(false), c: pub('') });
        },
      };
    },
  },
  {
    // T2's scoped shape: two threaded objects per call today.
    name: 'hotpath.delivered.scoped-default-metadata',
    setup() {
      const logger = quietLogger().addDestination(noopDestination());
      const scoped = logger.scoped('corr-bench', 'net.http', {
        app: pub('bench'),
      });
      return {
        op() {
          scoped.info('tick', { seq: pub(7) });
        },
      };
    },
  },
  {
    name: 'hotpath.filtered.scoped',
    setup() {
      const logger = quietLogger()
        .addDestination(noopDestination())
        .minimumLevel('warn');
      const scoped = logger.scoped('corr-bench', 'net.http');
      return {
        op() {
          scoped.info('tick');
        },
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
        },
      };
    },
  },
];
