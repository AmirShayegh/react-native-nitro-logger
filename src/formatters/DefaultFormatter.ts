import type { LogEntry } from '../types';
import type { LogFormatter } from './types';
import { LEVEL_TAG } from '../levels';
import { formatTime } from './timestamp';
import { renderBody } from './consoleBody';

/**
 * SwiftLogger's default layout minus the `File.swift:42` column (no call-site
 * capture in JS):
 *
 *     LEVEL | HH:mm:ss.SSS | [correlation] [subsystem] message {key=value}
 *
 * Metadata renders as `key=value` pairs sorted by key.
 *
 * A multi-line message keeps its lines, indented under the message column:
 *
 *     ERROR | 12:15:30.842 | Unhandled TypeError
 *           |              | at foo (bundle.js:1:2)
 *
 * See {@link CONTINUATION} for why that indent is load-bearing rather than
 * decorative, and `formatters/consoleBody.ts` for everything to the right of
 * the second `|`, which {@link PlatformConsoleFormatter} renders identically.
 */
export class DefaultFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    return `${LEVEL_TAG[entry.level]} | ${formatTime(entry.timestamp)} | ${renderBody(entry, CONTINUATION)}`;
  }
}

/**
 * Blanks the tag and timestamp columns, so a continuation line lines up under
 * the message and cannot be read as a record of its own.
 *
 *     ERROR | 12:15:30.842 | Unhandled TypeError
 *           |              | at foo (bundle.js:1:2)
 *
 * Five spaces for the level tag, twelve for `HH:mm:ss.SSS`, and the two
 * separators. A real record always carries a known tag and a timestamp made
 * of digits, so a blank in either column cannot be mistaken for one.
 */
const CONTINUATION = `${' '.repeat(5)} | ${' '.repeat(12)} | `;
