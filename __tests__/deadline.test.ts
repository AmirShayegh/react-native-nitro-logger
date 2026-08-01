/**
 * `src/deadline.ts` — the shared rule for turning a caller's `deadlineMs`
 * into a budget, and the clock that budget is spent against.
 *
 * The module had no suite of its own before 0.4.0. It was exercised
 * incidentally through `Logger.flush` and `Batcher`, which is enough to notice
 * it throwing and not enough to notice either of the two things it actually
 * promises: that `Infinity` means the ceiling rather than zero (a claim about
 * agreeing with both natives), and that a host which gains a monotonic clock
 * late is still picked up.
 *
 * The second of those became load-bearing in 0.4.0, when `resolveClock`
 * started memoising. A memo that also remembered the `Date.now` FALLBACK would
 * pass every other test in this repository while quietly freezing the wall
 * clock in for the life of the process — on exactly the hosts the re-probe
 * exists for, and with the failure showing up only when someone's device clock
 * is corrected mid-flush. So it is pinned here directly.
 */
import { MAX_DEADLINE_MS, clampDeadline } from '../src/deadline';

/**
 * Replace `globalThis.performance` and hand back the undo.
 *
 * The descriptor is captured and restored rather than the value: in Node this
 * global is an accessor pair, so assigning over it and assigning back is not
 * the same shape it started as.
 */
function replacePerformance(
  replacement: PropertyDescriptor | null
): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const restore = () => {
    if (original === undefined) {
      delete (globalThis as { performance?: unknown }).performance;
    } else {
      Object.defineProperty(globalThis, 'performance', original);
    }
  };
  if (replacement === null) {
    delete (globalThis as { performance?: unknown }).performance;
  } else {
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      enumerable: true,
      ...replacement,
    });
  }
  return restore;
}

/** A `performance`-shaped object whose `now` counts how often it was read. */
function countingClock() {
  const state = { calls: 0 };
  return {
    state,
    value: {
      now: () => {
        state.calls += 1;
        return 5;
      },
    },
  };
}

/**
 * A fresh copy of the module, so the process-lifetime memo starts empty.
 *
 * Every test here is about what the memo does on its FIRST resolution, which
 * is a state the module only has once. Sharing one copy across tests would
 * make each test's result depend on the order the others ran in.
 */
function freshStartDeadline(): (ms: number) => () => number {
  jest.resetModules();
  return (require('../src/deadline') as typeof import('../src/deadline'))
    .startDeadline;
}

afterEach(() => {
  jest.resetModules();
});

describe('clampDeadline', () => {
  test('Infinity is the ceiling, not zero', () => {
    // The reading both natives already give it — `clampDeadline` in
    // LogFileWriter.swift and the `isInfinite` branch in LogFileWriter.kt.
    // Before this rule moved into one place the JS side answered zero, so a
    // `flush(Infinity)` waited nothing here and thirty seconds there.
    expect(clampDeadline(Infinity)).toBe(MAX_DEADLINE_MS);
  });

  test('a value past the ceiling is clamped to it', () => {
    expect(clampDeadline(MAX_DEADLINE_MS + 1)).toBe(MAX_DEADLINE_MS);
    expect(clampDeadline(10_000_000)).toBe(MAX_DEADLINE_MS);
  });

  test('everything meaningless as a wait is zero', () => {
    for (const value of [0, -1, -Infinity, NaN]) {
      expect(clampDeadline(value)).toBe(0);
    }
    for (const value of ['500', null, undefined, {}, []]) {
      expect(clampDeadline(value as never)).toBe(0);
    }
  });

  test('a fractional millisecond is floored, never rounded up', () => {
    expect(clampDeadline(1.9)).toBe(1);
    expect(clampDeadline(0.9)).toBe(0);
  });
});

describe('the clock a deadline is spent against', () => {
  test('a host that installs performance late is still picked up', () => {
    // THE guard on the 0.4.0 memo. The first deadline finds no monotonic
    // clock and must not remember that; the second must see the one that
    // turned up in between. A memo that cached the fallback fails only here.
    const undoMissing = replacePerformance(null);
    try {
      const startDeadline = freshStartDeadline();
      expect(startDeadline(1000)()).toBeLessThanOrEqual(1000);

      const clock = countingClock();
      const undoInstalled = replacePerformance({ value: clock.value });
      try {
        startDeadline(1000)();
        expect(clock.state.calls).toBeGreaterThan(0);
      } finally {
        undoInstalled();
      }
    } finally {
      undoMissing();
    }
  });

  test('a clock already found is kept, even if the host takes it away', () => {
    // The stated limit of the memo, pinned so it is a decision rather than a
    // surprise: resolution is one-directional. Nothing this library supports
    // swaps out `performance`, and a clock that has answered finitely is a
    // worse thing to abandon than to keep.
    const clock = countingClock();
    const undo = replacePerformance({ value: clock.value });
    try {
      const startDeadline = freshStartDeadline();
      startDeadline(1000)();
      const afterFirst = clock.state.calls;
      expect(afterFirst).toBeGreaterThan(0);

      const undoRemoved = replacePerformance(null);
      try {
        startDeadline(1000)();
        expect(clock.state.calls).toBeGreaterThan(afterFirst);
      } finally {
        undoRemoved();
      }
    } finally {
      undo();
    }
  });

  test('a performance getter that throws is declined, and not remembered', () => {
    // The fresh copy is taken BEFORE the hostile getter is installed, because
    // `jest.resetModules()` reads `globalThis.performance` itself and would
    // otherwise be the thing that throws. The module reads no clock until
    // `startDeadline` is called, so requiring it early costs nothing.
    const startDeadline = freshStartDeadline();
    const undoHostile = replacePerformance({
      get() {
        throw new Error('hostile host');
      },
    });
    try {
      // A logger must not be the reason a call fails.
      expect(startDeadline(1000)()).toBeLessThanOrEqual(1000);

      const clock = countingClock();
      const undoInstalled = replacePerformance({ value: clock.value });
      try {
        startDeadline(1000)();
        expect(clock.state.calls).toBeGreaterThan(0);
      } finally {
        undoInstalled();
      }
    } finally {
      undoHostile();
    }
  });

  test('a clock that answers non-finite is declined, and not remembered', () => {
    const undoNaN = replacePerformance({ value: { now: () => NaN } });
    try {
      const startDeadline = freshStartDeadline();
      // Had the NaN clock been accepted, the budget would be NaN, not a
      // number a destination can honour.
      const remaining = startDeadline(1000)();
      expect(Number.isFinite(remaining)).toBe(true);

      const clock = countingClock();
      const undoInstalled = replacePerformance({ value: clock.value });
      try {
        startDeadline(1000)();
        expect(clock.state.calls).toBeGreaterThan(0);
      } finally {
        undoInstalled();
      }
    } finally {
      undoNaN();
    }
  });

  test('a budget of nothing reads no clock at all', () => {
    // Not only a fast path: on a host down the `Date.now` fallback, a
    // backwards clock correction makes elapsed time negative, and
    // `0 - negative` is a wait the caller explicitly asked not to have.
    const clock = countingClock();
    const undo = replacePerformance({ value: clock.value });
    try {
      const startDeadline = freshStartDeadline();
      expect(startDeadline(0)()).toBe(0);
      expect(clock.state.calls).toBe(0);
    } finally {
      undo();
    }
  });
});

describe('createElapsed', () => {
  /** A fresh copy, so the process-lifetime clock memo starts empty. */
  function freshCreateElapsed(): typeof import('../src/deadline').createElapsed {
    jest.resetModules();
    return (require('../src/deadline') as typeof import('../src/deadline'))
      .createElapsed;
  }

  /** A `performance`-shaped object whose reading the test can move. */
  function movableClock(at: number) {
    const state = { now: at };
    return { state, value: { now: () => state.now } };
  }

  test('a host that gains performance.now mid-life re-anchors onto it', () => {
    // The failure this exists for: `resolveClock` memoises on SUCCESS only, so
    // a process that starts without `performance.now` keeps answering from
    // `Date.now` until the host installs one. Those are different timebases —
    // epoch milliseconds against process-relative milliseconds — and a value
    // taken before the upgrade minus one taken after is roughly minus
    // fifty-five years. As a `setTimeout` delay that overflows to a timer
    // which fires immediately or never.
    const restore = replacePerformance(null);
    try {
      const createElapsed = freshCreateElapsed();
      const elapsed = createElapsed(); // anchored on Date.now

      const clock = movableClock(5);
      const restoreClock = replacePerformance({ value: clock.value });
      try {
        // Nothing comparable to report across the change.
        expect(elapsed.sinceAnchor()).toBe(0);

        // The assertion that matters, and the one a bare `Math.max(0, ...)`
        // cannot satisfy: the anchor has MOVED onto the new clock, so time
        // measured after the upgrade is real. Clamping a stale epoch-based
        // anchor would answer 0 here for the next fifty-five years.
        clock.state.now = 1005;
        expect(elapsed.sinceAnchor()).toBe(1000);
      } finally {
        restoreClock();
      }
    } finally {
      restore();
    }
  });

  test('a clock that goes backwards reports no time rather than negative', () => {
    // Same clock throughout — this is a correction, not an upgrade, so the
    // re-anchor above does not fire and the clamp is what answers. A negative
    // here becomes a LONGER wait: `intervalMs - (-600)` overshoots the
    // schedule instead of catching up.
    const clock = movableClock(1000);
    const restore = replacePerformance({ value: clock.value });
    try {
      const createElapsed = freshCreateElapsed();
      const elapsed = createElapsed();
      clock.state.now = 400;
      expect(elapsed.sinceAnchor()).toBe(0);
    } finally {
      restore();
    }
  });

  test('an ordinary reading is the time that actually passed', () => {
    const clock = movableClock(1000);
    const restore = replacePerformance({ value: clock.value });
    try {
      const createElapsed = freshCreateElapsed();
      const elapsed = createElapsed();
      clock.state.now = 2500;
      expect(elapsed.sinceAnchor()).toBe(1500);
      elapsed.anchor();
      expect(elapsed.sinceAnchor()).toBe(0);
      clock.state.now = 2900;
      expect(elapsed.sinceAnchor()).toBe(400);
    } finally {
      restore();
    }
  });
});
