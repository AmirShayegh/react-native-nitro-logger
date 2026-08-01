/**
 * The one rule for turning a caller's `deadlineMs` into a budget.
 *
 * Extracted so `Logger.flush` and `Batcher` cannot disagree about what a
 * deadline means. They are the two places that spend one, and a second copy of
 * a clamp is how "the same number" quietly stops being the same number.
 *
 * Not exported from the package barrel: this is an internal contract, and the
 * numbers a caller passes are documented on the methods that take them.
 */

/**
 * The ceiling on any single wait.
 *
 * Every deadline in this library is spent on the JavaScript thread, so an
 * unbounded one is an unresponsive app. Matches the natives' own clamp — see
 * `MAX_DEADLINE_MS` in `LogFileWriter.kt` and `clampDeadline` in
 * `LogFileWriter.swift` — so a value that survives the bridge means the same
 * thing on both sides of it.
 */
export const MAX_DEADLINE_MS = 30_000;

/**
 * A caller's deadline as a usable millisecond budget.
 *
 * Zero for anything meaningless as a wait — a non-number, `NaN`, zero, a
 * negative, `-Infinity` — which is the one answer that is always safe: do what
 * needs no waiting, and do not wait.
 *
 * **`Infinity` is the ceiling, not zero.** It reads as "wait as long as it
 * takes", and zero is the least helpful possible reading of that. It is also
 * what both natives already answer (`clampDeadline` in `LogFileWriter.swift`,
 * the `isInfinite` branch in `LogFileWriter.kt`), and until this moved here the
 * JavaScript side disagreed with them on the same input — a `flush(Infinity)`
 * that waited zero on this side of the bridge and thirty seconds on the other.
 *
 * Floored, because a fractional millisecond is not something any of these waits
 * can honour.
 */
export function clampDeadline(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return 0;
  }
  if (!Number.isFinite(value)) return MAX_DEADLINE_MS;
  return Math.min(Math.floor(value), MAX_DEADLINE_MS);
}

/** How much of a running deadline is left, in milliseconds; never negative. */
export type Deadline = () => number;

/**
 * Begins a deadline and returns its remaining budget on demand.
 *
 * The reading is taken from a **monotonic** clock where the host has one, not
 * from the wall clock. `Date.now()` moves when the device's clock is corrected
 * — NTP, a timezone-less manual change, a leap smear — and a budget computed
 * across two readings of it can be handed backwards time. An hour-backwards
 * correction in the middle of a flush turns a 2-second bound into an
 * hour-and-two-seconds one on the JavaScript thread, and a forwards one ends
 * the flush before it has drained anything. Neither is rare enough to accept on
 * the path that runs while an app is dying.
 *
 * The clock is **captured once per deadline** and held for its lifetime,
 * because `performance.now()` and `Date.now()` count from different origins:
 * mixing the two inside one deadline subtracts an epoch from a stopwatch and
 * gets a budget of roughly fifty years.
 *
 * *Which* clock that is gets resolved once per process — but only once a
 * monotonic one has been found. Until then every deadline probes again, which
 * is what lets a React Native runtime that installs `performance` after this
 * module is imported still be picked up. See {@link resolveClock} for why the
 * memo is one-directional.
 *
 * What is subtracted is **elapsed time floored to whole milliseconds**, not the
 * raw difference. `performance.now()` answers in fractions of a millisecond, and
 * charging a caller 0.003 ms for the microseconds between starting a deadline
 * and asking what is left of it would hand every destination a number like
 * `749.997` — not a deadline anyone can honour, and not one that survives the
 * bridge as anything but a rounding argument. A budget is only reduced once a
 * millisecond has actually gone.
 *
 * That flooring rounds the answer **up**, by design and by strictly less than
 * one millisecond: 0.9 ms into a 750 ms deadline this still says 750, so a
 * chain of cooperative waits can overrun the caller's number by up to a
 * millisecond per reading. Said plainly rather than papered over — the bound is
 * whole-millisecond, not exact, and on a 2-second crash-path flush that is not
 * a cost worth handing every destination a fraction to avoid.
 *
 * **What this does not deliver:** monotonicity on a host that provides no
 * `performance.now`. There the fallback is `Date.now` and the paragraph above
 * describes exactly what a clock correction still does. Every runtime this
 * library supports — Hermes, JSC, and Node for the tests — provides one.
 */
export function startDeadline(deadlineMs: number): Deadline {
  const budget = clampDeadline(deadlineMs);
  // A budget of nothing needs no clock. This is not only a fast path: it is the
  // one case where reading a clock could produce a wait the caller explicitly
  // asked not to have — on a host down the `Date.now` fallback, a backwards
  // correction makes elapsed time negative and `0 - negative` positive. No test
  // covers that, and none can without a seam: every host this suite runs on has
  // a conforming monotonic clock, so the branch is unobservable there. Stated
  // rather than claimed.
  if (budget === 0) return () => 0;

  const read = resolveClock();
  const start = read();
  return () => Math.max(0, budget - Math.floor(read() - start));
}

/**
 * One reading from the same clock {@link startDeadline} counts against.
 *
 * Exported for callers that need to know how long ago something happened
 * rather than how much of a budget is left — `scheduleMaintenance` deciding
 * whether a foreground transition has earned a sweep. They must not reach for
 * `Date.now`: a wall-clock correction between two readings makes an elapsed
 * time that never elapsed, and here that would mean a sweep skipped or
 * doubled on a clock change.
 *
 * Readings are comparable only with each other, and only within a process.
 */
export function monotonicNow(): number {
  return resolveClock()();
}

/**
 * The monotonic clock, once one has been found. Never cleared.
 *
 * Undefined means "not found yet", which is a different statement from "this
 * host has none" — see {@link resolveClock} for why the difference is the
 * whole design of the memo.
 */
let monotonic: (() => number) | undefined;

/**
 * `performance.now` bound to its host, or `Date.now` when there is none.
 *
 * Guarded rather than assumed: a logger must not be the reason a call fails,
 * and a host whose `performance` is a getter that throws is a host this still
 * has to keep a deadline on. A candidate that answers with anything but a
 * finite number is not a clock and is declined.
 *
 * **Memoised on success, and only on success.** The asymmetry is the point,
 * not an oversight:
 *
 * - Finding `performance.now` is a permanent fact about a host. Nothing takes
 *   a runtime's monotonic clock away, so re-deriving it per deadline bought
 *   a property read, an optional call, a `bind` allocation and a probe call
 *   every time — on, among other paths, the flush that runs while the app is
 *   dying and the budget is being counted in milliseconds.
 * - NOT finding one is not permanent. A React Native runtime can install
 *   `performance` after this module is imported, and a host answering
 *   non-finite once may simply not have finished starting up. Remembering the
 *   `Date.now` fallback would freeze the wall clock in for the life of the
 *   process on exactly the hosts that were about to get better, and the
 *   deadline docstring above is a promise about monotonicity. So the fallback
 *   is returned without being recorded, and the next deadline asks again.
 *   `__tests__/deadline.test.ts` pins that directly.
 *
 * **What this does not do:** follow a host that REPLACES `globalThis
 * .performance` after a successful resolution. The function bound from the
 * first one is kept for the life of the process. No runtime this library
 * supports does that, and a clock that has already answered finitely is a
 * worse thing to abandon than to keep.
 */
function resolveClock(): () => number {
  if (monotonic !== undefined) return monotonic;
  try {
    const host = globalThis as { performance?: { now?: () => number } };
    const now = host.performance?.now;
    if (typeof now === 'function') {
      const read = now.bind(host.performance);
      if (Number.isFinite(read())) {
        monotonic = read;
        return read;
      }
    }
  } catch {
    // Not a clock. The wall clock still bounds the wait, just less well.
  }
  return Date.now;
}
