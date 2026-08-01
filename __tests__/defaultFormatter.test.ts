import { DefaultFormatter } from '../src/formatters/DefaultFormatter';
import type { LogEntry } from '../src/types';

const at = new Date(2026, 6, 27, 12, 15, 30, 842).getTime(); // local 12:15:30.842

function entry(partial: Partial<LogEntry>): LogEntry {
  return { timestamp: at, level: 'info', message: 'msg', ...partial };
}

describe('DefaultFormatter', () => {
  const formatter = new DefaultFormatter();

  test('renders LEVEL | time | message', () => {
    expect(formatter.format(entry({}))).toBe(' INFO | 12:15:30.842 | msg');
  });

  test('renders correlation and subsystem tags in order', () => {
    expect(
      formatter.format(entry({ correlation: 'job-1', subsystem: 'net' }))
    ).toBe(' INFO | 12:15:30.842 | [job-1] [net] msg');
  });

  test('renders metadata sorted by key', () => {
    expect(
      formatter.format(entry({ metadata: { b: 2, a: 'x', c: true } }))
    ).toBe(' INFO | 12:15:30.842 | msg {a=x, b=2, c=true}');
  });

  test('level tags keep the fixed-width alignment', () => {
    expect(formatter.format(entry({ level: 'error' }))).toMatch(/^ERROR \| /);
    expect(formatter.format(entry({ level: 'warning' }))).toMatch(/^ WARN \| /);
  });
});

/**
 * This layout is one entry per line, so a newline in a structured field lets
 * whoever supplied it forge log entries. Expectations below are the literal
 * output of SwiftLogger's `computeDefaultFormat` for the same inputs, minus
 * the `file:line` column — see docs/PARITY.md.
 */
describe('DefaultFormatter — log injection', () => {
  const formatter = new DefaultFormatter();

  test('a newline in the correlation ID cannot forge a line', () => {
    const forged = 'a\nERROR | 00:00:00.000 | forged';
    const out = formatter.format(entry({ correlation: forged }));
    expect(out).toBe(
      ' INFO | 12:15:30.842 | [a\\nERROR | 00:00:00.000 | forged] msg'
    );
    expect(out.split('\n')).toHaveLength(1);
  });

  test('control characters in the subsystem render as escapes', () => {
    // Uppercase hex inside `\u{…}`, matching Swift's `String(radix:16,
    // uppercase: true)`.
    expect(formatter.format(entry({ subsystem: 'sub\u0001\u007Fsys' }))).toBe(
      ' INFO | 12:15:30.842 | [sub\\u{1}\\u{7F}sys] msg'
    );
  });

  test('metadata keys and values are both escaped', () => {
    expect(formatter.format(entry({ metadata: { 'k\ty': 'v\rw' } }))).toBe(
      ' INFO | 12:15:30.842 | msg {k\\ty=v\\rw}'
    );
  });

  test('a multi-line message keeps its lines, indented under the message', () => {
    // The crash handler logs stack traces through this field on purpose, so
    // the lines survive — but the tag and timestamp columns are blanked, and
    // a real record never has a blank tag.
    const out = formatter.format(entry({ message: 'line1\nline2' }));
    expect(out).toBe(
      ' INFO | 12:15:30.842 | line1\n      |              | line2'
    );
  });

  test('a forged header in the message cannot pass for a record', () => {
    const out = formatter.format(
      entry({ message: 'real\nERROR | 00:00:00.000 | forged' })
    );
    const [, second] = out.split('\n');
    expect(second).toBe('      |              | ERROR | 00:00:00.000 | forged');
    // Every line either starts with a known level tag or is a continuation.
    expect(second!.startsWith('ERROR')).toBe(false);
  });

  test('every line-break form is neutralised, not just \\n', () => {
    // A bare `\r` drags a terminal cursor back over what was printed;
    // U+2028 and U+2029 are line breaks to anything treating the output as
    // JavaScript-flavoured text.
    for (const brk of ['\r\n', '\r', '\u0085', '\u2028', '\u2029']) {
      const out = formatter.format(entry({ message: `a${brk}ERROR | x` }));
      const lines = out.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe('      |              | ERROR | x');
      expect(out).not.toContain('\r');
      expect(out).not.toContain('\u0085');
      expect(out).not.toContain('\u2028');
      expect(out).not.toContain('\u2029');
    }
  });

  test('other control characters in the message are still escaped', () => {
    expect(formatter.format(entry({ message: 'a\u0000b\u007fc' }))).toBe(
      ' INFO | 12:15:30.842 | a\\u{0}b\\u{7F}c'
    );
  });

  test('C1 controls cannot drive a terminal', () => {
    // U+009B is a single-character CSI: everything after it is a control
    // sequence to a terminal, so `\u009B2K` erases the line that was just
    // written. It is not a line break, so it is escaped rather than split on.
    const out = formatter.format(entry({ message: 'a\u009B2Kb' }));
    expect(out).toBe(' INFO | 12:15:30.842 | a\\u{9B}2Kb');
    expect(out).not.toContain('\u009B');
  });

  test('C1 controls are escaped in structured fields too', () => {
    expect(formatter.format(entry({ subsystem: 'net\u0080\u009Fwork' }))).toBe(
      ' INFO | 12:15:30.842 | [net\\u{80}\\u{9F}work] msg'
    );
    expect(
      formatter.format(entry({ metadata: { 'k\u0085': 'v\u009B' } }))
    ).toBe(' INFO | 12:15:30.842 | msg {k\\u{85}=v\\u{9B}}');
  });

  test('U+2028 and U+2029 are escaped in structured fields', () => {
    // The message splits on these (see the line-break test above), but a
    // structured field must not: a correlation ID or a metadata value can
    // arrive from a request header or a username, and this layout is one
    // entry per line. They are invisible to a `\n`-splitting reader and are
    // line terminators to a JavaScript one under `m`, so a forged line shows
    // up in the log viewer and not in the file someone checks it against.
    expect(
      formatter.format(entry({ correlation: 'a\u2028ERROR | 00:00:00.000 |' }))
    ).toBe(' INFO | 12:15:30.842 | [a\\u{2028}ERROR | 00:00:00.000 |] msg');
    expect(
      formatter.format(entry({ metadata: { 'k\u2028': 'v\u2029' } }))
    ).toBe(' INFO | 12:15:30.842 | msg {k\\u{2028}=v\\u{2029}}');
  });

  test('a JS log reader cannot be shown a line a terminal cannot see', () => {
    // The property the escaping exists for, asserted as a property: split the
    // rendered record the way each kind of reader would and demand they agree
    // on how many lines there are.
    const out = formatter.format(
      entry({ subsystem: 'net\u2029ERROR | 00:00:00.000 | forged' })
    );
    expect(out.split('\n')).toHaveLength(1);
    // `m`-mode `^` treats U+2028/U+2029 as terminators, so this counts the
    // lines a JavaScript viewer would draw.
    expect(out.match(/^/gm)).toHaveLength(1);
  });

  test('a clean field is returned unchanged', () => {
    expect(
      formatter.format(
        entry({ correlation: 'job-1', subsystem: 'net', metadata: { a: 'x' } })
      )
    ).toBe(' INFO | 12:15:30.842 | [job-1] [net] msg {a=x}');
  });

  /**
   * Since 0.4.0 a message with nothing to escape skips the split-map-join
   * entirely, on the strength of one invariant: the class that decides
   * "nothing to escape" is a strict superset of the line-break alphabet, so a
   * message it passes cannot contain a break either.
   *
   * The line-break cases above are what enforce that — each of them is an
   * otherwise-clean message whose only special character is the break — and
   * the two below are the other side of it: what the shortcut must NOT
   * swallow, and what it must leave exactly alone.
   */
  describe('the clean-message shortcut', () => {
    test('a tab in the message is escaped, not passed through', () => {
      // A tab is neither a line break nor visible as one, so it is easy to
      // leave out of an "is this clean" test. It is C0, so it is escaped.
      expect(formatter.format(entry({ message: 'a\tb' }))).toBe(
        ' INFO | 12:15:30.842 | a\\tb'
      );
    });

    test('characters that only look special are passed through whole', () => {
      // None of these is a control character or a line break, so the fast
      // path is exactly right for them — and a shortcut that scanned for the
      // wrong class would mangle or split them.
      for (const [name, text] of [
        ['no-break space', 'a\u00a0b'],
        ['zero-width space', 'a\u200bb'],
        ['byte order mark', 'a\ufeffb'],
        ['astral', 'a🎉b'],
        ['lone surrogate', 'a\ud800b'],
        ['ideographic space', 'a\u3000b'],
      ] as const) {
        expect(formatter.format(entry({ message: text }))).toBe(
          ` INFO | 12:15:30.842 | ${text}`
        );
        expect(name).toBeTruthy();
      }
    });
  });
});
