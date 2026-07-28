import type { LogEntry, LogPrimitive, RedactedMetadata } from '../types';
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

/** Instants JavaScript can represent as a Date but not as ISO 8601. */
const MAX_ISO_MS = 8.64e15;

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
   * Every control character is escaped, so a record cannot contain a raw
   * newline and native crash-tail trimming can find record boundaries.
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

    // Metadata first: a dropped field costs the reader one fact, whereas a
    // shortened message can cost them the sentence that explains the others.
    const keys = entry.metadata ? Object.keys(entry.metadata).sort() : [];
    for (let keep = keys.length - 1; keep >= 0; keep -= 1) {
      const subset: Record<string, LogPrimitive> = {};
      for (const key of keys.slice(0, keep)) {
        subset[key] = entry.metadata![key]!;
      }
      const candidate = this.render(
        entry,
        entry.message,
        keep === 0 ? undefined : subset,
        true
      );
      if (utf8Length(candidate) <= maxBytes) return candidate;
    }

    // Then the message, by code points so a surrogate pair is never split
    // into a lone half. Escaping means a code point can cost anywhere from
    // one to twelve bytes, so the fit is found by measuring whole rendered
    // records rather than by arithmetic on the message alone.
    const points = Array.from(entry.message);
    let low = 0;
    let high = points.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = this.render(
        entry,
        points.slice(0, mid).join(''),
        undefined,
        true
      );
      if (utf8Length(candidate) <= maxBytes) low = mid;
      else high = mid - 1;
    }
    return this.render(entry, points.slice(0, low).join(''), undefined, true);
  }

  private render(
    entry: LogEntry,
    message: string,
    metadata: RedactedMetadata | undefined,
    truncated: boolean
  ): string {
    let json = '{"timestamp":';
    json += this.renderTimestamp(entry.timestamp);
    json += ',"level":' + JSON.stringify(LEVEL_NAME[entry.level]);
    json += ',"message":' + JSON.stringify(message);

    if (entry.correlation !== undefined) {
      json += ',"correlation":' + JSON.stringify(entry.correlation);
    }
    if (entry.subsystem !== undefined) {
      json += ',"subsystem":' + JSON.stringify(entry.subsystem);
    }

    if (metadata) {
      const keys = Object.keys(metadata).sort();
      if (keys.length > 0) {
        json += ',"metadata":{';
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
    return JSON.stringify(new Date(epochMs).toISOString());
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
