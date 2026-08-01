import type {
  LogEntry,
  LogLevel,
  LogPrimitive,
  RedactedMetadata,
} from '../types';
import type { LogFormatter } from './types';
import { LEVEL_NAME } from '../levels';
import { utf8Length } from '../utf8';

export { utf8Length };

/**
 * How the `timestamp` field renders.
 *
 * `iso8601` is UTC with milliseconds — `2026-07-27T12:15:30.842Z` — and is
 * what the SwiftLogger goldens are written against. `epochSeconds` emits a
 * JSON number of seconds, for aggregators that would only parse the string
 * back again.
 */
export type JsonTimestampStyle = 'iso8601' | 'epochSeconds';

export interface JsonLinesFormatterOptions {
  readonly timestampStyle?: JsonTimestampStyle;
}

/**
 * Instants JavaScript can represent as a Date but not as ISO 8601.
 *
 * A whole number of seconds, which {@link isoTimestampJson} relies on: an
 * in-range instant floored to its own second cannot land outside the range.
 */
const MAX_ISO_MS = 8.64e15;

/**
 * Level names pre-quoted, once, at module load.
 *
 * Derived from {@link LEVEL_NAME} rather than written out a second time, so
 * the two cannot drift — a level added in `levels.ts` gets its JSON form here
 * with no second edit — and quoted by `JSON.stringify` rather than by
 * splicing, so nothing rests on an argument about what those names contain.
 */
const LEVEL_JSON = Object.fromEntries(
  Object.entries(LEVEL_NAME).map(([level, name]) => [
    level,
    JSON.stringify(name),
  ])
) as Record<LogLevel, string>;

/*
 * ## The memos below, and why they are not the state `LogFormatter` forbids
 *
 * A section note rather than a doc comment: it belongs to the three caches
 * together, and attaching it to whichever one happens to be declared first
 * would say it was about that one.
 *
 * `formatters/types.ts` requires that a formatter "must not carry state that
 * later records depend on", because a formatter counting its own calls is
 * counting the wrong sequence — plenty of entries are formatted and never
 * written. The caches here are not that kind of state. Each holds the last
 * result of a pure function together with the input it came from, and each
 * checks that input before using the result. What a record *says* is still
 * derived entirely from the entry it was given: delete every memo and every
 * byte is unchanged. That is the property the rule protects, and it survives.
 *
 * They are module-level rather than per-instance deliberately. One process
 * commonly holds two `JsonLinesFormatter`s — a file destination and a native
 * console one — which see the same entry a moment apart, and a shared slot
 * turns the second rendering of it into three hits instead of three misses.
 *
 * One slot each, never a Map. `subsystem` and `correlation` are
 * caller-supplied strings, and a cache of those that grows is a retention
 * surface in a package whose whole thesis is that caller-supplied strings are
 * where the leak is. One slot retains one string — the one the most recent
 * entry was already carrying.
 */

/** The whole second {@link isoHead} was rendered for. `NaN` matches nothing. */
let isoSecond = NaN;

/** `"YYYY-MM-DDTHH:MM:SS.` — everything before the milliseconds. */
let isoHead = '';

/**
 * `"2026-07-27T12:15:30.842Z"`, quoted and ready to splice into a record.
 *
 * `new Date(ms).toISOString()` measured ~26% of `format()`, and every entry
 * logged within the same second shares all of its answer but the last three
 * digits. So the second is rendered on a miss, and the milliseconds are
 * appended on every call.
 *
 * Three details are load-bearing:
 *
 * **`Math.trunc` first, because the `Date` constructor does.** `new Date(1.7)`
 * is the same instant as `new Date(1)`. Without this, a fractional timestamp
 * — nothing in this package produces one, but `LogEntry.timestamp` is a plain
 * number and a hand-built entry can — would put a fraction in the millisecond
 * field, where `Date` would have discarded it.
 *
 * **The seconds split is a floor, not a division toward zero.** `-1500` is
 * `1969-12-31T23:59:58.500Z`: second `-2`, millisecond `500`. Truncating
 * toward zero gives second `-1` and millisecond `-500`, which renders as
 * `59.-500`. The `epoch-before-1970` golden is exactly this case.
 *
 * **The head is `JSON.stringify`'s own output, cut from the end.** Taking
 * `slice(0, -5)` off the quoted form drops `SSSZ"` and keeps the opening
 * quote, so an expanded-year instant (`"+275760-09-13T…`, which `MAX_ISO_MS`
 * admits) moves the cut rather than breaking it — and no claim about which
 * characters JSON escapes is needed anywhere, because nothing here re-quotes
 * a string.
 */
function isoTimestampJson(epochMs: number): string {
  const instant = Math.trunc(epochMs);
  const second = Math.floor(instant / 1000);
  if (second !== isoSecond) {
    const quoted = JSON.stringify(new Date(second * 1000).toISOString());
    isoHead = quoted.slice(0, -5);
    isoSecond = second;
  }
  const ms = instant - second * 1000;
  const pad = ms < 10 ? '00' : ms < 100 ? '0' : '';
  return `${isoHead}${pad}${ms}Z"`;
}

/**
 * A one-slot memo over `JSON.stringify` of a string.
 *
 * A factory rather than two hand-written pairs of variables so that "one
 * slot, checked by strict equality, holding one caller string" is written
 * once. Two separate slots rather than one shared one because a record
 * carrying both fields would otherwise evict itself twice per entry — a
 * performance point and only that: crossing the two callers below renders
 * byte-identical output, verified by mutation, because each miss recomputes.
 * No test can pin the separation, so this comment is the only record of it.
 *
 * A miss costs one string comparison on top of the `stringify` it was going
 * to do anyway, which is the whole downside for a correlation ID that changes
 * every request.
 */
function oneSlotJson(): (value: string) => string {
  let key: string | undefined;
  let json = '';
  return (value) => {
    if (value !== key) {
      json = JSON.stringify(value);
      key = value;
    }
    return json;
  };
}

const correlationJson = oneSlotJson();
const subsystemJson = oneSlotJson();

/** Opens the metadata object. Written once so `formatWithin` can cost it. */
const METADATA_OPEN = ',"metadata":{';

/** …and the brace that closes it, which nothing else accounts for. */
const METADATA_FRAME_BYTES = METADATA_OPEN.length + 1;

/**
 * The largest code-point boundary at or below `index`, in UTF-16 units.
 *
 * `formatWithin` searches for the longest message prefix that fits, and it
 * must only ever consider prefixes that end on a whole code point. That is
 * not merely a tidiness rule about not splitting an emoji: **the byte cost of
 * a prefix is not monotonic across a surrogate pair.** Cutting `"🙂"` after
 * its high half leaves a lone surrogate, which `JSON.stringify` writes as the
 * six characters `\ud83d` — so the shorter prefix renders as EIGHT bytes
 * where the longer one renders as six. A binary search over raw unit indices
 * would be searching a function that goes back down, and could return a
 * prefix longer than the budget it was given.
 *
 * Restricted to boundaries the cost is monotone, which is what makes the
 * search valid. A lone low surrogate with no high before it is itself a
 * boundary: it has no partner to be half of, and gets escaped on its own.
 */
function boundaryAtOrBelow(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index);
  if (code < 0xdc00 || code > 0xdfff) return index;
  const previous = text.charCodeAt(index - 1);
  return previous >= 0xd800 && previous <= 0xdbff ? index - 1 : index;
}

/**
 * One JSON object per line, matching SwiftLogger's `JSONLogFormatter`.
 *
 * Keys come out in a fixed order — `timestamp`, `level`, `message`, then the
 * optional `correlation`, `subsystem`, and `metadata` — so that output diffs
 * cleanly and goldens are stable. Absent optionals are omitted rather than
 * written as null, and metadata values keep their JSON type.
 *
 * Metadata keys are sorted, which is also why the object is assembled by hand
 * rather than handed to `JSON.stringify`. JavaScript orders integer-like
 * string keys before all others, so `JSON.stringify({ b: 1, '2': 2 })` puts
 * `2` first no matter what order the keys went in. A metadata key is whatever
 * the caller wrote, `'2'` included, and the Swift side sorts every key the
 * same way.
 *
 * See `docs/PARITY.md` for the field-by-field comparison, including the three
 * fields this formatter deliberately does not emit.
 */
export class JsonLinesFormatter implements LogFormatter {
  /**
   * **LF-delimited record boundaries remain intact.** `JSON.stringify` escapes
   * U+0000–U+001F, so no U+000A can appear inside a record, and native
   * crash-tail trimming can always tell where one ends.
   *
   * That is the whole of the guarantee, and it is narrower than "every control
   * character is escaped", which this used to claim and which is not true.
   * U+007F–U+009F — U+0085 NEL among them — and U+2028/U+2029 pass through as
   * themselves. JSON permits that, and these bytes are asserted identical to
   * SwiftLogger's `JSONLogFormatter` over a generated corpus, so escaping them
   * here would be a parity break rather than a fix. `DefaultFormatter` does
   * escape all of them; it has no golden to match.
   *
   * The consumer obligation that follows: **split on LF and parse each JSON
   * value before applying any line-oriented presentation logic.** A reader that
   * applies JavaScript line semantics to the raw file first — `^`/`$` under
   * `m`, `split(/^/m)`, a viewer that reflows on Unicode line separators — can
   * be shown apparent records that were never written, because a message value
   * may contain U+2028. Parse first and it is impossible: the separator is one
   * more character inside a string.
   */
  readonly framing = 'line' as const;

  private readonly timestampStyle: JsonTimestampStyle;

  constructor(options: JsonLinesFormatterOptions = {}) {
    this.timestampStyle = options.timestampStyle ?? 'iso8601';
  }

  format(entry: LogEntry): string {
    return this.render(entry, entry.message, entry.metadata, false);
  }

  /**
   * Render within a byte budget, shedding content in a fixed order rather
   * than slicing the finished string.
   *
   * Cutting a JSON record to length produces something no parser will accept,
   * and a log line that cannot be parsed is worth less than one that is
   * honestly incomplete. So: drop metadata from the end of sorted key order,
   * then shorten the message, and mark the result `"truncated":true` either
   * way. A reader can tell the difference between a short message and a
   * shortened one.
   *
   * The budget counts UTF-8 bytes, because that is what the sink reserves.
   * An unpaired surrogate never distorts the count here: `JSON.stringify` has
   * already turned it into a six-character `\udXXX` escape by the time
   * anything is measured.
   *
   * ## Why this is arithmetic rather than rendering
   *
   * Every candidate is the same record with a different middle. Rendering
   * each one and measuring it whole was quadratic on the metadata path — one
   * full render and one full byte count per key dropped — which cost 243 µs
   * for a 40-key entry at a 400-byte budget, on the main thread, for exactly
   * the shape a crash-handler stack trace arrives in. So candidates are
   * COSTED by adding up numbers. Once the full record above has been rendered
   * and found too big, choosing among the candidates costs exactly two more
   * renders however many there are: one of an empty record, to learn the
   * fixed cost, and one of the winner. Three per truncated entry in total.
   *
   * **That addition is exact, and here is why.** UTF-8 length is additive
   * over concatenation unless the join splits a surrogate pair — the pair
   * costs 4 bytes together and 3 + 3 apart, so `utf8Length(a) + utf8Length(b)`
   * would be 2 too many. It cannot happen here: every quantity being added
   * covers a whole number of JSON tokens, and a JSON token ends with `"`, a
   * digit, the `e` of `true`/`false`, or a brace — all ASCII. No pair can
   * straddle a join when nothing being joined ends mid-pair.
   *
   * Note what this argument does NOT rest on: that records contain no
   * surrogates. They routinely do — any astral character in a message or a
   * metadata value is a surrogate PAIR in the rendered record, passed through
   * unescaped. What matters is that the pairs sit strictly inside the
   * quantities being summed, never across them.
   *
   * When even an empty message will not fit, the result comes back OVER
   * budget: it is the smallest record that still identifies the entry, which
   * is not quite the same as the smallest record possible. `correlation` and
   * `subsystem` survive, because an entry no one can place is worth less than
   * a short one — dropping them would save bytes and leave a line that says
   * nothing about where it came from. Callers deciding whether an entry is
   * renderable at all must therefore measure the result rather than assume it
   * fits.
   */
  formatWithin(entry: LogEntry, maxBytes: number): string {
    const full = this.format(entry);
    if (utf8Length(full) <= maxBytes) return full;

    // The record with nothing in it — no message, no metadata — rendered by
    // the same method that renders every answer below. Its length is the
    // fixed cost of this entry: the timestamp, the level, the tags, the
    // truncation flag and all the punctuation. Minus two, for the quotes
    // around the empty message it does contain.
    //
    // Deriving it this way rather than assembling the pieces here is the
    // whole reason `render` is untouched by this method: a second description
    // of the record's shape, exercised only by budget tests, is exactly the
    // kind of thing that drifts out of parity with the goldens quietly.
    const frame = utf8Length(this.render(entry, '', undefined, true)) - 2;
    const messageBytes = utf8Length(JSON.stringify(entry.message));

    // Metadata first: a dropped field costs the reader one fact, whereas a
    // shortened message can cost them the sentence that explains the others.
    const metadata = entry.metadata;
    const keys = metadata ? Object.keys(metadata).sort() : [];
    if (keys.length > 0) {
      // `keep` stops one short of the full set, which was already rejected
      // above — and by more than this loop could recover, since every
      // candidate here also carries `,"truncated":true`. Running the extra
      // iteration would therefore be wasted rather than wrong, which is a way
      // of saying no test pins this bound: it was mutated to `keys.length`
      // and every one of the 14,365 differential cases still agreed.
      let total = frame + messageBytes + METADATA_FRAME_BYTES;
      let keep = 0;
      for (let i = 0; i < keys.length - 1; i += 1) {
        const key = keys[i]!;
        // `"key":value`, plus one byte for the comma joining it to the last.
        const pair = JSON.stringify(key) + ':' + renderValue(metadata![key]!);
        total += utf8Length(pair) + (i > 0 ? 1 : 0);
        if (total > maxBytes) break;
        keep = i + 1;
      }
      if (keep > 0) {
        const subset: Record<string, LogPrimitive> = {};
        for (let i = 0; i < keep; i += 1)
          subset[keys[i]!] = metadata![keys[i]!]!;
        return this.render(entry, entry.message, subset, true);
      }
      // Keeping no metadata at all is still a candidate, and a cheap one to
      // test: it is the frame with the whole message in it.
      if (frame + messageBytes <= maxBytes) {
        return this.render(entry, entry.message, undefined, true);
      }
    }

    // Then the message, by code points so a surrogate pair is never split
    // into a lone half. Escaping means a code point can cost anywhere from
    // one to twelve bytes, so the fit is found by measuring the rendered
    // message rather than by arithmetic on the source text.
    //
    // The search runs over UTF-16 indices and snaps every probe down to a
    // code-point boundary — see `boundaryAtOrBelow` for why it must. Both
    // ends stay on boundaries, which is what makes the guard below provably
    // sufficient rather than merely observed to work.
    const message = entry.message;
    const budget = maxBytes - frame;
    let low = 0;
    let high = message.length;
    while (low < high) {
      let mid = boundaryAtOrBelow(message, low + Math.ceil((high - low) / 2));
      // Only reachable when `high` is `low + 2` around a surrogate pair: the
      // midpoint is then `low + 1`, which snapping pushes back to `low`. No
      // boundary lies strictly between, so `high` is the last candidate. This
      // line has no test of its own because its absence does not fail — it
      // spins, and the loop never terminates.
      if (mid === low) mid = high;
      if (utf8Length(JSON.stringify(message.slice(0, mid))) <= budget) {
        low = mid;
      } else {
        // Snapping this end too is defensive rather than load-bearing: it was
        // mutated to a bare `mid - 1` and every differential case still
        // agreed, because a prefix cut mid-pair always costs MORE than the
        // one that includes the whole pair (six escape characters against
        // four bytes) and so can never be chosen once that one has failed.
        // Keeping both ends on boundaries means nobody has to rediscover
        // that argument to read the loop.
        high = boundaryAtOrBelow(message, mid - 1);
      }
    }
    return this.render(entry, message.slice(0, low), undefined, true);
  }

  private render(
    entry: LogEntry,
    message: string,
    metadata: RedactedMetadata | undefined,
    truncated: boolean
  ): string {
    let json = '{"timestamp":';
    json += this.renderTimestamp(entry.timestamp);
    json += ',"level":' + LEVEL_JSON[entry.level];
    json += ',"message":' + JSON.stringify(message);

    if (entry.correlation !== undefined) {
      json += ',"correlation":' + correlationJson(entry.correlation);
    }
    if (entry.subsystem !== undefined) {
      json += ',"subsystem":' + subsystemJson(entry.subsystem);
    }

    if (metadata) {
      const keys = Object.keys(metadata).sort();
      if (keys.length > 0) {
        json += METADATA_OPEN;
        for (let i = 0; i < keys.length; i += 1) {
          if (i > 0) json += ',';
          json +=
            JSON.stringify(keys[i]) + ':' + renderValue(metadata[keys[i]!]!);
        }
        json += '}';
      }
    }

    if (truncated) json += ',"truncated":true';
    return json + '}';
  }

  private renderTimestamp(epochMs: number): string {
    if (this.timestampStyle === 'epochSeconds') {
      return Number.isFinite(epochMs) ? String(epochMs / 1000) : '0';
    }
    // `toISOString` throws past the representable range, and a formatter that
    // throws takes down the log call that was trying to report a problem.
    if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_ISO_MS) {
      return '"1970-01-01T00:00:00.000Z"';
    }
    return isoTimestampJson(epochMs);
  }
}

/**
 * A metadata value as JSON, keeping its type.
 *
 * Non-finite numbers become quoted strings because JSON has no literal for
 * them, matching what the Swift formatter does. Redaction rejects them long
 * before this point, so the branch exists to keep a hand-built entry from
 * producing `NaN` in the middle of a record rather than because it is
 * reachable through the public API.
 */
function renderValue(value: LogPrimitive): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      return Number.isFinite(value)
        ? String(value)
        : JSON.stringify(String(value));
  }
}
