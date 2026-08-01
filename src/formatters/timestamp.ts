/**
 * Local-time `HH:mm:ss.SSS`, matching SwiftLogger's console timestamp.
 *
 * Takes epoch milliseconds (see `LogEntry.timestamp`). Everything but the
 * milliseconds is cached for the whole second it belongs to, which is what
 * the reference implementation does and for the same reason: four UTC-to-local
 * conversions and four zero-pads per entry measured 264 ns, about 15% of
 * `DefaultFormatter.format()`, and Hermes resolves the local zone per getter.
 *
 * The comment that used to sit here said none of the Swift version's caching
 * was needed because these getters are cheap in JS. That was a guess, and it
 * was wrong on the engine that ships.
 *
 * ## Why a UTC second is the right key for a LOCAL time
 *
 * The key is the whole second since the epoch — a UTC quantity — while the
 * value is local text. That works because a fixed offset maps one UTC second
 * onto exactly one local second, whatever the offset is. It does not have to
 * be a whole number of minutes: the pre-1970 local-mean-time offsets that
 * carry seconds are just as fine, because the mapping is still one-to-one.
 *
 * What the key cannot see is the offset CHANGING inside one second. A DST
 * transition happens on a second boundary, so the key invalidates itself
 * there. The residual is a host changing its system zone mid-second, which
 * shows the previous zone for less than one second — the Swift implementation
 * this mirrors caches for fifteen minutes and accepts far more.
 */

/** The whole second {@link head} was rendered for. `NaN` matches nothing. */
let second = NaN;

/** `HH:mm:ss.` for that second, in whatever the local zone was. */
let head = '';

/**
 * Whether that second was an instant `Date` could represent at all.
 *
 * Kept because the milliseconds are no longer read from the `Date` and so no
 * longer go `NaN` on their own. `1e18` floors to a whole second of `1e18`, so
 * the subtraction below yields a perfectly ordinary `0` — and a console line
 * reading `NaN:NaN:NaN.000` claims a precision it does not have. This is not
 * a contract anyone should rely on; it is a degradation that was one shape
 * before and is kept that shape on purpose.
 */
let representable = false;

/** Two digits, without allocating a padded copy of a one-digit string. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

export function formatTime(epochMs: number): string {
  // `Math.trunc` first because the `Date` constructor does, so a fractional
  // input cannot leave a fraction in the millisecond field; `Math.floor` for
  // the split because dividing toward zero would give a negative remainder
  // before 1970 and render `.-500`.
  const instant = Math.trunc(epochMs);
  const whole = Math.floor(instant / 1000);
  if (whole !== second) {
    const date = new Date(whole * 1000);
    representable = !Number.isNaN(date.getTime());
    head = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
      date.getSeconds()
    )}.`;
    second = whole;
  }
  if (!representable) return `${head}NaN`;
  const ms = instant - whole * 1000;
  return `${head}${ms < 10 ? '00' : ms < 100 ? '0' : ''}${ms}`;
}
