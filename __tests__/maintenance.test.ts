import { FileDestination } from '../src/destinations/FileDestination';
import {
  MINIMUM_MAINTENANCE_INTERVAL_MS,
  scheduleMaintenance,
} from '../src/integrations/maintenance';
import type { MaintainableDestination } from '../src/integrations/maintenance';
import type { AppStateLike } from '../src/integrations/appState';
import { MemoryWriter } from './helpers/MemoryFileSink';

class FakeAppState implements AppStateLike {
  currentState: string | undefined;
  listener: ((state: string) => void) | undefined;
  removed = false;
  /** Refuse to subscribe, the way a host without a working AppState would. */
  addThrows = false;

  constructor(currentState: string | undefined = 'active') {
    this.currentState = currentState;
  }

  addEventListener(
    _type: 'change',
    listener: (state: string) => void
  ): { remove(): void } {
    if (this.addThrows) throw new Error('no AppState here');
    this.listener = listener;
    return {
      remove: () => {
        this.removed = true;
        this.listener = undefined;
      },
    };
  }

  change(state: string): void {
    this.currentState = state;
    this.listener?.(state);
  }
}

/** A destination that only records what it was asked to do. */
class RecordingDestination implements MaintainableDestination {
  readonly sweeps: number[] = [];
  mask = 0;
  throws = false;

  maintain(deadlineMs: number): number {
    this.sweeps.push(deadlineMs);
    if (this.throws) throw new Error('sweep failed');
    return this.mask;
  }
}

function wired(currentState: string | undefined = 'active') {
  return {
    destination: new RecordingDestination(),
    appState: new FakeAppState(currentState),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('scheduleMaintenance — the interval', () => {
  test('sweeps on the interval, not before it', () => {
    const { destination, appState } = wired();
    scheduleMaintenance({ destination, appState, intervalMs: 60_000 });

    // Opening the sink has just swept; app launch is the worst moment to
    // scan a directory, so install does not.
    expect(destination.sweeps).toEqual([]);

    jest.advanceTimersByTime(59_999);
    expect(destination.sweeps).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(destination.sweeps).toEqual([1000]);

    jest.advanceTimersByTime(60_000);
    expect(destination.sweeps).toEqual([1000, 1000]);
  });

  test('the deadline reaches the destination', () => {
    const { destination, appState } = wired();
    scheduleMaintenance({
      destination,
      appState,
      intervalMs: 60_000,
      deadlineMs: 250,
    });

    jest.advanceTimersByTime(60_000);
    expect(destination.sweeps).toEqual([250]);
  });

  test.each([
    ['below the floor', 1000],
    ['zero', 0],
    ['negative', -5],
  ])('an interval %s is raised to the minimum', (_label, asked) => {
    const { destination, appState } = wired();
    scheduleMaintenance({ destination, appState, intervalMs: asked });

    // A sweep lists the directory and stats every archive in it. At the asked
    // interval that would be a background load; the clamp is what stops a
    // caller turning housekeeping into one.
    jest.advanceTimersByTime(MINIMUM_MAINTENANCE_INTERVAL_MS - 1);
    expect(destination.sweeps).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(destination.sweeps).toHaveLength(1);
  });

  test.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('an interval of %s falls back to five minutes', (_label, asked) => {
    const { destination, appState } = wired();
    scheduleMaintenance({ destination, appState, intervalMs: asked });

    jest.advanceTimersByTime(299_999);
    expect(destination.sweeps).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(destination.sweeps).toHaveLength(1);
  });

  test.each([
    ['NaN', Number.NaN],
    ['negative', -1],
  ])('a deadline of %s falls back to one second', (_label, asked) => {
    const { destination, appState } = wired();
    scheduleMaintenance({
      destination,
      appState,
      intervalMs: 60_000,
      deadlineMs: asked,
    });

    jest.advanceTimersByTime(60_000);
    expect(destination.sweeps).toEqual([1000]);
  });

  test('a deadline of zero is honoured, not replaced', () => {
    const { destination, appState } = wired();
    scheduleMaintenance({
      destination,
      appState,
      intervalMs: 60_000,
      deadlineMs: 0,
    });

    // Zero is a legitimate ask: enqueue the sweep and do not wait for it.
    jest.advanceTimersByTime(60_000);
    expect(destination.sweeps).toEqual([0]);
  });
});

describe('scheduleMaintenance — the foreground', () => {
  test('leaving the foreground stops the interval', () => {
    const { destination, appState } = wired();
    scheduleMaintenance({ destination, appState, intervalMs: 60_000 });

    appState.change('background');
    jest.advanceTimersByTime(600_000);

    expect(destination.sweeps).toEqual([]);
  });

  test.each(['background', 'inactive'])(
    'returning from %s sweeps once and restarts the interval',
    (away) => {
      const { destination, appState } = wired();
      scheduleMaintenance({ destination, appState, intervalMs: 60_000 });

      appState.change(away);
      jest.advanceTimersByTime(600_000);
      expect(destination.sweeps).toEqual([]);

      // An interval frozen for ten minutes has ten minutes of expired
      // archives waiting; waiting a further minute for the next tick would be
      // an odd way to spend them.
      appState.change('active');
      expect(destination.sweeps).toHaveLength(1);

      jest.advanceTimersByTime(60_000);
      expect(destination.sweeps).toHaveLength(2);
    }
  );

  test('a repeated active does not buy a second catch-up sweep', () => {
    const { destination, appState } = wired();
    scheduleMaintenance({ destination, appState, intervalMs: 60_000 });

    appState.change('background');
    appState.change('active');
    expect(destination.sweeps).toHaveLength(1);

    // `AppState` can report the state it is already in. Acting on the state
    // rather than on the transition would sweep every time it did, and would
    // also start a second interval on top of the first.
    appState.change('active');
    appState.change('active');
    expect(destination.sweeps).toHaveLength(1);

    jest.advanceTimersByTime(60_000);
    expect(destination.sweeps).toHaveLength(2);
  });

  test('installed while backgrounded, it waits for the foreground', () => {
    const { destination } = wired();
    const appState = new FakeAppState('background');
    scheduleMaintenance({ destination, appState, intervalMs: 60_000 });

    jest.advanceTimersByTime(600_000);
    expect(destination.sweeps).toEqual([]);

    appState.change('active');
    expect(destination.sweeps).toHaveLength(1);
  });

  test('an AppState that does not report its state is taken as foreground', () => {
    const { destination } = wired();
    const appState = new FakeAppState(undefined);
    scheduleMaintenance({ destination, appState, intervalMs: 60_000 });

    // The first `change` corrects it, and starting the timer then pausing it
    // shortly after is the harmless direction to be wrong in.
    jest.advanceTimersByTime(60_000);
    expect(destination.sweeps).toHaveLength(1);
  });

  test('a runtime with no AppState just runs the interval', () => {
    const destination = new RecordingDestination();
    const stop = scheduleMaintenance({
      destination,
      appState: undefined,
      intervalMs: 60_000,
    });

    jest.advanceTimersByTime(120_000);
    expect(destination.sweeps).toHaveLength(2);

    stop();
    jest.advanceTimersByTime(120_000);
    expect(destination.sweeps).toHaveLength(2);
  });

  test('an AppState that refuses to subscribe still runs the interval', () => {
    const { destination, appState } = wired();
    appState.addThrows = true;
    scheduleMaintenance({ destination, appState, intervalMs: 60_000 });

    jest.advanceTimersByTime(60_000);
    expect(destination.sweeps).toHaveLength(1);
  });

  test('a refused subscription off-foreground still runs the interval', () => {
    const { destination } = wired();
    const appState = new FakeAppState('background');
    appState.addThrows = true;
    scheduleMaintenance({ destination, appState, intervalMs: 60_000 });

    // The two halves of the pause depend on each other: the interval is not
    // started because the app looks backgrounded, and it is started later by
    // the listener. Losing the listener without giving the interval back leaves
    // a schedule that never sweeps, for the life of the process, silently — the
    // one failure worse than sweeping while backgrounded.
    jest.advanceTimersByTime(60_000);
    expect(destination.sweeps).toHaveLength(1);
  });
});

describe('scheduleMaintenance — uninstall', () => {
  test('stops the interval and removes the subscription', () => {
    const { destination, appState } = wired();
    const stop = scheduleMaintenance({
      destination,
      appState,
      intervalMs: 60_000,
    });

    jest.advanceTimersByTime(60_000);
    expect(destination.sweeps).toHaveLength(1);

    stop();
    jest.advanceTimersByTime(600_000);
    expect(destination.sweeps).toHaveLength(1);
    expect(appState.removed).toBe(true);
    expect(appState.listener).toBeUndefined();
  });

  test('is idempotent', () => {
    const { destination, appState } = wired();
    const stop = scheduleMaintenance({
      destination,
      appState,
      intervalMs: 60_000,
    });

    stop();
    expect(() => stop()).not.toThrow();
    jest.advanceTimersByTime(600_000);
    expect(destination.sweeps).toEqual([]);
  });

  test('a late foreground transition cannot restart a stopped schedule', () => {
    const { destination, appState } = wired();
    const stop = scheduleMaintenance({
      destination,
      appState,
      intervalMs: 60_000,
    });

    // Captured before the uninstall drops it. `remove()` is the first line of
    // defence and this test deliberately walks around it: an AppState that
    // ignores `remove`, or an event already dispatched when it ran, must not
    // be able to revive a schedule the caller has stopped.
    const listener = appState.listener;
    expect(listener).toBeDefined();

    appState.change('background');
    stop();

    listener?.('active');
    jest.advanceTimersByTime(600_000);
    expect(destination.sweeps).toEqual([]);
  });
});

describe('scheduleMaintenance — against a real destination', () => {
  test('the sweep reaches the sink and its findings reach degradation()', () => {
    const writer = new MemoryWriter();
    const sink = writer.attach();
    const destination = new FileDestination(sink, { flushIntervalMs: 100 });
    const stop = scheduleMaintenance({
      destination,
      appState: new FakeAppState(),
      intervalMs: 60_000,
    });

    sink.onMaintain = () => {
      writer.degraded = 0b100;
    };
    expect(destination.degradation()).toBe(0);

    jest.advanceTimersByTime(60_000);
    expect(sink.maintainCalls).toEqual([1000]);
    expect(destination.degradation()).toBe(0b100);

    stop();
    destination.dispose();
  });

  test('a destination that throws does not take the timer down with it', () => {
    const destination = new RecordingDestination();
    destination.throws = true;
    scheduleMaintenance({
      destination,
      appState: new FakeAppState(),
      intervalMs: 60_000,
    });

    // `FileDestination.maintain` does not throw, but the option is structural
    // and a foreign one can. A throw out of a timer callback has nowhere to go.
    expect(() => jest.advanceTimersByTime(180_000)).not.toThrow();
    expect(destination.sweeps).toHaveLength(3);
  });
});
