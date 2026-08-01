import {
  sanitizeError,
  REDACTED_FRAME,
  REDACTED_MESSAGE,
  UNKNOWN_ERROR_NAME,
  NON_ERROR_THROWN,
  DEFAULT_MAX_FRAMES,
  MAX_STACK_LINES,
} from '../src/integrations/sanitizeError';

declare const globalThis: { __DEV__?: boolean };

/**
 * The sentinel these tests hunt for. If it ever appears in a sanitised result,
 * something in the error survived that should not have.
 */
const SENTINEL = 'MRN-4417293';

describe('sanitizeError — the message', () => {
  // `new Error(`no chart for ${patient.mrn}`)` is an ordinary line of
  // application code, and its message arrives here verbatim.
  test('never renders the real message outside a dev build', () => {
    const result = sanitizeError(new Error(`no chart for ${SENTINEL}`));
    expect(result.message).toBe(REDACTED_MESSAGE);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test('a thrown string never becomes the message', () => {
    const result = sanitizeError(`no chart for ${SENTINEL}`);
    expect(result.name).toBe(NON_ERROR_THROWN);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test.each([
    ['a thrown object', { mrn: SENTINEL }],
    ['a thrown number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('%s is reported without its content', (_name, thrown) => {
    const result = sanitizeError(thrown);
    expect(result.name).toBe(NON_ERROR_THROWN);
    expect(result.frames).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });
});

describe('sanitizeError — the name', () => {
  test.each([
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'EvalError',
    'URIError',
    'AggregateError',
  ])('%s is a built-in and survives', (name) => {
    const error = new Error('x');
    error.name = name;
    expect(sanitizeError(error).name).toBe(name);
  });

  // `class PatientNotFoundError` is a natural thing to write and a bad thing
  // to log. The class name is application data, not runtime data.
  test('a custom subclass collapses to a fixed token', () => {
    class PatientNotFoundError extends Error {}
    const error = new PatientNotFoundError('x');
    error.name = 'PatientNotFoundError';

    const result = sanitizeError(error);
    expect(result.name).toBe(UNKNOWN_ERROR_NAME);
    expect(result.name).not.toContain('Patient');
  });

  test('a name carrying data collapses too', () => {
    const error = new Error('x');
    error.name = `Error for ${SENTINEL}`;
    expect(sanitizeError(error).name).toBe(UNKNOWN_ERROR_NAME);
  });

  test('a non-string name does not become one', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'name', { value: Symbol('nope') });
    expect(sanitizeError(error).name).toBe(UNKNOWN_ERROR_NAME);
  });
});

describe('sanitizeError — frames', () => {
  function withStack(stack: string): Error {
    const error = new Error('x');
    Object.defineProperty(error, 'stack', { value: stack });
    return error;
  }

  test('keeps position and basename for a known bundle', () => {
    const result = sanitizeError(
      withStack(
        [
          'Error: something',
          '    at renderChart (/var/containers/App.app/index.bundle:4821:19)',
        ].join('\n')
      )
    );
    expect(result.frames).toEqual(['index.bundle:4821:19']);
  });

  test.each([
    ['V8 with parentheses', '    at fn (/a/b/index.bundle:1:2)'],
    ['V8 bare', '    at /a/b/index.bundle:1:2'],
    ['JSC at-form', 'fn@/a/b/index.bundle:1:2'],
    ['Hermes address form', '    at fn (address at /a/b/index.bundle:1:2)'],
  ])('parses %s', (_name, line) => {
    const result = sanitizeError(withStack(`Error: x\n${line}`));
    expect(result.frames).toEqual(['index.bundle:1:2']);
  });

  test('strips a Metro query string before matching the basename', () => {
    const result = sanitizeError(
      withStack(
        'Error: x\n    at fn (http://localhost:8081/index.bundle?platform=ios&dev=true:9:8)'
      )
    );
    expect(result.frames).toEqual(['index.bundle:9:8']);
  });

  test('strips a fragment before matching the basename', () => {
    // The query case above leaves the `#` half of `/[?#]/` unexercised, so
    // narrowing that class to `/[?]/` passed the whole suite. A fragment on a
    // bundle URL is rarer than a query and reaches the same code, and an
    // unrecognised basename is replaced by a fixed token rather than kept.
    const result = sanitizeError(
      withStack(
        'Error: x\n    at fn (http://localhost:8081/index.bundle#ref:9:8)'
      )
    );
    expect(result.frames).toEqual(['index.bundle:9:8']);
  });

  // R3's point: a basename can be perfectly regex-valid and still be data.
  test('a basename we cannot vouch for becomes a fixed token', () => {
    const result = sanitizeError(
      withStack(`Error: x\n    at fn (/tmp/${SENTINEL}.js:1:2)`)
    );
    expect(result.frames).toEqual([REDACTED_FRAME]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  // The first line of a V8 stack is `Name: message` — exactly the string this
  // module exists to keep out.
  test('the header line is discarded rather than guessed at', () => {
    const result = sanitizeError(
      withStack(
        `Error: no chart for ${SENTINEL}\n    at fn (/a/index.bundle:1:2)`
      )
    );
    expect(result.frames).toEqual(['index.bundle:1:2']);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test('lines that do not parse are dropped entirely', () => {
    const result = sanitizeError(
      withStack(
        [
          'Error: x',
          `    at ${SENTINEL}`,
          '    at <anonymous>',
          '    at fn (/a/index.bundle:1:2)',
        ].join('\n')
      )
    );
    expect(result.frames).toEqual(['index.bundle:1:2']);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  test('honours a caller-supplied bundle name', () => {
    const result = sanitizeError(
      withStack('Error: x\n    at fn (/a/custom.hbc:5:6)'),
      { bundleNames: ['custom.hbc'] }
    );
    expect(result.frames).toEqual(['custom.hbc:5:6']);
  });

  test('caps the frames but reports how many there were', () => {
    const lines = ['Error: x'];
    for (let i = 0; i < 40; i += 1) {
      lines.push(`    at fn (/a/index.bundle:${i}:1)`);
    }
    const result = sanitizeError(withStack(lines.join('\n')));

    expect(result.frames).toHaveLength(DEFAULT_MAX_FRAMES);
    expect(result.frameCount).toBe(40);
    // Newest first: the cap keeps the top of the stack, not the bottom.
    expect(result.frames[0]).toBe('index.bundle:0:1');
  });

  test('a missing stack is no frames rather than a failure', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'stack', { value: undefined });
    expect(sanitizeError(error).frames).toEqual([]);
  });
});

describe('sanitizeError — hostile input', () => {
  // An error handler that throws while reporting an error replaces a
  // diagnosable failure with an undiagnosable one.
  test('a throwing getter does not propagate', () => {
    const hostile = {
      get message(): string {
        throw new Error('boom');
      },
      get stack(): string {
        throw new Error('boom');
      },
      get name(): string {
        throw new Error('boom');
      },
    };

    expect(() => sanitizeError(hostile)).not.toThrow();
    expect(sanitizeError(hostile).name).toBe(NON_ERROR_THROWN);
  });

  test('a stack that is not a string yields no frames', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'stack', {
      value: { toString: () => SENTINEL },
    });
    const result = sanitizeError(error);
    expect(result.frames).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  // `instanceof` consults the prototype chain, so a Proxy can throw from the
  // one operation meant to classify a hostile value safely.
  test('a proxy that throws from getPrototypeOf does not propagate', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error('boom');
        },
        get(): never {
          throw new Error('boom');
        },
      }
    );

    expect(() => sanitizeError(hostile)).not.toThrow();
    expect(sanitizeError(hostile).name).toBe(NON_ERROR_THROWN);
  });

  // A getter may answer differently each time. Classifying on one read and
  // rendering from another would let the benign answer admit the other one.
  test('each property is read exactly once', () => {
    let messageReads = 0;
    const shifty = {
      get message(): string {
        messageReads += 1;
        return messageReads === 1 ? 'benign' : SENTINEL;
      },
      stack: 'Error: x\n    at fn (/a/index.bundle:1:2)',
    };

    const result = sanitizeError(shifty);
    expect(messageReads).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  // `stack` is sized by whatever was thrown, and this runs while the app is
  // already crashing. Splitting it whole to count frames we then drop hands an
  // arbitrary allocation to the worst possible code path.
  test('an enormous stack is bounded rather than read to the end', () => {
    const line = '    at fn (/a/index.bundle:1:2)\n';
    const error = new Error('x');
    Object.defineProperty(error, 'stack', {
      value: `Error: x\n${line.repeat(200_000)}`,
    });

    const started = Date.now();
    const result = sanitizeError(error);

    expect(result.framesTruncated).toBe(true);
    expect(result.frameCount).toBeLessThanOrEqual(MAX_STACK_LINES);
    expect(result.frames).toHaveLength(DEFAULT_MAX_FRAMES);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  // The repeated-line case above finds a newline a few characters from every
  // offset it searches from, so it never exercises the search itself. One
  // enormous line does: a scan for a line ending that never comes runs to the
  // end of the string no matter how tightly the loop around it is bounded.
  test('an enormous stack with no newline in it is bounded too', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'stack', { value: 'a'.repeat(8_000_000) });

    const started = Date.now();
    const result = sanitizeError(error);

    expect(result.framesTruncated).toBe(true);
    expect(result.frames).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('an ordinary stack is not reported as truncated', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'stack', {
      value: 'Error: x\n    at fn (/a/index.bundle:1:2)',
    });
    expect(sanitizeError(error).framesTruncated).toBe(false);
  });

  test('an absurd maxFrames falls back rather than being honoured', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'stack', {
      value: 'Error: x\n    at fn (/a/index.bundle:1:2)',
    });
    expect(sanitizeError(error, { maxFrames: Number.NaN }).frames).toHaveLength(
      1
    );
    expect(sanitizeError(error, { maxFrames: -1 }).frames).toHaveLength(1);
  });
});

/**
 * The dev reveal, and what it deliberately does not extend to.
 *
 * `never renders the real message outside a dev build` is one half of a pair
 * and is satisfied on its own by a sanitiser that redacts unconditionally.
 * That sanitiser would be safe and useless: the reason a real message is
 * shown on a developer's machine is that an error report reading
 * `<redacted>` with no way to get at the original sends people back to
 * `console.log(error.message)` — the exact habit this module exists to make
 * unnecessary.
 *
 * The third case is the bound on the reveal. `__DEV__` unlocks the *message*
 * and nothing else, so a frame from an unrecognised bundle stays a token even
 * in dev — a stack path can carry a username, a device name, or a directory
 * tree that says who somebody is.
 */
describe('sanitizeError — the dev reveal and its limits', () => {
  const originalDev = globalThis.__DEV__;

  afterEach(() => {
    if (originalDev === undefined) delete globalThis.__DEV__;
    else globalThis.__DEV__ = originalDev;
  });

  test('a dev build renders the real message', () => {
    globalThis.__DEV__ = true;
    const result = sanitizeError(new Error(`no chart for ${SENTINEL}`));
    expect(result.message).toBe(`no chart for ${SENTINEL}`);
  });

  test('and a release build redacts the very same error', () => {
    globalThis.__DEV__ = false;
    const result = sanitizeError(new Error(`no chart for ${SENTINEL}`));
    expect(result.message).toBe(REDACTED_MESSAGE);
  });

  test('the reveal reaches the message and stops there', () => {
    globalThis.__DEV__ = true;
    const error = new Error('boom');
    error.stack = `Error: boom\n    at f (/Users/${SENTINEL}/app/secret.js:1:1)`;

    const result = sanitizeError(error);

    expect(result.message).toBe('boom');
    // The path is not part of the reveal, in dev or anywhere else.
    expect(result.frames).toEqual([REDACTED_FRAME]);
    expect(JSON.stringify(result.frames)).not.toContain(SENTINEL);
  });
});

describe('sanitizeError — the frame-tail parser vs its regex specification', () => {
  /**
   * The regex the parser replaced, kept here as the executable specification.
   * The production code must never run it again — its rejection path is
   * quadratic, which is the whole reason it was replaced — but as an oracle
   * over bounded inputs it is exactly the semantics the parser must preserve.
   */
  const SPECIFICATION = /([^\s()]+):(\d+):(\d+)\)?$/;

  /** The same basename contract sanitizeError applies, restated for the oracle. */
  function specBasename(location: string): string {
    const cut = Math.max(location.lastIndexOf('/'), location.lastIndexOf('\\'));
    let name = cut >= 0 ? location.slice(cut + 1) : location;
    const query = name.search(/[?#]/);
    if (query >= 0) name = name.slice(0, query);
    return name;
  }

  /** What the specification says a one-line stack must produce. */
  function specFrame(
    rawLine: string
  ): { file: string; lineNumber: string; column: string } | null {
    const match = SPECIFICATION.exec(rawLine.trim());
    if (!match) return null;
    const [, location, lineNumber, column] = match;
    return {
      file: specBasename(location!),
      lineNumber: lineNumber!,
      column: column!,
    };
  }

  /** Deterministic PRNG (mulberry32) so a failure names a reproducible seed. */
  /* eslint-disable no-bitwise -- mulberry32 is defined by its bit mixing */
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* eslint-enable no-bitwise */

  // Deliberately adversarial: digits and colons (the overlap that made the
  // regex quadratic), both parens, every ECMAScript whitespace the class
  // excludes, path/URL punctuation the basename step cares about, and a
  // surrogate pair to pin code-unit semantics.
  const ALPHABET = [
    ...'0123456789::::()ab/\\.?#@-_',
    ' ',
    '\t',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    ' ',
    '　',
    '﻿',
    '😀',
  ];

  const FIXED_CASES = [
    'at fn (/path/index.bundle:1:2)',
    'at /path/index.bundle:1:2',
    'fn@http://localhost:8081/index.bundle?platform=ios:1:2',
    'at fn (address at /path/index.android.bundle:1:2)',
    'a:1:2:3:4', // multi-colon: location a:1:2, line 3, column 4
    'a:12:34',
    'a::1:2', // location may end in a colon
    ':1:2', // empty location: no frame
    '12:34', // one colon-group: no frame
    'foo:1:2))', // only one trailing paren is grammar
    'foo:1:2)',
    'a:12b:34', // non-digit in the line-number position: no frame
    '(:1:2', // paren just before an empty location
    'b(foo:3:4', // location stops at the paren
    'Error: no chart for MRN-4417293', // the V8 first line this module drops
    '',
    ')',
    ':::',
    '1:1:1:', // trailing colon: no frame
  ];

  test('agrees with the specification on fixed and fuzzed lines (seed 0x5eed)', () => {
    const random = prng(0x5eed);
    const lines = [...FIXED_CASES];
    for (let i = 0; i < 1500; i += 1) {
      const length = 1 + Math.floor(random() * 40);
      let line = '';
      for (let j = 0; j < length; j += 1) {
        line += ALPHABET[Math.floor(random() * ALPHABET.length)];
      }
      lines.push(line);
    }

    for (const line of lines) {
      const expected = specFrame(line);
      const error = new Error('x');
      // A single-line stack routes the line through the real parser.
      Object.defineProperty(error, 'stack', { value: line });

      if (expected === null) {
        const result = sanitizeError(error);
        expect({ line, frames: result.frames }).toEqual({ line, frames: [] });
      } else {
        // Naming the expected file as a bundle lets the parsed captures reach
        // the output verbatim, so all three groups are compared — through the
        // public surface, not a test-only export.
        const result = sanitizeError(error, { bundleNames: [expected.file] });
        expect({ line, frames: result.frames }).toEqual({
          line,
          frames: [
            `${expected.file}:${expected.lineNumber}:${expected.column}`,
          ],
        });
      }
    }
  });

  // CRLF stacks, whole and untrimmed. `parseFrames` splits on `\n` and trims
  // each line, so a CRLF line reaches the parser with its `\r` already gone —
  // the same contract the regex era had (JS `$` without `m` matches only at
  // end of input, so `FRAME_TAIL.exec('file:1:2\r')` was null and the
  // pre-regex trim was what made CRLF stacks parse; both verified against the
  // shipped 0.3.0 build). The single-line oracle above mirrors that trim.
  // This case pins the whole-stack path so the trim cannot be refactored away
  // without a frame-dropping regression being named here.
  test('every frame of a CRLF stack survives', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'stack', {
      value:
        'Error\r\n' +
        '    at foo (/a/index.bundle:1:2)\r\n' +
        '    at bar (/a/index.bundle:3:4)\r\n' +
        '    at baz (/a/index.bundle:5:6)',
    });

    const result = sanitizeError(error);
    expect(result.frames).toEqual([
      'index.bundle:1:2',
      'index.bundle:3:4',
      'index.bundle:5:6',
    ]);
    expect(result.framesTruncated).toBe(false);
  });

  // The shape the regex was slow on: many colon-dense lines, each of which
  // fails to parse only at its very last character. 256 lines × 1024 chars of
  // rejection measured 225 ms under the regex on a desktop — several times
  // that on a phone, inside the fatal-error handler. The parser does the same
  // rejection in one backward step per line. The 100 ms budget is ~50× the
  // parser's cost and half the regex's measured floor, so a reintroduced
  // backtracking implementation fails here on any hardware.
  test('a colon-dense stack is rejected in linear time', () => {
    const error = new Error('x');
    Object.defineProperty(error, 'stack', {
      // Each full line ends in ':', so no full line parses. One line does
      // parse anyway: the 64 KiB MAX_STACK_CHARS slice cuts the 64th line
      // mid-"1:" run, and the sliced tail ends in a digit — `...1:1:1` is a
      // well-formed location:line:column under the specification regex and
      // the parser alike (column 1, line 1, the rest a location that is not
      // a bundle name, hence redacted). That frame is asserted, not worked
      // around: it is the equivalence holding on a truncation artifact.
      value: ('1:'.repeat(512) + '\n').repeat(300),
    });

    const started = Date.now();
    const result = sanitizeError(error);

    expect(result.frames).toEqual([REDACTED_FRAME]);
    expect(result.frameCount).toBe(1);
    expect(result.framesTruncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
