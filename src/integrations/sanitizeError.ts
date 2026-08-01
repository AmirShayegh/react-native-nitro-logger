/**
 * Turning a thrown value into something a log file is allowed to contain.
 *
 * An uncaught error is the one place the logger handles a string it did not
 * construct, cannot see the provenance of, and did not put through the privacy
 * layer. `new Error(\`no chart for ${patient.mrn}\`)` is an entirely ordinary
 * line of application code, and its message reaches here verbatim. So nothing
 * from the error is trusted: the class name is allowlisted down to a fixed
 * token, the message is dropped outside dev, and stack frames are reduced to a
 * position in a file whose name we already knew.
 *
 * The result is safe enough to mark `pub()`, which is the point — sanitising is
 * what earns an error the right to be rendered.
 */

/**
 * Error constructors the language itself defines. A name from this set says
 * only which built-in was thrown, which is a fact about the runtime rather than
 * about the data.
 *
 * Anything else collapses to {@link UNKNOWN_ERROR_NAME}. A custom subclass is
 * named by application code, and `class PatientNotFoundError` is a perfectly
 * natural thing to write and a perfectly bad thing to log.
 */
const BUILT_IN_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

/** What an unrecognised error class is reported as. */
export const UNKNOWN_ERROR_NAME = 'Error';

/** What a stack frame in a file we cannot vouch for is reported as. */
export const REDACTED_FRAME = '<frame>';

/** What an error message is reported as outside a dev build. */
export const REDACTED_MESSAGE = '<redacted>';

/** What a thrown non-Error is reported as. */
export const NON_ERROR_THROWN = '<non-error>';

/**
 * Bundle basenames a frame may be named after.
 *
 * A frame is only useful if you can find the file, and the files an app ships
 * are known in advance. Everything else — a path from `node_modules`, a
 * `blob:` URL, a filename built at runtime — is reported positionally instead.
 * R3's point stands on its own: a basename can be perfectly regex-valid and
 * still be `patient-12345.js`.
 */
export const DEFAULT_BUNDLE_NAMES: readonly string[] = [
  'index.bundle',
  'main.jsbundle',
  'index.android.bundle',
  'index.ios.bundle',
];

/**
 * {@link DEFAULT_BUNDLE_NAMES} as the Set the frame parser wants.
 *
 * Module scope because this runs on the crash path, where every allocation is
 * one the process may not live to collect, and rebuilding a four-element Set
 * per error was buying nothing.
 */
const DEFAULT_BUNDLE_NAME_SET: ReadonlySet<string> = new Set(
  DEFAULT_BUNDLE_NAMES
);

/**
 * The start of a URL's query or fragment, so a basename stops before it.
 *
 * Hoisted because a regex literal is a fresh `RegExp` on every evaluation on
 * Hermes, and this one is evaluated per stack frame of every sanitized error.
 *
 * Sharing it is safe for a reason worth stating exactly, because the obvious
 * reason is wrong: it is NOT that the literal carries no `g` flag.
 * `String.prototype.search` saves and restores `lastIndex` and ignores `g`
 * altogether, so this particular call would behave identically with one —
 * adding `g` was mutated in and changed nothing. The no-`g` rule that governs
 * the console formatter's classes is about `test` and `exec`, which do
 * advance `lastIndex`. Here the flag simply does not participate.
 */
const QUERY_OR_FRAGMENT = /[?#]/;

/** Frames beyond this are dropped; the count of what was dropped is kept. */
export const DEFAULT_MAX_FRAMES = 12;

/**
 * How much of a stack is read at all, regardless of how many frames are kept.
 *
 * `stack` is a property of an object someone threw, which means its size is
 * chosen by whatever threw it and not by any engine limit. Splitting it whole
 * to count frames we then discard hands an arbitrary allocation to the one
 * code path that runs while the app is already crashing. A real Hermes or V8
 * stack is a few kilobytes and a few dozen lines; anything past these bounds
 * is reported as truncated rather than read.
 */
export const MAX_STACK_CHARS = 64 * 1024;
export const MAX_STACK_LINES = 256;

/**
 * How much of a single line the frame parser is run against.
 *
 * This bound predates {@link frameTail} and used to be what kept a
 * backtracking regex from going quadratic on one long line. The parser is
 * linear now, so the constant's remaining job is smaller but still real: the
 * per-line `slice` below allocates whatever it is given, and the location run
 * of a degenerate line can be arbitrarily long. The tail decides it for any
 * line that could really be a frame, so nothing parseable is lost.
 */
export const MAX_FRAME_LINE_CHARS = 1024;

export interface SanitizedError {
  /** An allowlisted built-in name, or `'Error'`. */
  readonly name: string;
  /** The real message in a dev build; {@link REDACTED_MESSAGE} otherwise. */
  readonly message: string;
  /** Sanitised frames, newest first, at most `maxFrames` of them. */
  readonly frames: readonly string[];
  /** How many frames were found in the part of the stack that was read. */
  readonly frameCount: number;
  /**
   * The stack was longer than {@link MAX_STACK_CHARS} or
   * {@link MAX_STACK_LINES} and was not read to the end, so `frameCount` is a
   * floor rather than a total.
   */
  readonly framesTruncated: boolean;
}

export interface SanitizeErrorOptions {
  readonly bundleNames?: readonly string[];
  readonly maxFrames?: number;
}

// The reveal branch exists only in dev builds. Metro substitutes a literal for
// `__DEV__`, so in a release bundle this whole block — sentinel included — is
// dead code and is stripped. CI greps the release bundle for the sentinel.
let revealBranchSentinel = '';

function messageRevealAllowed(): boolean {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    revealBranchSentinel = '__NITRO_LOGGER_ERROR_REVEAL__';
    return true;
  }
  return false;
}

/** @internal Test/CI hook — non-empty only once the dev reveal branch ran. */
export function __errorRevealBranchSentinel(): string {
  return revealBranchSentinel;
}

/**
 * Reduces a thrown value to a name, a message, and a list of positions.
 *
 * Total by construction: every branch that could throw — a getter on `message`,
 * a `stack` that is not a string, a `name` that is a Symbol — ends at a fixed
 * token rather than propagating. An error handler that throws while reporting
 * an error takes the crash report with it.
 */
export function sanitizeError(
  thrown: unknown,
  options?: SanitizeErrorOptions
): SanitizedError {
  // Built once when the caller did not name its own bundles, which is every
  // call the crash handler makes. `parseFrames` takes it as a `ReadonlySet`
  // and only ever asks `.has`, so one shared instance is safe — a caller who
  // does supply names still gets a Set of their own.
  const bundleNames = options?.bundleNames
    ? new Set(options.bundleNames)
    : DEFAULT_BUNDLE_NAME_SET;
  const maxFrames = boundedFrames(options?.maxFrames);

  // Read each property exactly once, and touch the thrown value in no other
  // way.
  //
  // Not `instanceof Error`: that consults the prototype chain, and a Proxy can
  // throw from its `getPrototypeOf` trap — so the one operation meant to
  // classify a hostile value safely is itself an operation it can hijack.
  // Reading once also matters on its own: a getter is free to return something
  // innocuous when classified and something else when rendered, so classifying
  // and rendering must be the same read.
  const source =
    typeof thrown === 'object' && thrown !== null ? thrown : undefined;
  const stack = source ? readString(source, 'stack') : undefined;
  const message = source ? readString(source, 'message') : undefined;
  const name = source ? readString(source, 'name') : undefined;

  if (stack === undefined && message === undefined) {
    // A thrown string is the case that matters: `throw \`no chart for ${mrn}\``
    // would otherwise arrive as the message. Its content never appears.
    return {
      name: NON_ERROR_THROWN,
      message: REDACTED_MESSAGE,
      frames: [],
      frameCount: 0,
      framesTruncated: false,
    };
  }

  const parsed = parseFrames(stack, bundleNames);

  return {
    name: sanitizeName(name),
    message: messageRevealAllowed() ? (message ?? '') : REDACTED_MESSAGE,
    frames: parsed.frames.slice(0, maxFrames),
    frameCount: parsed.frames.length,
    framesTruncated: parsed.truncated,
  };
}

/**
 * Property reads on a thrown value are not safe.
 *
 * `error.message` can be a getter, and a getter on an object someone threw can
 * do anything — including throw again, from inside the handler that exists to
 * report the first failure.
 */
function readString(source: object, key: string): string | undefined {
  try {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeName(name: string | undefined): string {
  if (name === undefined) return UNKNOWN_ERROR_NAME;
  return BUILT_IN_ERROR_NAMES.has(name) ? name : UNKNOWN_ERROR_NAME;
}

function boundedFrames(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FRAMES;
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_MAX_FRAMES;
  return value;
}

/**
 * The trailing `file:line:column` of a stack line, in any of the shapes
 * JavaScriptCore, Hermes and V8 produce:
 *
 *     at fn (/path/index.bundle:1:2)
 *     at /path/index.bundle:1:2
 *     fn@http://localhost:8081/index.bundle?platform=ios:1:2
 *     at fn (address at /path/index.android.bundle:1:2)
 *
 * Only the position is taken. The function name is discarded with everything
 * else: it adds nothing a file and line does not already give, and it is one
 * more string from application code that nobody has vetted.
 *
 * This grammar used to be the regex `/([^\s()]+):(\d+):(\d+)\)?$/`, and the
 * reason it no longer is is the rejection path. `[^\s()]` overlaps `\d` and
 * the pattern is anchored at the end but not the start, so on a line that
 * does NOT match, the engine retries from every offset and each retry
 * backtracks the run it consumed. {@link MAX_FRAME_LINE_CHARS} bounded that
 * without closing it: 256 colon-dense 1024-char lines measured 225 ms of
 * pure rejection on a desktop — several times that on a phone — inside the
 * fatal-error handler, ahead of the flush that handler exists to reach. And
 * `stack` is a property of an object someone threw, so the shape is chosen
 * by the thrower.
 *
 * So: the same grammar, parsed backward from the end in one pass. The
 * equivalence is exact, because the regex's match was already uniquely
 * determined from its `$` anchor — an optional `)`; then the maximal
 * trailing digit run as the column (greedy `[^\s()]+` concedes the minimum,
 * making the `:digits:digits` split the rightmost one); a `:`; the maximal
 * digit run before it as the line; a `:`; then the location, which extends
 * left over `[^\s()]` maximally because the leftmost match start is exactly
 * the start of that run. The differential fuzz test in sanitizeError.test.ts
 * holds this parser equal to the regex over random and adversarial inputs —
 * the regex lives on there as the executable specification.
 */
function frameTail(
  line: string
): { location: string; lineNumber: string; column: string } | null {
  let i = line.length - 1;

  // `\)?` — at most one closing paren at the very end. Unconditional when
  // present: the regex could never match with the `)` unconsumed, because a
  // digit would then have to sit where the `)` is.
  if (i >= 0 && line.charCodeAt(i) === 0x29) i -= 1;

  const columnEnd = i;
  while (i >= 0 && isAsciiDigit(line.charCodeAt(i))) i -= 1;
  if (i === columnEnd) return null;
  const column = line.slice(i + 1, columnEnd + 1);

  if (i < 0 || line.charCodeAt(i) !== 0x3a /* ':' */) return null;
  i -= 1;

  const lineEnd = i;
  while (i >= 0 && isAsciiDigit(line.charCodeAt(i))) i -= 1;
  if (i === lineEnd) return null;
  const lineNumber = line.slice(i + 1, lineEnd + 1);

  if (i < 0 || line.charCodeAt(i) !== 0x3a /* ':' */) return null;
  i -= 1;

  const locationEnd = i;
  while (i >= 0 && !isFrameBoundary(line.charCodeAt(i))) i -= 1;
  if (i === locationEnd) return null;
  const location = line.slice(i + 1, locationEnd + 1);

  return { location, lineNumber, column };
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Exactly the characters the regex's `[^\s()]` excluded: `(`, `)`, and
 * ECMAScript's `\s` — the WhiteSpace and LineTerminator productions. The
 * list is what `\s` matches per ES2023 §22.2.2.9, written out because the
 * whole point of this parser is to run no regex; the differential fuzz test
 * generates from an alphabet that includes every one of these, so a missed
 * or extra member fails there rather than lurking.
 */
function isFrameBoundary(code: number): boolean {
  if (code === 0x28 || code === 0x29) return true; // ( )
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true; // space, TAB LF VT FF CR
  if (code < 0xa0) return false; // the rest of ASCII: never whitespace
  return (
    code === 0xa0 || // NBSP
    code === 0x1680 || // OGHAM SPACE MARK
    (code >= 0x2000 && code <= 0x200a) || // EN QUAD .. HAIR SPACE
    code === 0x2028 || // LINE SEPARATOR
    code === 0x2029 || // PARAGRAPH SEPARATOR
    code === 0x202f || // NARROW NO-BREAK SPACE
    code === 0x205f || // MEDIUM MATHEMATICAL SPACE
    code === 0x3000 || // IDEOGRAPHIC SPACE
    code === 0xfeff // ZERO WIDTH NO-BREAK SPACE
  );
}

/**
 * Walks the stack a line at a time within a fixed budget.
 *
 * Deliberately not `stack.split('\n')`: that materialises every line of a
 * string whose length the thrown object chose, to produce frames almost all of
 * which are then dropped. Scanning in place means an oversized stack costs a
 * bounded amount of work and is reported as truncated.
 */
function parseFrames(
  stack: string | undefined,
  bundleNames: ReadonlySet<string>
): { frames: string[]; truncated: boolean } {
  if (stack === undefined) return { frames: [], truncated: false };

  // Cut to the budget up front, then never look at the original again.
  //
  // Bounding the loop was not enough on its own: `indexOf` searches to the end
  // of whatever string it is given, so a multi-megabyte stack with no newline
  // in it — or just a very long last line — was still scanned in full by the
  // search for a line ending that was never going to come.
  const input =
    stack.length > MAX_STACK_CHARS ? stack.slice(0, MAX_STACK_CHARS) : stack;
  const truncatedInput = input.length < stack.length;

  const frames: string[] = [];
  let start = 0;
  let lines = 0;

  while (start < input.length && lines < MAX_STACK_LINES) {
    let end = input.indexOf('\n', start);
    if (end < 0) end = input.length;
    // The tail, not the head: the pattern is anchored at the end of the line.
    const from = Math.max(start, end - MAX_FRAME_LINE_CHARS);
    const line = input.slice(from, end).trim();
    start = end + 1;
    lines += 1;

    const tail = frameTail(line);
    // A line that does not parse is discarded rather than guessed at. The
    // first line of a V8 stack is `Name: message`, which is exactly the string
    // this module exists to keep out.
    if (!tail) continue;

    const file = basename(tail.location);
    frames.push(
      bundleNames.has(file)
        ? `${file}:${tail.lineNumber}:${tail.column}`
        : REDACTED_FRAME
    );
  }

  return { frames, truncated: truncatedInput || start < input.length };
}

/** The filename part of a path or URL, without any query or fragment. */
function basename(location: string): string {
  const cut = Math.max(location.lastIndexOf('/'), location.lastIndexOf('\\'));
  let name = cut >= 0 ? location.slice(cut + 1) : location;
  const query = name.search(QUERY_OR_FRAGMENT);
  if (query >= 0) name = name.slice(0, query);
  return name;
}
