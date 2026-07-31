import { Logger } from '../src/Logger';
import {
  __resetRejectionHandlers,
  installRejectionHandler,
  REJECTION_HANDLED_LATE_MESSAGE,
  REJECTION_METADATA_KEYS,
  UNHANDLED_REJECTION_MESSAGE,
} from '../src/integrations/rejectionHandler';
import type {
  RejectionTrackingLike,
  RejectionTrackingOptions,
} from '../src/integrations/rejectionHandler';
import {
  NON_ERROR_THROWN,
  REDACTED_MESSAGE,
} from '../src/integrations/sanitizeError';
import type { LogDestination } from '../src/destinations/types';
import type { LogEntry } from '../src/types';

declare const globalThis: {
  __DEV__?: boolean;
  HermesInternal?: unknown;
};

const SENTINEL = 'MRN-4417293';

/** Captures entries and counts flushes, so both halves are observable. */
class RecordingDestination implements LogDestination {
  readonly label = 'recording';
  readonly isEnabled = true;
  readonly entries: LogEntry[] = [];
  flushes = 0;

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }

  flush(): void {
    this.flushes += 1;
  }

  dispose(): void {}
}

/**
 * A stand-in for Hermes' tracker and for React Native's polyfill, which are the
 * same call.
 *
 * Keeps the last options it was enabled with, because "the last one wins" is
 * the property that makes chaining necessary and is worth asserting directly.
 */
class FakeTracking implements RejectionTrackingLike {
  enabledWith: RejectionTrackingOptions[] = [];
  throwOnEnable = false;

  enable(options: RejectionTrackingOptions): void {
    if (this.throwOnEnable) throw new Error('no tracker here');
    this.enabledWith.push(options);
  }

  private get current(): RejectionTrackingOptions | undefined {
    return this.enabledWith[this.enabledWith.length - 1];
  }

  reject(id: number, reason: unknown): void {
    this.current?.onUnhandled?.(id, reason);
  }

  handleLate(id: number, reason: unknown): void {
    this.current?.onHandled?.(id, reason);
  }
}

function wired() {
  const logger = new Logger();
  const destination = new RecordingDestination();
  logger.removeDestination('console').addDestination(destination);
  const tracking = new FakeTracking();
  return { logger, destination, tracking };
}

beforeEach(() => {
  // The chain is module state — there is nothing to read it back from — so a
  // handler left installed by one test would be chained to by the next.
  __resetRejectionHandlers();
});

describe('installRejectionHandler', () => {
  test('logs an unhandled rejection at error level', () => {
    const { logger, destination, tracking } = wired();
    installRejectionHandler({ logger, tracking });

    tracking.reject(1, new TypeError('x'));

    expect(destination.entries).toHaveLength(1);
    const entry = destination.entries[0]!;
    expect(entry.level).toBe('error');
    expect(entry.message).toBe(UNHANDLED_REJECTION_MESSAGE);
  });

  // The difference from the crash handler, and a deliberate one: nothing is
  // dying, the JS thread keeps running, and a flush per rejection would turn a
  // loop of failing requests into a loop of synchronous disk writes.
  test('does not flush', () => {
    const { logger, destination, tracking } = wired();
    installRejectionHandler({ logger, tracking });

    tracking.reject(1, new Error('boom'));
    tracking.reject(2, new Error('boom again'));

    expect(destination.flushes).toBe(0);
  });

  test('tracks rejections whose reason is not an Error', () => {
    const { logger, tracking } = wired();
    installRejectionHandler({ logger, tracking });

    // Not offered as an option. A rejection with a string reason is exactly
    // the one whose text nobody vetted, so leaving it untracked would mean the
    // sanitizer never sees it.
    expect(tracking.enabledWith[0]!.allRejections).toBe(true);
  });

  test('nothing from the rejection reason reaches the entry', () => {
    const { logger, destination, tracking } = wired();
    installRejectionHandler({ logger, tracking });

    class PatientNotFoundError extends Error {}
    const reason = new PatientNotFoundError(`no chart for ${SENTINEL}`);
    reason.name = 'PatientNotFoundError';
    tracking.reject(7, reason);

    const rendered = JSON.stringify(destination.entries[0]!);
    expect(rendered).not.toContain(SENTINEL);
    expect(rendered).not.toContain('PatientNotFound');
    expect(rendered).toContain(REDACTED_MESSAGE);
  });

  // `Promise.reject(\`no chart for ${mrn}\`)` is the case that matters: the
  // string is the reason, so a handler that reported it as the message would
  // put caller data straight into the log.
  test('a rejected string is reported as a non-error', () => {
    const { logger, destination, tracking } = wired();
    installRejectionHandler({ logger, tracking });

    tracking.reject(3, `no chart for ${SENTINEL}`);

    const entry = destination.entries[0]!;
    expect(entry.metadata).toMatchObject({ errorName: NON_ERROR_THROWN });
    expect(JSON.stringify(entry)).not.toContain(SENTINEL);
  });

  test('a reason whose getters throw does not take the handler down', () => {
    const { logger, destination, tracking } = wired();
    installRejectionHandler({ logger, tracking });

    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(SENTINEL);
        },
        getPrototypeOf() {
          throw new Error(SENTINEL);
        },
      }
    );

    expect(() => tracking.reject(4, hostile)).not.toThrow();
    expect(destination.entries).toHaveLength(1);
    expect(JSON.stringify(destination.entries[0]!)).not.toContain(SENTINEL);
  });

  test('a logger that throws does not escape into the tracker', () => {
    const { tracking } = wired();
    const logger = new Logger();
    logger.removeDestination('console').addDestination({
      label: 'hostile',
      isEnabled: true,
      write(): void {
        throw new Error('destination is broken');
      },
      flush(): void {},
      dispose(): void {},
    });
    installRejectionHandler({ logger, tracking });

    // A throw here would be reported as another unhandled rejection, which
    // arrives back at this same handler.
    expect(() => tracking.reject(5, new Error('x'))).not.toThrow();
  });

  test('tags the entry with the subsystem it was given', () => {
    const { logger, destination, tracking } = wired();
    installRejectionHandler({ logger, tracking, subsystem: 'crash' });

    tracking.reject(1, new Error('x'));

    expect(destination.entries[0]!.subsystem).toBe('crash');
  });

  describe('a rejection handled after it was reported', () => {
    test('is logged, at info, under the same rejection id', () => {
      const { logger, destination, tracking } = wired();
      installRejectionHandler({ logger, tracking });

      tracking.reject(11, new Error('x'));
      tracking.handleLate(11, new Error('x'));

      expect(destination.entries).toHaveLength(2);
      const late = destination.entries[1]!;
      expect(late.level).toBe('info');
      expect(late.message).toBe(REJECTION_HANDLED_LATE_MESSAGE);
      // The join key. Without it the log says a failure went unhandled and
      // never takes it back — a tracker decides "unhandled" on a timer, so a
      // `.catch()` one turn late produces exactly this pair.
      expect(late.metadata).toMatchObject({ rejectionId: 11 });
      expect(destination.entries[0]!.metadata).toMatchObject({
        rejectionId: 11,
      });
    });

    // The gap between the two callbacks is a real gap — one tracker timeout —
    // and an entry retracting a rejection this log never reported is worse than
    // no entry: it takes back something nobody said.
    test('is not logged by a handler that never reported it', () => {
      const { logger, destination, tracking } = wired();

      // Installed *between* the two callbacks, which is all it takes.
      tracking.reject(21, new Error('x'));
      installRejectionHandler({ logger, tracking });
      tracking.handleLate(21, new Error('x'));

      expect(destination.entries).toHaveLength(0);
    });

    test('is not logged when the report itself failed', () => {
      const { tracking } = wired();
      // Only the report fails. A destination that throws is isolated by the
      // logger, so making the *logger* fail is the only way to reach this — and
      // without the guard the retraction would go out on its own, naming a
      // rejection the log never mentions.
      class HalfBrokenLogger extends Logger {
        override error(): void {
          throw new Error('logger is broken');
        }
      }
      const logger = new HalfBrokenLogger();
      const destination = new RecordingDestination();
      logger.removeDestination('console').addDestination(destination);
      installRejectionHandler({ logger, tracking });

      tracking.reject(22, new Error('x'));
      tracking.handleLate(22, new Error('x'));

      expect(destination.entries).toHaveLength(0);
    });

    test('a handler that did not report it still forwards to one that did', () => {
      const { logger, destination, tracking } = wired();
      const outer = new Logger();
      const outerDestination = new RecordingDestination();
      outer.removeDestination('console').addDestination(outerDestination);

      // The inner handler reports on its own — the outer one is not installed
      // yet and never sees the rejection.
      installRejectionHandler({ logger, tracking });
      tracking.reject(23, new Error('x'));
      installRejectionHandler({ logger: outer, tracking });
      tracking.handleLate(23, new Error('x'));

      // The one that reported takes it back; the one that did not stays quiet.
      expect(outerDestination.entries).toHaveLength(0);
      expect(destination.entries.map((entry) => entry.message)).toEqual([
        UNHANDLED_REJECTION_MESSAGE,
        REJECTION_HANDLED_LATE_MESSAGE,
      ]);
    });

    // Bounded, because nothing collects the id of a rejection that is never
    // handled. The failure direction is a missing retraction, never a false one.
    test('is dropped once too many other rejections have been reported', () => {
      const { logger, destination, tracking } = wired();
      installRejectionHandler({ logger, tracking });

      tracking.reject(0, new Error('first'));
      for (let id = 1; id <= 256; id += 1) {
        tracking.reject(id, new Error('filler'));
      }
      const before = destination.entries.length;

      tracking.handleLate(0, new Error('first'));
      expect(destination.entries).toHaveLength(before);

      // The most recent one is still remembered, so this is a bound and not a
      // handler that quietly stopped working.
      tracking.handleLate(256, new Error('filler'));
      expect(destination.entries).toHaveLength(before + 1);
    });

    /**
     * Where the bound actually is, rather than that there is one somewhere.
     *
     * The test above overshoots by design and would pass just as happily
     * against a ring of eight: the oldest id is evicted either way. What it
     * cannot see is the limit shrinking — and a ring that quietly got smaller
     * would drop retractions for rejections handled a moment later, which is
     * the case this feature exists for.
     */
    test('the ring holds exactly 256, checked on both sides', () => {
      const atCapacity = wired();
      installRejectionHandler({
        logger: atCapacity.logger,
        tracking: atCapacity.tracking,
      });
      atCapacity.tracking.reject(0, new Error('first'));
      // 255 more, so 256 are remembered and the first is the oldest of them.
      for (let id = 1; id <= 255; id += 1) {
        atCapacity.tracking.reject(id, new Error('filler'));
      }
      let before = atCapacity.destination.entries.length;
      atCapacity.tracking.handleLate(0, new Error('first'));
      expect(atCapacity.destination.entries).toHaveLength(before + 1);

      // One more, and the first is pushed out.
      const overCapacity = wired();
      installRejectionHandler({
        logger: overCapacity.logger,
        tracking: overCapacity.tracking,
      });
      overCapacity.tracking.reject(0, new Error('first'));
      for (let id = 1; id <= 256; id += 1) {
        overCapacity.tracking.reject(id, new Error('filler'));
      }
      before = overCapacity.destination.entries.length;
      overCapacity.tracking.handleLate(0, new Error('first'));
      expect(overCapacity.destination.entries).toHaveLength(before);
    });

    test('can be turned off without turning off the report', () => {
      const { logger, destination, tracking } = wired();
      installRejectionHandler({ logger, tracking, logHandledLate: false });

      tracking.reject(12, new Error('x'));
      tracking.handleLate(12, new Error('x'));

      expect(destination.entries).toHaveLength(1);
      expect(destination.entries[0]!.message).toBe(UNHANDLED_REJECTION_MESSAGE);
    });
  });

  describe('chaining', () => {
    test('a second install reaches the first', () => {
      const { logger, destination, tracking } = wired();
      const second = new RecordingDestination();
      const other = new Logger();
      other.removeDestination('console').addDestination(second);

      installRejectionHandler({ logger, tracking });
      installRejectionHandler({ logger: other, tracking });

      tracking.reject(1, new Error('x'));

      expect(second.entries).toHaveLength(1);
      expect(destination.entries).toHaveLength(1);
    });

    test('and stops when asked not to', () => {
      const { logger, destination, tracking } = wired();
      const other = new Logger();
      const second = new RecordingDestination();
      other.removeDestination('console').addDestination(second);

      installRejectionHandler({ logger, tracking });
      installRejectionHandler({ logger: other, tracking, chain: false });

      tracking.reject(1, new Error('x'));

      expect(second.entries).toHaveLength(1);
      expect(destination.entries).toHaveLength(0);
    });

    test('an uninstalled handler in the middle is stepped over', () => {
      const { logger, destination, tracking } = wired();
      const middle = new Logger();
      const middleDestination = new RecordingDestination();
      middle.removeDestination('console').addDestination(middleDestination);
      const outer = new Logger();
      const outerDestination = new RecordingDestination();
      outer.removeDestination('console').addDestination(outerDestination);

      installRejectionHandler({ logger, tracking });
      const uninstallMiddle = installRejectionHandler({
        logger: middle,
        tracking,
      });
      installRejectionHandler({ logger: outer, tracking });

      uninstallMiddle();
      tracking.reject(1, new Error('x'));

      expect(outerDestination.entries).toHaveLength(1);
      expect(middleDestination.entries).toHaveLength(0);
      // Stepped over rather than stopped at: an uninstall in the middle must
      // not silently take everything behind it out of the chain.
      expect(destination.entries).toHaveLength(1);
    });
  });

  describe('uninstall', () => {
    test('stops logging without disabling the tracker', () => {
      const { logger, destination, tracking } = wired();
      const uninstall = installRejectionHandler({ logger, tracking });

      uninstall();
      tracking.reject(1, new Error('x'));

      expect(destination.entries).toHaveLength(0);
      // Exactly one `enable`, ever. There is no `disable()`, and re-enabling
      // with empty callbacks would silently uninstall a tracker somebody else
      // installed after us.
      expect(tracking.enabledWith).toHaveLength(1);
    });

    test('is idempotent', () => {
      const { logger, destination, tracking } = wired();
      const uninstall = installRejectionHandler({ logger, tracking });

      uninstall();
      uninstall();
      tracking.reject(1, new Error('x'));

      expect(destination.entries).toHaveLength(0);
      expect(tracking.enabledWith).toHaveLength(1);
    });

    test('after an uninstall the next install chains to what is left', () => {
      const { logger, destination, tracking } = wired();
      const uninstall = installRejectionHandler({ logger, tracking });
      uninstall();

      const second = new Logger();
      const secondDestination = new RecordingDestination();
      second.removeDestination('console').addDestination(secondDestination);
      installRejectionHandler({ logger: second, tracking });

      tracking.reject(1, new Error('x'));

      expect(secondDestination.entries).toHaveLength(1);
      expect(destination.entries).toHaveLength(0);
    });
  });

  describe('resolving a tracker', () => {
    const originalHermes = globalThis.HermesInternal;

    afterEach(() => {
      if (originalHermes === undefined) delete globalThis.HermesInternal;
      else globalThis.HermesInternal = originalHermes;
    });

    test('uses Hermes when it offers one', () => {
      const seen: RejectionTrackingOptions[] = [];
      globalThis.HermesInternal = {
        enablePromiseRejectionTracker(options: RejectionTrackingOptions) {
          seen.push(options);
        },
      };

      const logger = new Logger();
      const destination = new RecordingDestination();
      logger.removeDestination('console').addDestination(destination);
      installRejectionHandler({ logger });

      expect(seen).toHaveLength(1);
      seen[0]!.onUnhandled?.(1, new Error('x'));
      expect(destination.entries).toHaveLength(1);
    });

    // A `HermesInternal` without the tracker is the ordinary case on older
    // Hermes, not an exotic one. Reading it as a tracker would throw at
    // install time, from a call whose whole contract is to degrade quietly.
    test('ignores a HermesInternal that has no tracker', () => {
      globalThis.HermesInternal = { hasPromise: true };

      const logger = new Logger();
      expect(() => installRejectionHandler({ logger })).not.toThrow();
    });

    test('ignores a HermesInternal that is not an object', () => {
      globalThis.HermesInternal = 'yes';

      const logger = new Logger();
      expect(() => installRejectionHandler({ logger })).not.toThrow();
    });

    test('an injected tracker wins over Hermes', () => {
      const seen: RejectionTrackingOptions[] = [];
      globalThis.HermesInternal = {
        enablePromiseRejectionTracker(options: RejectionTrackingOptions) {
          seen.push(options);
        },
      };

      const { logger, tracking } = wired();
      installRejectionHandler({ logger, tracking });

      expect(tracking.enabledWith).toHaveLength(1);
      expect(seen).toHaveLength(0);
    });

    // Nothing to install into is an ordinary answer — a bare Node test, an
    // engine without the polyfill — and it must not throw out of a call the
    // app makes at startup.
    test('a tracker that refuses to enable leaves nothing behind', () => {
      const { logger, destination, tracking } = wired();
      tracking.throwOnEnable = true;

      const uninstall = installRejectionHandler({ logger, tracking });
      expect(() => uninstall()).not.toThrow();

      // And the failed install is not in the chain: a later handler must not
      // forward to one that never received anything.
      tracking.throwOnEnable = false;
      const second = new Logger();
      const secondDestination = new RecordingDestination();
      second.removeDestination('console').addDestination(secondDestination);
      installRejectionHandler({ logger: second, tracking });
      tracking.reject(1, new Error('x'));

      expect(secondDestination.entries).toHaveLength(1);
      expect(destination.entries).toHaveLength(0);
    });
  });

  // `REJECTION_METADATA_KEYS` is a promise to the reader: put these in your
  // strict key catalog and rejection reports survive it. A catalog is
  // fail-closed — an unlisted key is dropped, payload and all — so a key
  // emitted here and missing from the list does not warn, it deletes the field.
  describe('the advertised metadata keys', () => {
    function emittedKeys(): string[] {
      const { logger, destination, tracking } = wired();
      installRejectionHandler({ logger, tracking });
      tracking.reject(1, new Error('x'));
      tracking.handleLate(1, new Error('x'));
      return [
        ...new Set(
          destination.entries.flatMap((entry) =>
            Object.keys(entry.metadata ?? {})
          )
        ),
      ];
    }

    test('are exactly the keys a rejection emits, in both directions', () => {
      // Set equality, not containment. One direction catches a new field the
      // catalog would silently eat; the other catches a name left behind by a
      // rename, which tells a reader to allow a key that will never arrive.
      expect(emittedKeys().sort()).toEqual([...REJECTION_METADATA_KEYS].sort());
    });

    test('contain no duplicates', () => {
      // A repeated entry is invisible to every membership check, and to the
      // set comparison above once it is sorted into a `toEqual`.
      const seen = new Set(REJECTION_METADATA_KEYS);
      expect(seen.size).toBe(REJECTION_METADATA_KEYS.length);
    });
  });

  // Under `privacyDefault('private')` a bare primitive renders `<private>` in
  // release, so a machine-generated diagnostic field has to say so at the call
  // site or it arrives useless — the same trap the crash handler fell into.
  describe('under the strict privacy profile', () => {
    const originalDev = globalThis.__DEV__;

    afterEach(() => {
      if (originalDev === undefined) delete globalThis.__DEV__;
      else globalThis.__DEV__ = originalDev;
    });

    test('the generated diagnostic fields survive a release render', () => {
      // Release, not dev: in dev everything reveals and this would pass
      // whether or not the values were marked.
      globalThis.__DEV__ = false;

      const { logger, destination, tracking } = wired();
      logger
        .privacyDefault('private')
        .metadataKeyCatalog([...REJECTION_METADATA_KEYS]);
      installRejectionHandler({ logger, tracking });

      tracking.reject(9, new Error('boom'));
      tracking.handleLate(9, new Error('boom'));

      const reported = destination.entries[0]!.metadata!;
      expect(reported.rejectionId).toBe(9);
      expect(typeof reported.errorFrameCount).toBe('number');
      expect(typeof reported.errorFramesTruncated).toBe('boolean');
      expect(reported.rejectionId).not.toBe('<private>');
      expect(reported.errorFrameCount).not.toBe('<private>');

      // The late entry carries only the id, so if that one field were private
      // the entry would say nothing at all.
      expect(destination.entries[1]!.metadata!.rejectionId).toBe(9);
    });

    test('an uncatalogued key drops even though its value is public', () => {
      // `pub()` speaks for the value; the catalog speaks for the name. Pins
      // the reason the reference tells you to catalog these six keys.
      globalThis.__DEV__ = false;

      const { logger, destination, tracking } = wired();
      logger.privacyDefault('private').metadataKeyCatalog(['errorName']);
      installRejectionHandler({ logger, tracking });

      tracking.reject(9, new Error('boom'));

      const reported = destination.entries[0]!.metadata!;
      expect(reported.errorName).toBeDefined();
      expect(reported.rejectionId).toBeUndefined();
    });
  });
});
