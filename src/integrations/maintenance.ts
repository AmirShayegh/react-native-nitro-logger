import type { AppStateLike } from './appState';
import { resolveAppState } from './appState';
import type { Uninstall } from './errorHandler';

/**
 * The part of a destination this drives.
 *
 * Structural rather than `FileDestination` itself, so a test can script it and
 * so a destination this library does not ship can be maintained the same way.
 * {@link FileDestination} satisfies it.
 */
export interface MaintainableDestination {
  /** Runs rotation and the retention sweep; returns the degradation mask. */
  maintain(deadlineMs: number): number;
}

export interface ScheduleMaintenanceOptions {
  /** The destination to sweep. */
  readonly destination: MaintainableDestination;
  /**
   * How often to sweep while the app is in the foreground. Default 5 minutes,
   * clamped up to {@link MINIMUM_MAINTENANCE_INTERVAL_MS}.
   */
  readonly intervalMs?: number;
  /** Budget for one sweep. Default 1000 ms. */
  readonly deadlineMs?: number;
  /** Injected for tests; defaults to `require('react-native').AppState`. */
  readonly appState?: AppStateLike;
}

/**
 * The shortest interval this accepts, 30 seconds.
 *
 * A sweep lists the log directory and stats every archive in it. That is
 * cheap once every few minutes and a background load every second, and the
 * work it does — age rotation, expiry, a total-bytes cap — has nothing that
 * needs answering faster than this. A caller asking for less gets this.
 */
export const MINIMUM_MAINTENANCE_INTERVAL_MS = 30_000;

const DEFAULT_INTERVAL_MS = 300_000;
const DEFAULT_DEADLINE_MS = 1000;

/**
 * States that mean the app is on screen. Everything else is a pause.
 *
 * `inactive` counts as paused for the same reason `flushOnBackground` counts
 * it as leaving: it is the way iOS transitions out, and a sweep started there
 * is a disk scan the user is not waiting for.
 */
const FOREGROUND = 'active';

/**
 * Sweeps a file destination on a timer, so rotation and retention still
 * happen when nothing is being logged.
 *
 * Rotation and retention run off the write path and nowhere else — the native
 * writer rotates when a record makes the file too big or too old *as it is
 * being appended*, and sweeps retention when it opens or rotates. A quiet sink
 * therefore keeps whatever it had when the last record landed: an age rotation
 * that never fires, an expired archive that is never deleted, a total-bytes cap
 * that goes on being exceeded until the next record arrives. This is the thing
 * that makes those happen anyway.
 *
 * ### Why the timer is here and not in the writer
 *
 * A native timer would have to run on a queue the app cannot see, wake a
 * suspended process, and answer to a retention policy the JS side owns. A JS
 * interval instead freezes when the JS thread freezes, which is exactly the
 * behaviour wanted, and lets the policy — how often, how long, whether at all
 * — stay in the caller's hands over a sink that only does what it is told.
 *
 * ### Foreground only
 *
 * The interval stops when the app leaves the foreground and starts again when
 * it returns, with one catch-up sweep on the way in: an interval that was
 * frozen for six hours has six hours of expired archives waiting, and waiting
 * a further five minutes for the next tick would be an odd way to spend them.
 * Installing while the app is already in the foreground does *not* sweep —
 * opening the sink has just run one, and app launch is the worst moment to
 * scan a directory.
 *
 * Where `AppState` cannot be reached at all — absent, or refusing to subscribe
 * — the interval simply runs, which is the pre-existing behaviour of every JS
 * timer in the process. Not pausing is the survivable failure here; never
 * sweeping is not.
 *
 * Returns an idempotent uninstall handle. It matters: an interval left behind
 * keeps a disposed destination reachable and goes on calling it forever.
 */
export function scheduleMaintenance(
  options: ScheduleMaintenanceOptions
): Uninstall {
  const destination = options.destination;
  const intervalMs = interval(options.intervalMs);
  const deadlineMs = budget(options.deadlineMs);
  const appState = options.appState ?? resolveAppState();

  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const sweep = (): void => {
    try {
      destination.maintain(deadlineMs);
    } catch {
      // `FileDestination.maintain` does not throw. This one is for the
      // structural case — a destination from somewhere else, on a timer with
      // nobody to catch what it raises.
    }
  };

  const start = (): void => {
    if (stopped || timer !== undefined) return;
    timer = setInterval(sweep, intervalMs);
  };

  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  // No sweep here, deliberately — see the note above.
  let foreground = appState === undefined || isForeground(appState);
  if (foreground) start();

  let subscription: { remove(): void } | undefined;
  if (appState !== undefined) {
    try {
      subscription = appState.addEventListener('change', (state) => {
        if (stopped) return;
        if (state === FOREGROUND) {
          // Guarded on the transition, not on the state: `AppState` can report
          // `active` twice, and a second one must not buy a second sweep.
          if (foreground) return;
          foreground = true;
          sweep();
          start();
          return;
        }
        foreground = false;
        stop();
      });
    } catch {
      // No subscription means no pausing, so this falls all the way back to the
      // no-`AppState` behaviour — including starting the interval, which the
      // line above deliberately skipped while the app looked backgrounded.
      // Without this, an install that happened off-foreground onto an
      // `AppState` that then refused to subscribe would have no timer and no
      // listener to ever start one: maintenance off for the life of the
      // process, silently.
      foreground = true;
      start();
    }
  }

  return () => {
    if (stopped) return;
    stopped = true;
    stop();
    try {
      subscription?.remove();
    } catch {
      // Already gone.
    }
  };
}

function isForeground(appState: AppStateLike): boolean {
  const state = appState.currentState;
  // An implementation that does not report its state is taken to be in the
  // foreground: the first `change` will correct it, and starting the timer and
  // pausing it shortly after is the harmless direction to be wrong in.
  return typeof state !== 'string' || state === FOREGROUND;
}

function interval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value))
    return DEFAULT_INTERVAL_MS;
  return Math.max(MINIMUM_MAINTENANCE_INTERVAL_MS, value);
}

function budget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DEADLINE_MS;
  return value;
}
