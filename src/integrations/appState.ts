import type { Logger } from '../Logger';
import { Log } from '../Logger';
import type { Uninstall } from './errorHandler';

/** The part of RN's `AppState` this uses. Injected in tests. */
export interface AppStateLike {
  /**
   * The state right now, if the implementation offers it.
   *
   * Optional because the listener is the part this module actually needs;
   * {@link scheduleMaintenance} reads it to decide whether to start its timer
   * before the first transition arrives, and treats an absent value as
   * foreground.
   */
  readonly currentState?: string;
  addEventListener(
    type: 'change',
    listener: (state: string) => void
  ): { remove(): void } | undefined;
}

export interface FlushOnBackgroundOptions {
  /** Defaults to the shared `Log`. */
  readonly logger?: Logger;
  /** Injected for tests; defaults to `require('react-native').AppState`. */
  readonly appState?: AppStateLike;
  /**
   * Budget for the backgrounding flush. Default 2000 ms.
   *
   * Backgrounding is not a crash, but it is the last moment the JS thread is
   * reliably scheduled: iOS may freeze timers immediately afterwards, and an
   * entry still sitting in a 100 ms batch window can wait there until the app
   * is next opened — or be lost if it is killed while suspended.
   */
  readonly deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 2000;

/**
 * States that mean "the JS thread is about to stop being scheduled".
 *
 * Both, not just `background`: iOS passes through `inactive` on the way there,
 * and on some transitions — a phone call, the app switcher — that is as far as
 * it gets. Flushing twice costs nothing, because a flush with nothing pending
 * is a length check on an empty buffer in every destination this library ships.
 */
const LEAVING_FOREGROUND: ReadonlySet<string> = new Set([
  'inactive',
  'background',
]);

/**
 * Flushes every destination when the app leaves the foreground.
 *
 * Returns an idempotent uninstall handle. Removing the listener matters more
 * than it looks: `AppState` outlives any component, so a subscription left
 * behind keeps a disposed logger reachable and flushes it on every transition
 * for the rest of the process.
 */
export function flushOnBackground(
  options?: FlushOnBackgroundOptions
): Uninstall {
  const appState = options?.appState ?? resolveAppState();
  if (!appState) return () => {};

  const logger = options?.logger ?? Log;
  const deadlineMs = budget(options?.deadlineMs);

  let subscription: { remove(): void } | undefined;
  try {
    subscription = appState.addEventListener('change', (state) => {
      if (!LEAVING_FOREGROUND.has(state)) return;
      try {
        logger.flush(deadlineMs);
      } catch {
        // A destination that cannot flush must not throw out of an AppState
        // listener, where React Native has nowhere to put the exception.
      }
    });
  } catch {
    return () => {};
  }

  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    try {
      subscription?.remove();
    } catch {
      // Already gone.
    }
  };
}

/**
 * `AppState` without importing `react-native` at module load.
 *
 * A static import would make this module — and therefore the package entry
 * point — unloadable anywhere React Native is not present, which includes the
 * Node process the unit tests run in.
 *
 * @internal Shared with {@link scheduleMaintenance}; not part of the package's
 * public surface.
 */
export function resolveAppState(): AppStateLike | undefined {
  try {
    const rn = require('react-native') as { AppState?: unknown };
    const candidate = rn.AppState;
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    const add = (candidate as { addEventListener?: unknown }).addEventListener;
    return typeof add === 'function' ? (candidate as AppStateLike) : undefined;
  } catch {
    return undefined;
  }
}

function budget(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(value) || value < 0) return DEFAULT_DEADLINE_MS;
  return value;
}
