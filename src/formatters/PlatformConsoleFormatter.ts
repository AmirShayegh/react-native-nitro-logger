import type { LogEntry } from '../types';
import type { LogFormatter } from './types';
import { renderBody } from './consoleBody';

/**
 * The console layout with the level and the timestamp left off, for
 * destinations whose platform already stamps both.
 *
 *     [correlation] [subsystem] message {key=value}
 *
 * Recommended for {@link NativeConsoleDestination}, and **not** its default:
 * this changes what a developer sees in Console.app and Xcode, and a package
 * upgrade is the wrong moment for that to happen by itself. Pass it in.
 *
 * ## What the columns cost when the platform writes them anyway
 *
 * `DefaultFormatter` renders ` INFO | 12:15:30.842 | ` in front of every
 * line — 22 characters — and both native writers pass what they are given
 * straight through while stamping their own severity and time. In Console.app
 * the result reads `12:15:30.841  Info  MyApp:  INFO | 12:15:30.842 | …`, the
 * two timestamps a millisecond apart because they were taken a millisecond
 * apart.
 *
 * The duplication is not only noise. Both sinks chunk what they are given —
 * os_log around 900 bytes, logcat against a budget it shares with the tag —
 * and those 22 characters are charged against that budget on every chunk, so
 * a long message pays them again in every piece it is split into.
 *
 * ## The continuation marker, and what it does not promise here
 *
 * A multi-line message keeps its lines, each after the first prefixed with
 * `  | ` so a reader can see it is a continuation rather than a new entry:
 *
 *     [net] Unhandled TypeError
 *       | at foo (bundle.js:1:2)
 *
 * `DefaultFormatter` can promise more than that. Its marker blanks columns
 * that a real record always fills with a known tag and digits, so a
 * continuation is unforgeable there. Here there are no columns, and a message
 * that begins `  | ` renders a first line that looks like a continuation.
 *
 * That is accepted rather than overlooked. The platform stamps every line it
 * writes with its own severity and time, outside the payload and beyond
 * anything a message can reach, so the entry a forgery could impersonate is
 * another line of this app's console output — not a record. This stream is
 * explicitly not a system of record; `FileDestination` holds the durable copy
 * and `JsonLinesFormatter` is what makes that copy unforgeable. Someone who
 * needs the stronger guarantee in the console too should keep the default.
 *
 * Structured fields — correlation, subsystem, metadata keys and values — are
 * escaped exactly as they are by `DefaultFormatter`, because those are the
 * ones that arrive from request headers and usernames.
 */
export class PlatformConsoleFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    return renderBody(entry, CONTINUATION);
  }
}

/**
 * What each line after the first is prefixed with.
 *
 * Short on purpose: every byte of it is charged against the sink's chunk
 * budget on every chunk, which is most of the reason this formatter exists.
 * It ends with the same ` | ` the default layout ends its columns with, so
 * the two read alike to someone switching between them.
 */
const CONTINUATION = '  | ';
