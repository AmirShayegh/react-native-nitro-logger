import type { Logger } from '../Logger';
import { Log } from '../Logger';
import { pub } from '../privacy';
import type { Uninstall } from './errorHandler';
import type { SanitizeErrorOptions } from './sanitizeError';
import { sanitizeError } from './sanitizeError';

/**
 * The promise-rejection tracker, in the one shape everything that ships one
 * agrees on.
 *
 * Hermes exposes `HermesInternal.enablePromiseRejectionTracker` and React
 * Native's polyfill exposes `promise/setimmediate/rejection-tracking`; both take
 * this object. Typed here rather than imported, for the reason
 * {@link ErrorUtilsLike} gives: neither is a documented module this library may
 * depend on existing.
 */
export interface RejectionTrackingOptions {
  /**
   * Report rejections whose reason is not an `Error` as well.
   *
   * True, always, and not offered as an option: a rejection with a string
   * reason is exactly the one whose text nobody has vetted, and leaving it
   * untracked would mean the sanitizer never sees it.
   */
  readonly allRejections?: boolean;
  onUnhandled?(id: number, rejection: unknown): void;
  onHandled?(id: number, rejection: unknown): void;
}

/** The one call this integration makes. Injected in tests. */
export interface RejectionTrackingLike {
  enable(options: RejectionTrackingOptions): void;
}

/**
 * Metadata keys this handler writes. Add them to a strict key catalog.
 *
 * The first five are {@link sanitizeError}'s, spelled exactly as
 * {@link ERROR_METADATA_KEYS} spells them so one catalog entry covers both.
 * `fatal` is absent on purpose: an unhandled rejection is not a crash, and a
 * key that is always `false` is a key that teaches the reader nothing.
 */
export const REJECTION_METADATA_KEYS = [
  'errorName',
  'errorMessage',
  'errorFrames',
  'errorFrameCount',
  'errorFramesTruncated',
  'rejectionId',
] as const;

/** The message an unhandled rejection logs. A literal, as the lint rule requires. */
export const UNHANDLED_REJECTION_MESSAGE = 'unhandled promise rejection';

/** The message a late-handled rejection logs. */
export const REJECTION_HANDLED_LATE_MESSAGE = 'promise rejection handled late';

export interface RejectionHandlerOptions extends SanitizeErrorOptions {
  /** Defaults to the shared `Log`. */
  readonly logger?: Logger;
  /** Injected for tests; defaults to Hermes' tracker, then the polyfill. */
  readonly tracking?: RejectionTrackingLike;
  /** Subsystem to tag the entries with. */
  readonly subsystem?: string;
  /**
   * Also log when a rejection reported unhandled is handled afterwards.
   * Default true.
   *
   * A tracker decides "unhandled" on a timer, so a `.catch()` attached one turn
   * too late produces an error entry for something the app dealt with. Without
   * this the log says a failure went unhandled and never takes it back.
   */
  readonly logHandledLate?: boolean;
  /**
   * Pass the rejection on to a handler this module installed earlier. Default
   * true.
   *
   * Only to our own — see {@link installRejectionHandler}.
   */
  readonly chain?: boolean;
}

/**
 * Logs unhandled promise rejections, and the ones that turn out to be handled.
 *
 * **In a release build this is the only way a rejection reaches the log.**
 * React Native installs its own tracker in dev and nothing in production, so an
 * `async` function that throws with nobody awaiting it is, by default,
 * completely silent in the builds that ship.
 *
 * Nothing about the rejection reason is trusted — it goes through
 * {@link sanitizeError} exactly as an uncaught error does, so what reaches the
 * log is a built-in class name, a redacted message outside dev, and stack
 * positions in files whose names were already known. A rejection reason is
 * caller data by construction: `Promise.reject(\`no chart for ${patient.mrn}\`)`
 * is an ordinary line of application code.
 *
 * No flush, unlike {@link installErrorHandler}: nothing is dying, the JS thread
 * keeps running, and the next ordinary flush will carry these entries out.
 *
 * ### What chaining can and cannot do
 *
 * `enable()` replaces the tracker wholesale and there is no getter, so a tracker
 * installed by anyone else is unreachable: this cannot chain to it, and cannot
 * detect that it existed. Chaining works between calls to *this* function, and
 * that is all it claims. Installing this replaces whatever was tracking before
 * — in dev, that is LogBox's rejection popup; the entry still reaches every
 * destination, console included.
 */
export function installRejectionHandler(
  options?: RejectionHandlerOptions
): Uninstall {
  const tracking = options?.tracking ?? resolveTracking();
  if (!tracking) {
    // No tracker on this runtime — a bare Node test, an engine without the
    // polyfill. Returning a no-op uninstall keeps the caller's teardown
    // symmetrical either way.
    return () => {};
  }

  const logger = options?.logger ?? Log;
  const chain = options?.chain ?? true;
  const logHandledLate = options?.logHandledLate ?? true;
  const previous = CURRENT;

  const state: InstallState = {
    active: true,
    previous,
    reported: new Set<number>(),
    onUnhandled(id, rejection) {
      // Uninstalled, but still the tracker's handler: nothing can put the
      // previous one back, so ours stays registered and forwards instead.
      if (!state.active) {
        liveHandler(previous)?.onUnhandled(id, rejection);
        return;
      }

      // Every step is isolated. A rejection handler that throws produces
      // another unhandled rejection, which arrives back here.
      try {
        const sanitized = sanitizeError(rejection, options);
        logger.error(
          UNHANDLED_REJECTION_MESSAGE,
          {
            errorName: pub(sanitized.name),
            errorMessage: pub(sanitized.message),
            errorFrames: pub(sanitized.frames.join(' | ')),
            errorFrameCount: pub(sanitized.frameCount),
            errorFramesTruncated: pub(sanitized.framesTruncated),
            // The tracker's own counter, and the join key: the late-handled
            // entry below carries the same one, so a reader can tell which
            // reported failure it takes back.
            rejectionId: pub(id),
          },
          options?.subsystem
        );
        // Only once the entry is out. Everything below keys off this, and an
        // id remembered for an entry that never got written would produce a
        // retraction of something nobody ever said.
        remember(state, id);
      } catch {
        // Reporting failed; the chain below still matters.
      }

      if (chain) liveHandler(previous)?.onUnhandled(id, rejection);
    },
    onHandled(id, rejection) {
      if (!state.active) {
        liveHandler(previous)?.onHandled(id, rejection);
        return;
      }

      // **Only for a rejection this handler actually reported.** The two
      // callbacks are separate events with a gap between them, and plenty fits
      // in that gap: an install, an uninstall, a `chain: false` handler that
      // took the first one on its own, a logger that threw on the way out. A
      // late-handled entry naming a rejection this log never reported is worse
      // than no entry at all — it retracts something nobody said.
      if (state.reported.delete(id) && logHandledLate) {
        try {
          // Info, not error. The failure entry is already written and stays
          // written; this one exists so the reader knows the app recovered.
          logger.info(
            REJECTION_HANDLED_LATE_MESSAGE,
            { rejectionId: pub(id) },
            options?.subsystem
          );
        } catch {
          // Same reason as above.
        }
      }

      // Forwarded either way, so each handler behind this one gets to make the
      // same decision about its own log rather than having it made for it.
      if (chain) liveHandler(previous)?.onHandled(id, rejection);
    },
  };

  try {
    tracking.enable({
      allRejections: true,
      onUnhandled: (id, rejection) => state.onUnhandled(id, rejection),
      onHandled: (id, rejection) => state.onHandled(id, rejection),
    });
  } catch {
    // A tracker that refuses to be enabled leaves nothing installed, so there
    // is nothing to undo — and `CURRENT` must not be moved, or the next
    // install would chain to a handler that never receives anything.
    return () => {};
  }

  CURRENT = state;

  let uninstalled = false;
  return () => {
    if (uninstalled) return;
    uninstalled = true;

    // Marked inert, never disabled. There is no `disable()`, and re-enabling
    // with empty callbacks would silently uninstall a tracker somebody else
    // installed after us — the failure this whole module is careful about.
    state.active = false;

    // Only if nothing has installed over us. If something has, `CURRENT` is
    // theirs and we are somewhere in their chain, where the flag above is what
    // makes us inert.
    if (CURRENT === state) CURRENT = liveHandler(state.previous);
  };
}

interface InstallState {
  active: boolean;
  previous: InstallState | undefined;
  /** Rejection ids whose unhandled entry this handler actually wrote. */
  reported: Set<number>;
  onUnhandled(id: number, rejection: unknown): void;
  onHandled(id: number, rejection: unknown): void;
}

/**
 * How many outstanding rejection ids one handler remembers.
 *
 * A rejection reported unhandled and never handled leaves its id behind, and
 * nothing ever comes to collect it — so this has to be bounded, or a long-lived
 * app that rejects steadily grows a set forever. The bound is generous next to
 * the gap between the two callbacks, which is one tracker timeout.
 *
 * **Stated limit:** a rejection handled after this many further rejections have
 * been reported gets no late-handled entry. The failure direction is a missing
 * retraction, never a false one.
 */
const REPORTED_LIMIT = 256;

/** Records an id, evicting the oldest once [REPORTED_LIMIT] is reached. */
function remember(state: InstallState, id: number): void {
  if (state.reported.size >= REPORTED_LIMIT) {
    // A `Set` iterates in insertion order, so the first is the oldest.
    const oldest = state.reported.values().next();
    if (!oldest.done) state.reported.delete(oldest.value);
  }
  state.reported.add(id);
}

/**
 * The handler this module has registered with the tracker, if any.
 *
 * Module state rather than a lookup, because there is nothing to look up: the
 * tracker offers no way to read back what is installed.
 */
let CURRENT: InstallState | undefined;

/** @internal Test seam — forgets the chain between tests. */
export function __resetRejectionHandlers(): void {
  CURRENT = undefined;
}

/** The first handler in the chain that has not been uninstalled. */
function liveHandler(
  state: InstallState | undefined
): InstallState | undefined {
  // Allocated on the second step, not the first. Almost every call answers
  // from the head of the chain — one handler, installed, still active — and
  // rejections arrive in bursts, so the common case should not pay for a
  // guard it never consults.
  let seen: Set<InstallState> | undefined;
  let candidate = state;
  while (candidate) {
    if (candidate.active) return candidate;
    // Only reachable if a chain were ever built into a cycle, which needs a
    // mistake this module cannot currently make — and the rejection path is
    // the wrong place to discover it the hard way.
    //
    // Which is also why no test pins it, stated rather than left to look
    // guarded: defeating this check outright leaves the whole suite passing,
    // because nothing can currently construct the cycle it defends against.
    // It is insurance against a future `previous` chain, not a live path.
    if (seen === undefined) seen = new Set();
    else if (seen.has(candidate)) return undefined;
    seen.add(candidate);
    candidate = candidate.previous;
  }
  return undefined;
}

/**
 * The runtime's rejection tracker, if it has one.
 *
 * Hermes first, because on Hermes it is the tracker that is actually wired to
 * the microtask queue; the polyfill second, for JavaScriptCore and for the
 * remote debugger. Both are reached defensively — neither is a module this
 * library is entitled to assume exists, and a static import of the second would
 * make the package entry point unloadable outside React Native.
 */
function resolveTracking(): RejectionTrackingLike | undefined {
  return hermesTracking() ?? polyfillTracking();
}

function hermesTracking(): RejectionTrackingLike | undefined {
  try {
    const hermes = (globalThis as { HermesInternal?: unknown }).HermesInternal;
    if (typeof hermes !== 'object' || hermes === null) return undefined;
    const enable = (hermes as { enablePromiseRejectionTracker?: unknown })
      .enablePromiseRejectionTracker;
    if (typeof enable !== 'function') return undefined;
    return {
      enable: (trackingOptions) =>
        (enable as (o: RejectionTrackingOptions) => void).call(
          hermes,
          trackingOptions
        ),
    };
  } catch {
    return undefined;
  }
}

function polyfillTracking(): RejectionTrackingLike | undefined {
  try {
    const module = require('promise/setimmediate/rejection-tracking') as {
      enable?: unknown;
    };
    if (typeof module?.enable !== 'function') return undefined;
    return module as RejectionTrackingLike;
  } catch {
    return undefined;
  }
}
