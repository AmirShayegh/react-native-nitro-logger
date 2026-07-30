import { Logger } from '../src/Logger';
import {
  ERROR_METADATA_KEYS,
  installErrorHandler,
  UNCAUGHT_ERROR_MESSAGE,
} from '../src/integrations/errorHandler';
import type { ErrorUtilsLike } from '../src/integrations/errorHandler';
import { flushOnBackground } from '../src/integrations/appState';
import type { AppStateLike } from '../src/integrations/appState';
import { REDACTED_MESSAGE } from '../src/integrations/sanitizeError';
import type { LogDestination } from '../src/destinations/types';
import type { LogEntry } from '../src/types';

declare const globalThis: { __DEV__?: boolean };

const SENTINEL = 'MRN-4417293';

/** Captures entries and counts flushes, so both halves are observable. */
class RecordingDestination implements LogDestination {
  readonly label = 'recording';
  readonly isEnabled = true;
  readonly entries: LogEntry[] = [];
  flushes = 0;
  flushDeadlines: (number | undefined)[] = [];
  flushThrows = false;

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }

  flush(deadlineMs?: number): void {
    this.flushes += 1;
    this.flushDeadlines.push(deadlineMs);
    if (this.flushThrows) throw new Error('flush failed');
  }

  dispose(): void {}
}

/** A stand-in for RN's global `ErrorUtils`. */
class FakeErrorUtils implements ErrorUtilsLike {
  handler: ((error: unknown, isFatal?: boolean) => void) | undefined;

  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void {
    this.handler = handler;
  }

  getGlobalHandler():
    ((error: unknown, isFatal?: boolean) => void) | undefined {
    return this.handler;
  }

  throw(error: unknown, isFatal?: boolean): void {
    this.handler?.(error, isFatal);
  }
}

function wired() {
  const logger = new Logger();
  const destination = new RecordingDestination();
  logger.removeDestination('console').addDestination(destination);
  const errorUtils = new FakeErrorUtils();
  return { logger, destination, errorUtils };
}

describe('installErrorHandler', () => {
  test('logs an uncaught error at error level', () => {
    const { logger, destination, errorUtils } = wired();
    installErrorHandler({ logger, errorUtils });

    errorUtils.throw(new TypeError('x'), false);

    expect(destination.entries).toHaveLength(1);
    const entry = destination.entries[0]!;
    expect(entry.level).toBe('error');
    expect(entry.message).toBe(UNCAUGHT_ERROR_MESSAGE);
  });

  // The whole reason this integration exists: a crash is exactly when the
  // entries explaining it are still in a buffer, and exactly when nothing will
  // come along later to write them.
  test('flushes on a fatal error and not on a caught one', () => {
    const { logger, destination, errorUtils } = wired();
    installErrorHandler({ logger, errorUtils });

    errorUtils.throw(new Error('recoverable'), false);
    expect(destination.flushes).toBe(0);

    errorUtils.throw(new Error('fatal'), true);
    expect(destination.flushes).toBe(1);
  });

  test('the fatal flush gets its own budget', () => {
    const { logger, destination, errorUtils } = wired();
    installErrorHandler({ logger, errorUtils, fatalFlushMs: 750 });

    errorUtils.throw(new Error('fatal'), true);
    expect(destination.flushDeadlines).toEqual([750]);
  });

  test('nothing from the error reaches the entry', () => {
    const { logger, destination, errorUtils } = wired();
    installErrorHandler({ logger, errorUtils });

    class PatientNotFoundError extends Error {}
    const error = new PatientNotFoundError(`no chart for ${SENTINEL}`);
    error.name = 'PatientNotFoundError';
    errorUtils.throw(error, false);

    const entry = destination.entries[0]!;
    expect(JSON.stringify(entry)).not.toContain(SENTINEL);
    expect(JSON.stringify(entry)).not.toContain('PatientNotFound');
    expect(JSON.stringify(entry)).toContain(REDACTED_MESSAGE);
  });

  test('records whether the error was fatal', () => {
    const { logger, destination, errorUtils } = wired();
    installErrorHandler({ logger, errorUtils });

    errorUtils.throw(new Error('a'), true);
    errorUtils.throw(new Error('b'), false);

    expect(destination.entries[0]!.metadata).toMatchObject({ fatal: true });
    expect(destination.entries[1]!.metadata).toMatchObject({ fatal: false });
  });

  // The strict profile is the one this package exists for, and it is also the
  // one that can quietly hollow out a crash report: under `'private'` a bare
  // primitive renders `<private>` in release, so a diagnostic field that is
  // machine-generated has to say so at the call site or it arrives useless.
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

      const { logger, destination, errorUtils } = wired();
      logger
        .privacyDefault('private')
        .metadataKeyCatalog([
          'errorName',
          'errorMessage',
          'errorFrames',
          'errorFrameCount',
          'errorFramesTruncated',
          'fatal',
        ]);
      installErrorHandler({ logger, errorUtils });

      errorUtils.throw(new Error('boom'), true);

      const metadata = destination.entries[0]!.metadata!;
      expect(metadata.fatal).toBe(true);
      expect(typeof metadata.errorFrameCount).toBe('number');
      expect(typeof metadata.errorFramesTruncated).toBe('boolean');
      // The message is redacted by sanitizeError before it ever reaches
      // privacy — the point here is that the counters are not.
      expect(metadata.fatal).not.toBe('<private>');
      expect(metadata.errorFrameCount).not.toBe('<private>');
      expect(metadata.errorFramesTruncated).not.toBe('<private>');
    });

    test('an uncatalogued key drops even though its value is public', () => {
      // `pub()` speaks for the value; the catalog speaks for the name. Pins
      // the reason PRIVACY.md tells you to catalog these six keys.
      globalThis.__DEV__ = false;

      const { logger, destination, errorUtils } = wired();
      logger.privacyDefault('private').metadataKeyCatalog(['errorName']);
      installErrorHandler({ logger, errorUtils });

      errorUtils.throw(new Error('boom'), true);

      const metadata = destination.entries[0]!.metadata!;
      expect(metadata.errorName).toBeDefined();
      expect(metadata.fatal).toBeUndefined();
      expect(metadata.errorFrameCount).toBeUndefined();
    });

    test('no catalog at all drops every key, including the generated ones', () => {
      // Fail-closed, and the behaviour PRIVACY.md previously described as a
      // convention rather than a rule.
      globalThis.__DEV__ = false;

      const { logger, destination, errorUtils } = wired();
      logger.privacyDefault('private');
      installErrorHandler({ logger, errorUtils });

      errorUtils.throw(new Error('boom'), true);

      const metadata = destination.entries[0]!.metadata!;
      expect(metadata.errorName).toBeUndefined();
      expect(metadata.fatal).toBeUndefined();
      // The count of what was dropped is added after filtering, so it is the
      // one key that cannot be dropped.
      expect(metadata.droppedMetadataCount).toBe(6);
    });
  });

  // `ERROR_METADATA_KEYS` is a promise to the reader: put these in your strict
  // key catalog and crash reports survive it. A catalog is fail-closed — an
  // unlisted key is dropped, payload and all — so a key emitted here and
  // missing from that list does not warn, it deletes the field. Which makes
  // the list exactly as load-bearing as the code that emits, and until this it
  // was asserted nowhere: it could have named five of the six, or six that no
  // longer existed, through any number of releases.
  describe('the advertised metadata keys', () => {
    /** The keys one uncaught error actually writes. */
    function emittedKeys(): string[] {
      const { logger, destination, errorUtils } = wired();
      installErrorHandler({ logger, errorUtils });
      errorUtils.throw(new Error('x'), true);
      return Object.keys(destination.entries[0]!.metadata ?? {});
    }

    test('are exactly the keys a crash emits, in both directions', () => {
      // Set equality, not containment. One direction catches a new field the
      // catalog would silently eat; the other catches a name left behind by a
      // rename, which tells a reader to allow a key that will never arrive and
      // is indistinguishable from the field simply never being emitted.
      expect([...emittedKeys()].sort()).toEqual(
        [...ERROR_METADATA_KEYS].sort()
      );
    });

    test('contain no duplicates', () => {
      // A repeated entry is invisible to every membership check, and to the
      // set comparison above once it is sorted into a `toEqual` — the arrays
      // would differ in length but a reader debugging that failure sees a
      // missing key, not a doubled one. Named separately so it reports itself.
      const seen = new Set<string>();
      const repeated = ERROR_METADATA_KEYS.filter((key) => {
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      });

      expect(repeated).toEqual([]);
    });

    test('every one of them survives a catalog built from the list', () => {
      // The end-to-end version of the claim the constant makes. The two
      // assertions above compare names; this checks that following the
      // documented advice actually leaves a usable crash report, which is what
      // a reader is being promised.
      const { logger, destination, errorUtils } = wired();
      logger.metadataKeyCatalog([...ERROR_METADATA_KEYS]);
      installErrorHandler({ logger, errorUtils });

      errorUtils.throw(new Error('x'), true);

      const metadata = destination.entries[0]!.metadata!;
      expect(Object.keys(metadata).sort()).toEqual(
        [...ERROR_METADATA_KEYS].sort()
      );
      expect(metadata.droppedMetadataCount).toBeUndefined();
    });
  });

  describe('chaining', () => {
    // Suppressing the previous handler removes the dev RedBox and, in
    // production, turns a crash into a silently broken app.
    test('passes the error to the handler that was already installed', () => {
      const { logger, errorUtils } = wired();
      const seen: unknown[] = [];
      errorUtils.setGlobalHandler((error) => seen.push(error));

      installErrorHandler({ logger, errorUtils });
      const thrown = new Error('x');
      errorUtils.throw(thrown, true);

      expect(seen).toEqual([thrown]);
    });

    test('can be told not to', () => {
      const { logger, errorUtils } = wired();
      const seen: unknown[] = [];
      errorUtils.setGlobalHandler((error) => seen.push(error));

      installErrorHandler({ logger, errorUtils, chain: false });
      errorUtils.throw(new Error('x'), true);

      expect(seen).toEqual([]);
    });

    test('the flush happens before the error is passed on', () => {
      const { logger, destination, errorUtils } = wired();
      let flushesAtChain = -1;
      errorUtils.setGlobalHandler(() => {
        flushesAtChain = destination.flushes;
      });

      installErrorHandler({ logger, errorUtils });
      errorUtils.throw(new Error('x'), true);

      expect(flushesAtChain).toBe(1);
    });
  });

  describe('uninstall', () => {
    test('restores the previous handler', () => {
      const { logger, errorUtils } = wired();
      const original = (): void => {};
      errorUtils.setGlobalHandler(original);

      const uninstall = installErrorHandler({ logger, errorUtils });
      expect(errorUtils.getGlobalHandler()).not.toBe(original);

      uninstall();
      expect(errorUtils.getGlobalHandler()).toBe(original);
    });

    test('is idempotent', () => {
      const { logger, errorUtils } = wired();
      const original = (): void => {};
      errorUtils.setGlobalHandler(original);

      const uninstall = installErrorHandler({ logger, errorUtils });
      uninstall();
      uninstall();

      expect(errorUtils.getGlobalHandler()).toBe(original);
    });

    // Another library, or a hot reload, may have installed its own since.
    // Putting `previous` back would silently uninstall theirs.
    test('leaves a handler installed after ours alone', () => {
      const { logger, errorUtils } = wired();
      const uninstall = installErrorHandler({ logger, errorUtils });

      const laterHandler = (): void => {};
      errorUtils.setGlobalHandler(laterHandler);
      uninstall();

      expect(errorUtils.getGlobalHandler()).toBe(laterHandler);
    });

    // Two libraries install; the first is removed while the second is still on
    // top. When the second goes, restoring "whatever was there before me"
    // would put the first back — logging to a logger its owner has finished
    // with, and keeping that logger alive for the rest of the process.
    test('an out-of-order uninstall is not undone by a later one', () => {
      const errorUtils = new FakeErrorUtils();

      const first = new Logger();
      const firstDestination = new RecordingDestination();
      first.removeDestination('console').addDestination(firstDestination);

      const second = new Logger();
      const secondDestination = new RecordingDestination();
      second.removeDestination('console').addDestination(secondDestination);

      const uninstallFirst = installErrorHandler({ logger: first, errorUtils });
      const uninstallSecond = installErrorHandler({
        logger: second,
        errorUtils,
      });

      uninstallFirst();
      uninstallSecond();

      errorUtils.throw(new Error('x'), false);
      expect(firstDestination.entries).toHaveLength(0);
      expect(secondDestination.entries).toHaveLength(0);
    });

    // The same shape, but the first is still live: it must resume.
    test('a nested uninstall restores the handler that is still installed', () => {
      const errorUtils = new FakeErrorUtils();

      const first = new Logger();
      const firstDestination = new RecordingDestination();
      first.removeDestination('console').addDestination(firstDestination);

      const second = new Logger();
      const secondDestination = new RecordingDestination();
      second.removeDestination('console').addDestination(secondDestination);

      installErrorHandler({ logger: first, errorUtils });
      const uninstallSecond = installErrorHandler({
        logger: second,
        errorUtils,
      });
      uninstallSecond();

      errorUtils.throw(new Error('x'), false);
      expect(firstDestination.entries).toHaveLength(1);
      expect(secondDestination.entries).toHaveLength(0);
    });

    // Chaining must skip a dead link rather than call it.
    test('an uninstalled handler is not chained to', () => {
      const errorUtils = new FakeErrorUtils();
      const foreign: unknown[] = [];
      errorUtils.setGlobalHandler((error) => foreign.push(error));

      const first = new Logger();
      const firstDestination = new RecordingDestination();
      first.removeDestination('console').addDestination(firstDestination);

      const second = new Logger();
      const secondDestination = new RecordingDestination();
      second.removeDestination('console').addDestination(secondDestination);

      const uninstallFirst = installErrorHandler({ logger: first, errorUtils });
      installErrorHandler({ logger: second, errorUtils });
      uninstallFirst();

      const thrown = new Error('x');
      errorUtils.throw(thrown, false);

      expect(secondDestination.entries).toHaveLength(1);
      expect(firstDestination.entries).toHaveLength(0);
      // The handler that was there before either of ours is not ours to drop.
      expect(foreign).toEqual([thrown]);
    });

    test('stops logging afterwards', () => {
      const { logger, destination, errorUtils } = wired();
      const uninstall = installErrorHandler({ logger, errorUtils });
      uninstall();

      errorUtils.throw(new Error('x'), false);
      expect(destination.entries).toHaveLength(0);
    });
  });

  describe('failure isolation', () => {
    // A handler that throws while reporting a crash replaces a diagnosable
    // failure with an undiagnosable one.
    test('a throwing flush does not stop the error reaching the next handler', () => {
      const { logger, destination, errorUtils } = wired();
      destination.flushThrows = true;
      const seen: unknown[] = [];
      errorUtils.setGlobalHandler((error) => seen.push(error));

      installErrorHandler({ logger, errorUtils });
      const thrown = new Error('x');

      expect(() => errorUtils.throw(thrown, true)).not.toThrow();
      expect(seen).toEqual([thrown]);
    });

    test('a hostile thrown value does not escape the handler', () => {
      const { logger, errorUtils } = wired();
      installErrorHandler({ logger, errorUtils });

      const hostile = {
        get stack(): string {
          throw new Error('boom');
        },
      };
      expect(() => errorUtils.throw(hostile, false)).not.toThrow();
    });
  });

  test('a runtime with no ErrorUtils gets a working no-op', () => {
    const { logger } = wired();
    const uninstall = installErrorHandler({
      logger,
      errorUtils: undefined,
    });
    expect(() => uninstall()).not.toThrow();
  });
});

describe('flushOnBackground', () => {
  class FakeAppState implements AppStateLike {
    listener: ((state: string) => void) | undefined;
    removed = false;

    addEventListener(
      _type: 'change',
      listener: (state: string) => void
    ): { remove(): void } {
      this.listener = listener;
      return {
        remove: () => {
          this.removed = true;
          this.listener = undefined;
        },
      };
    }

    change(state: string): void {
      this.listener?.(state);
    }
  }

  function backgrounded() {
    const logger = new Logger();
    const destination = new RecordingDestination();
    logger.removeDestination('console').addDestination(destination);
    const appState = new FakeAppState();
    return { logger, destination, appState };
  }

  test.each(['background', 'inactive'])(
    'flushes when the app goes %s',
    (state) => {
      const { logger, destination, appState } = backgrounded();
      flushOnBackground({ logger, appState });

      appState.change(state);
      expect(destination.flushes).toBe(1);
    }
  );

  test('ignores a return to the foreground', () => {
    const { logger, destination, appState } = backgrounded();
    flushOnBackground({ logger, appState });

    appState.change('active');
    expect(destination.flushes).toBe(0);
  });

  // iOS passes through `inactive` on the way to `background`, and on some
  // transitions that is as far as it gets — so both flush, and the second is a
  // length check on an empty buffer.
  test('flushes on both halves of an inactive → background transition', () => {
    const { logger, destination, appState } = backgrounded();
    flushOnBackground({ logger, appState });

    appState.change('inactive');
    appState.change('background');
    expect(destination.flushes).toBe(2);
  });

  test('uses the configured deadline', () => {
    const { logger, destination, appState } = backgrounded();
    flushOnBackground({ logger, appState, deadlineMs: 400 });

    appState.change('background');
    expect(destination.flushDeadlines).toEqual([400]);
  });

  test('a throwing flush does not escape the listener', () => {
    const { logger, destination, appState } = backgrounded();
    destination.flushThrows = true;
    flushOnBackground({ logger, appState });

    expect(() => appState.change('background')).not.toThrow();
  });

  describe('uninstall', () => {
    // AppState outlives any component: a subscription left behind keeps a
    // disposed logger reachable and flushes it for the rest of the process.
    test('removes the subscription', () => {
      const { logger, destination, appState } = backgrounded();
      const uninstall = flushOnBackground({ logger, appState });

      uninstall();
      expect(appState.removed).toBe(true);

      appState.change('background');
      expect(destination.flushes).toBe(0);
    });

    test('is idempotent', () => {
      const { logger, appState } = backgrounded();
      const uninstall = flushOnBackground({ logger, appState });

      uninstall();
      expect(() => uninstall()).not.toThrow();
    });
  });

  test('a runtime with no AppState gets a working no-op', () => {
    const { logger } = backgrounded();
    const uninstall = flushOnBackground({ logger, appState: undefined });
    expect(() => uninstall()).not.toThrow();
  });
});
