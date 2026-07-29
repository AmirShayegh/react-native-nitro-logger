import type { LogEntry } from '../types';
import type { LogFormatter } from './types';
import { LEVEL_TAG } from '../levels';
import { formatTime } from './timestamp';

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
 * decorative.
 */
export class DefaultFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    let tags = '';
    if (entry.correlation !== undefined) {
      tags += `[${escapeControls(entry.correlation)}] `;
    }
    if (entry.subsystem !== undefined) {
      tags += `[${escapeControls(entry.subsystem)}] `;
    }

    let body = `${tags}${formatMessage(entry.message)}`;
    if (entry.metadata) {
      const metadata = entry.metadata;
      const keys = Object.keys(metadata).sort();
      if (keys.length > 0) {
        const pairs = keys
          .map(
            (k) => `${escapeControls(k)}=${escapeControls(String(metadata[k]))}`
          )
          .join(', ');
        body += ` {${pairs}}`;
      }
    }

    return `${LEVEL_TAG[entry.level]} | ${formatTime(entry.timestamp)} | ${body}`;
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

/**
 * Renders the message, keeping its lines but never letting one start a record.
 *
 * SwiftLogger leaves `message` completely alone, and this package did too
 * until review pointed out that matching the reference is not the same as
 * being safe. The forgery is the one escaping the structured fields prevents:
 * an error message or an interpolated string carrying
 * `"\nERROR | 00:00:00.000 | patient discharged"` writes a line a reader
 * cannot tell from a real one. Reachability is not theoretical —
 * `no-dynamic-message` is what normally keeps arbitrary text out of this
 * field, and it cannot see a logger wired through a function call.
 *
 * Escaping newlines outright would fix it and ruin the crash handler, which
 * logs stack traces through this field on purpose. Indenting continuation
 * lines keeps them readable and still leaves nothing that parses as a header.
 *
 * This is a deliberate parity difference; docs/PARITY.md records it.
 */
function formatMessage(message: string): string {
  // Four things besides \n break a line. A bare \r does, and can also drag
  // the cursor back over what was already printed. U+0085 (NEL) does for any
  // Unicode-aware reader. U+2028 and U+2029 do for anything treating this as
  // JavaScript-flavoured text.
  return message
    .split(/\r\n|[\n\r\u0085\u2028\u2029]/)
    .map(escapeControls)
    .join(`\n${CONTINUATION}`);
}

/**
 * Renders C0, DEL, C1, and the Unicode line/paragraph separators as escapes.
 *
 * C1 (U+0080–U+009F) matters as much as C0 here and is easy to forget:
 * U+009B is a single-character CSI, so a terminal will happily read what
 * follows it as a cursor-movement or erase sequence, and U+0085 is NEL,
 * which Unicode-aware readers treat as a line break.
 *
 * U+2028 and U+2029 are here for exactly the reason U+0085 is. They are not
 * control characters and a plain `\n`-splitting reader ignores them, but a
 * JavaScript one does not: `^` and `$` under the `m` flag treat both as line
 * terminators, so a log viewer written in JS — the likely kind for this
 * package — sees a line break where a terminal sees none. That asymmetry is
 * worse than either alone, because the forged line is invisible in the tool
 * someone checks the raw file with.
 *
 * This layout is one entry per line, so a newline inside a *structured* field
 * lets whoever supplied that field forge whole log entries. A correlation ID,
 * a subsystem, or a metadata key or value can all arrive from a request
 * header, a username, or a URL; without this, `"a\nERROR | 00:00:00.000 | "`
 * writes a convincing fake line into the log, and the reader has no way to
 * tell it from a real one.
 *
 * The message takes a different route — see {@link formatMessage} — because
 * it has to stay multi-line. Everything else is escaped outright.
 *
 * Clean fields — essentially all of them — are scanned once and returned
 * whole, so this costs nothing in the normal case.
 */
function escapeControls(field: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(field)) return field;

  let out = '';
  for (const character of field) {
    switch (character) {
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = character.codePointAt(0)!;
        out +=
          code < 0x20 ||
          (code >= 0x7f && code <= 0x9f) ||
          code === 0x2028 ||
          code === 0x2029
            ? `\\u{${code.toString(16).toUpperCase()}}`
            : character;
      }
    }
  }
  return out;
}
