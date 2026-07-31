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
