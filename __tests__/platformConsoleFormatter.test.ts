import { PlatformConsoleFormatter } from '../src/formatters/PlatformConsoleFormatter';
import { DefaultFormatter } from '../src/formatters/DefaultFormatter';
import type { LogEntry } from '../src/types';

const at = new Date(2026, 6, 27, 12, 15, 30, 842).getTime(); // local 12:15:30.842

function entry(partial: Partial<LogEntry>): LogEntry {
  return { timestamp: at, level: 'info', message: 'msg', ...partial };
}

/**
 * The console layout for sinks that stamp their own severity and time.
 *
 * `nativeConsoleDestination.test.ts` asserts on substrings of whatever
 * formatter it is given and does not transfer, so this is the whole of the
 * evidence for what this one writes.
 */
describe('PlatformConsoleFormatter', () => {
  const formatter = new PlatformConsoleFormatter();

  test('writes the body and nothing in front of it', () => {
    expect(formatter.format(entry({}))).toBe('msg');
    expect(formatter.format(entry({ level: 'error' }))).toBe('msg');
  });

  test('the level and the timestamp are the whole of what it drops', () => {
    // Asserted against the default rather than described, so the two cannot
    // drift: everything to the right of the second `|` must be identical.
    const rich = entry({
      correlation: 'job-1',
      subsystem: 'net',
      metadata: { b: 2, a: 'x', c: true },
    });
    const full = new DefaultFormatter().format(rich);
    expect(full).toBe(
      ' INFO | 12:15:30.842 | [job-1] [net] msg {a=x, b=2, c=true}'
    );
    expect(formatter.format(rich)).toBe(
      full.slice(' INFO | 12:15:30.842 | '.length)
    );
  });

  test('the framing the docs count is the framing it removes', () => {
    // docs/API.md, the changeset and the class docstring all quote the same
    // arithmetic: 713 characters of framing against 120 for a thirty-frame
    // trace, and 593 handed back to the sink's chunk budget. Those numbers are
    // the argument for this formatter existing, so they are derived here from
    // the real output rather than asserted as constants — a layout change on
    // either side has to move the prose with it.
    //
    // The per-line figure is what makes them large: the columns are paid once
    // as the header and again, blanked, on every continuation line. Neither
    // native writer splits on newlines — both chunk the rendered entry by
    // size — so this is budget, not just noise.
    const trace = [
      'Unhandled TypeError',
      ...Array.from({ length: 30 }, (_, i) => `at frame${i} (bundle.js:1:2)`),
    ].join('\n');
    const plain = entry({ message: trace });

    const defaultRendered = new DefaultFormatter().format(plain).length;
    const platformRendered = formatter.format(plain).length;
    const defaultFraming = defaultRendered - trace.length;
    const platformFraming = platformRendered - trace.length;

    expect(defaultFraming).toBe(713); // 23 x 31 lines
    expect(platformFraming).toBe(120); // 4 x 30 continuations
    expect(defaultFraming - platformFraming).toBe(593);

    // The docstring also quotes both rendered sizes, to make the point that
    // 593 bytes back is not automatically a chunk saved: at os_log's ~900,
    // 939 and 1532 both split in two. Saying so only stays honest while
    // these two numbers are what the formatters actually produce.
    expect(platformRendered).toBe(939);
    expect(defaultRendered).toBe(1532);
  });

  test('tags render in order, metadata sorted by key', () => {
    expect(
      formatter.format(entry({ correlation: 'job-1', subsystem: 'net' }))
    ).toBe('[job-1] [net] msg');
    expect(formatter.format(entry({ metadata: { zebra: 1, alpha: 2 } }))).toBe(
      'msg {alpha=2, zebra=1}'
    );
    expect(formatter.format(entry({ metadata: {} }))).toBe('msg');
  });

  test('every level renders the same, because the platform carries it', () => {
    // The reason this formatter exists: the severity is a field of the
    // os_log entry and the logcat priority byte, not text in the payload.
    const levels = ['verbose', 'debug', 'info', 'warning', 'error', 'todo'];
    for (const level of levels) {
      expect(
        formatter.format(entry({ level: level as LogEntry['level'] }))
      ).toBe('msg');
    }
  });
});

/**
 * The escaping is shared with `DefaultFormatter` — one implementation, in
 * `formatters/consoleBody.ts` — so these are not a second copy of that file's
 * cases. They are the ones that would go quiet if this formatter ever grew
 * its own body renderer: a structured field must not be able to write a line
 * break, and a message must still keep its lines.
 */
describe('PlatformConsoleFormatter — escaping', () => {
  const formatter = new PlatformConsoleFormatter();

  test('a newline in a structured field cannot start a line', () => {
    const out = formatter.format(
      entry({ correlation: 'a\nERROR forged', subsystem: 'b\u2028forged' })
    );
    expect(out).toBe('[a\\nERROR forged] [b\\u{2028}forged] msg');
    expect(out.split('\n')).toHaveLength(1);
  });

  test('metadata keys and values are both escaped', () => {
    expect(formatter.format(entry({ metadata: { 'k\ty': 'v\rw' } }))).toBe(
      'msg {k\\ty=v\\rw}'
    );
  });

  test('a multi-line message keeps its lines, marked as continuations', () => {
    // The crash handler logs stack traces through this field on purpose.
    expect(formatter.format(entry({ message: 'line1\nline2' }))).toBe(
      'line1\n  | line2'
    );
  });

  test('every line-break form is neutralised, not just \\n', () => {
    for (const brk of ['\r\n', '\r', '\u0085', '\u2028', '\u2029']) {
      const out = formatter.format(entry({ message: `a${brk}b` }));
      expect(out).toBe('a\n  | b');
      expect(out).not.toContain('\r');
      expect(out).not.toContain('\u0085');
      expect(out).not.toContain('\u2028');
      expect(out).not.toContain('\u2029');
    }
  });

  test('C1 controls in the message cannot drive a terminal', () => {
    // U+009B is a single-character CSI; `\u009b2K` erases the line just
    // written. Not a line break, so it is escaped rather than split on.
    expect(formatter.format(entry({ message: 'a\u009b2Kb' }))).toBe(
      'a\\u{9B}2Kb'
    );
  });

  test('a clean message is passed through byte for byte', () => {
    for (const message of ['plain', 'café 日本語 🎉', 'a\u00a0b', '']) {
      expect(formatter.format(entry({ message }))).toBe(message);
    }
  });

  /**
   * The documented limit of the continuation marker, pinned rather than only
   * described: with no columns to blank there is no prefix a first line
   * cannot also produce.
   *
   * This is the difference between the two console formatters and the reason
   * `DefaultFormatter` stays the default. The platform stamps every line with
   * its own severity and time, outside the payload, so what a forgery here
   * can impersonate is another line of this app's output — not a record. The
   * unforgeable copy is the file's.
   */
  test('a message that starts like a continuation is not caught', () => {
    expect(formatter.format(entry({ message: '  | not a continuation' }))).toBe(
      '  | not a continuation'
    );
  });
});
