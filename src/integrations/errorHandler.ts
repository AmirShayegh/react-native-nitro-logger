import type { Logger } from '../Logger';
import { Log } from '../Logger';
import { pub } from '../privacy';
import type { SanitizeErrorOptions } from './sanitizeError';
import { sanitizeError } from './sanitizeError';

/**
 * React Native's global error hook.
 *
 * `ErrorUtils` is undocumented and has been de-facto stable for a decade, which
 * is the whole risk: it is typed here rather than imported so the library never
 * depends on a declaration file that may not exist, and every access is
 * guarded so a runtime without it degrades to doing nothing.
 */
export interface ErrorUtilsLike {
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
  getGlobalHandler?():
    ((error: unknown, isFatal?: boolean) => void) | undefined;
}

/** Metadata keys this handler writes. Add them to a strict key catalog. */
export const ERROR_METADATA_KEYS = [
  'errorName',
  'errorMessage',
  'errorFrames',
  'errorFrameCount',
  'errorFramesTruncated',
  'fatal',
] as const;

/** The message this handler logs. A literal, as the lint rule requires. */
export const UNCAUGHT_ERROR_MESSAGE = 'uncaught error';

export interface ErrorHandlerOptions extends SanitizeErrorOptions {
  /** Defaults to the shared `Log`. */
  readonly logger?: Logger;
  /** Injected for tests; defaults to the global `ErrorUtils`. */
  readonly errorUtils?: ErrorUtilsLike;
  /**
   * How long a fatal error's flush may take. Default 2000 ms.
   *
   * This is the crash path and the only chance the buffered entries get, so it
   * is worth more than a normal flush — but it runs on the JS thread while the
   * app is already dying, and a watchdog kill loses the log entirely.
   */
  readonly fatalFlushMs?: number;
  /** Subsystem to tag the entry with. */
  readonly subsystem?: string;
  /**
   * Pass the error on to whatever handler was installed before. Default true:
   * suppressing it removes the dev RedBox and, in production, converts a crash
   * into a silently broken app.
   */
  readonly chain?: boolean;
}

const DEFAULT_FATAL_FLUSH_MS = 2000;

/** Undoes an install. Idempotent; safe to call after another handler took over. */
export type Uninstall = () => void;

/**
 * Logs uncaught errors, flushes on fatal ones, and hands the error onward.
 *
 * The flush is the reason this exists. A crash is precisely when the buffered
 * entries explaining it are still in memory, and precisely when nothing will
 * come along later to write them.
 *
 * Nothing about the error is trusted — see {@link sanitizeError}. What reaches
 * the log is a built-in class name, a redacted message outside dev, and stack
 * positions in files whose names were already known.
 */
export function installErrorHandler(options?: ErrorHandlerOptions): Uninstall {
  const errorUtils = options?.errorUtils ?? globalErrorUtils();
  if (!errorUtils) {
    // No hook on this runtime — a bare Node test, a web target. Returning a
    // no-op uninstall keeps the caller's teardown symmetrical either way.
    return () => {};
  }

  const logger = options?.logger ?? Log;
  const chain = options?.chain ?? true;
  const fatalFlushMs = flushBudget(options?.fatalFlushMs);
  const previous = readPrevious(errorUtils);

  const handler = (error: unknown, isFatal?: boolean): void => {
    // Uninstalled, but still the installed handler: something installed over
    // us and then restored us on its way out. Pass straight through rather
    // than logging to a logger the caller has finished with.
    if (INSTALLED.get(handler)?.active !== true) {
      liveHandler(previous)?.(error, isFatal);
      return;
    }

    // Every step is isolated. A handler that throws while reporting a crash
    // replaces a diagnosable failure with an undiagnosable one, and takes the
    // previous handler — the RedBox, the crash reporter — down with it.
    try {
      const sanitized = sanitizeError(error, options);
      logger.error(
        UNCAUGHT_ERROR_MESSAGE,
        {
          errorName: pub(sanitized.name),
          errorMessage: pub(sanitized.message),
          errorFrames: pub(sanitized.frames.join(' | ')),
          // Wrapped for the same reason as the three above, and it was an
          // oversight that they were not: every one of these is generated
          // here, from a count, a flag this function was handed, and a
          // decision this module made. None can carry caller data. Left bare
          // they follow the privacy default, so under `privacyDefault('private')`
          // a crash report renders `fatal: <private>` — which withholds
          // nothing, because there was nothing to withhold, and costs the
          // reader the one field that says whether the app is still running.
          errorFrameCount: pub(sanitized.frameCount),
          errorFramesTruncated: pub(sanitized.framesTruncated),
          fatal: pub(isFatal === true),
        },
        options?.subsystem
      );
    } catch {
      // Reporting failed; the flush and the chain below still matter.
    }

    if (isFatal) {
      try {
        logger.flush(fatalFlushMs);
      } catch {
        // A destination that cannot flush must not stop the crash from
        // reaching the handler that shows it.
      }
    }

    if (chain) {
      liveHandler(previous)?.(error, isFatal);
    }
  };

  INSTALLED.set(handler, { active: true, previous });
  errorUtils.setGlobalHandler(handler);

  return () => {
    const state = INSTALLED.get(handler);
    if (!state || !state.active) return;

    // Marked dead first, and unconditionally. Uninstalling out of order is
    // ordinary — two libraries, a hot reload — and if this only took effect
    // when ours happened to be the current handler, a later uninstall that
    // restored us would bring a logger back to life that its owner had
    // already let go of.
    state.active = false;

    // Something else is installed over us. Leave it alone: putting `previous`
    // back would silently uninstall theirs. The flag above makes our wrapper
    // inert if they ever restore it.
    if (readPrevious(errorUtils) !== handler) return;
    errorUtils.setGlobalHandler(liveHandler(state.previous) ?? (() => {}));
  };
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;

interface InstallState {
  active: boolean;
  previous: GlobalHandler | undefined;
}

/**
 * The handlers this module installed, and whether each is still live.
 *
 * A WeakMap rather than a property on the function: the entry disappears with
 * the handler, and nothing about our bookkeeping is visible to code that
 * inspects the global handler.
 */
const INSTALLED = new WeakMap<GlobalHandler, InstallState>();

/**
 * The first handler in the chain that is still installed.
 *
 * Walks past our own uninstalled wrappers. Any handler we did not install is
 * live by definition — we have no way to know otherwise, and assuming it is
 * gone would drop the RedBox or a crash reporter.
 */
function liveHandler(
  handler: GlobalHandler | undefined
): GlobalHandler | undefined {
  const seen = new Set<GlobalHandler>();
  let candidate = handler;
  while (candidate) {
    const state = INSTALLED.get(candidate);
    if (!state || state.active) return candidate;
    // A cycle needs two of our own handlers pointing at each other, which
    // takes a restore we did not do — but the crash path is the wrong place
    // to find out the hard way.
    if (seen.has(candidate)) return undefined;
    seen.add(candidate);
    candidate = state.previous;
  }
  return undefined;
}

function readPrevious(errorUtils: ErrorUtilsLike): GlobalHandler | undefined {
  try {
    return errorUtils.getGlobalHandler?.();
  } catch {
    return undefined;
  }
}

/** The global `ErrorUtils`, if this runtime has one. */
function globalErrorUtils(): ErrorUtilsLike | undefined {
  const candidate = (globalThis as { ErrorUtils?: unknown }).ErrorUtils;
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const setter = (candidate as { setGlobalHandler?: unknown }).setGlobalHandler;
  return typeof setter === 'function'
    ? (candidate as ErrorUtilsLike)
    : undefined;
}

function flushBudget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_FATAL_FLUSH_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_FATAL_FLUSH_MS;
  return value;
}
