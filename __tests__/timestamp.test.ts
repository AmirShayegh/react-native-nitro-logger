import { formatTime } from '../src/formatters/timestamp';

/**
 * `formatTime` against the straightforward implementation it replaced.
 *
 * Since 0.4.0 everything but the milliseconds is cached for the whole second
 * it belongs to, which is a real behaviour change to a function that used to
 * be four getters and four pads. `defaultFormatter.test.ts` pins one instant
 * — `12:15:30.842` — and would pass just as well against a function that
 * computed the second once and then never again.
 *
 * The reference below is that former implementation, verbatim. Comparing
 * against it rather than against written-out strings keeps every case here
 * independent of the machine's time zone, which is what makes it safe to
 * assert on local time at all.
 *
 * ## What this does NOT prove
 *
 * That the cache is ever HIT. Nothing observable distinguishes a memo from a
 * function that recomputes every time, which is the whole point of it being a
 * memo; the benchmark is what says it pays. These prove only that it never
 * answers with the wrong second.
 */
function reference(epochMs: number): string {
  const date = new Date(epochMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

describe('formatTime', () => {
  const noon = new Date(2026, 6, 27, 12, 15, 30, 0).getTime();

  test('renders the shape the console layout is built around', () => {
    expect(formatTime(noon + 842)).toBe('12:15:30.842');
    expect(formatTime(noon + 842)).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d$/);
  });

  test('every millisecond of a second keeps its own three digits', () => {
    // The padding moved out of `padStart` and into a comparison, so 7 must
    // still render `.007` and 70 `.070`. Sweeping the second covers both
    // widths and the unpadded majority together.
    for (let ms = 0; ms < 1000; ms += 1) {
      expect(formatTime(noon + ms)).toBe(reference(noon + ms));
    }
  });

  test('the second rolls over when the entry does', () => {
    expect(formatTime(noon + 999)).toBe('12:15:30.999');
    expect(formatTime(noon + 1000)).toBe('12:15:31.000');
    expect(formatTime(noon + 1001)).toBe('12:15:31.001');
  });

  test('a minute and an hour boundary are still the cached second changing', () => {
    const beforeMinute = new Date(2026, 6, 27, 12, 15, 59, 900).getTime();
    expect(formatTime(beforeMinute)).toBe(reference(beforeMinute));
    expect(formatTime(beforeMinute + 100)).toBe(reference(beforeMinute + 100));

    const beforeHour = new Date(2026, 6, 27, 12, 59, 59, 900).getTime();
    expect(formatTime(beforeHour)).toBe(reference(beforeHour));
    expect(formatTime(beforeHour + 100)).toBe(reference(beforeHour + 100));
  });

  test('interleaved seconds never hand one entry another entry cached head', () => {
    // Entries arriving out of order across a boundary, which a batch flush
    // and two destinations both produce. Repeated so a cache that updates on
    // the wrong side of its check cannot alternate its way to a pass.
    const instants = [noon + 500, noon + 1500, noon - 500, noon + 60_000, 0];
    for (let round = 0; round < 3; round += 1) {
      for (const instant of instants) {
        expect(formatTime(instant)).toBe(reference(instant));
      }
    }
  });

  test('a pre-1970 instant floors to its second instead of truncating', () => {
    // Dividing toward zero puts a NEGATIVE remainder in the millisecond
    // field, which would render as `.-500`.
    for (const instant of [-1, -999, -1000, -1500, -86_400_000 - 1]) {
      expect(formatTime(instant)).toBe(reference(instant));
      expect(formatTime(instant)).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d$/);
    }
  });

  test('a fractional timestamp is the instant Date would have made of it', () => {
    for (const instant of [1.7, -1.7, noon + 0.9, noon + 999.999]) {
      expect(formatTime(instant)).toBe(reference(instant));
    }
  });

  test('an unrenderable instant degrades exactly as it always did', () => {
    // Not a contract worth defending, but a change worth noticing: these
    // produced `NaN:NaN:NaN.NaN` before and still do. A console formatter
    // that threw here would take down the log call reporting the problem.
    for (const instant of [NaN, Infinity, -Infinity, 1e18, -1e18]) {
      expect(() => formatTime(instant)).not.toThrow();
      expect(formatTime(instant)).toBe(reference(instant));
    }
  });

  test('a bad instant does not poison the next good one', () => {
    // The cache key is compared with `!==`, and `NaN !== NaN`, so an
    // unrenderable instant can never be stored as a hit for anything.
    expect(formatTime(noon + 100)).toBe(reference(noon + 100));
    expect(formatTime(NaN)).toBe(reference(NaN));
    expect(formatTime(noon + 100)).toBe('12:15:30.100');
    expect(formatTime(Infinity)).toBe(reference(Infinity));
    expect(formatTime(noon + 200)).toBe('12:15:30.200');
  });
});
