import {
  sanitizeError,
  REDACTED_FRAME,
  REDACTED_MESSAGE,
  UNKNOWN_ERROR_NAME,
  NON_ERROR_THROWN,
  DEFAULT_MAX_FRAMES,
  MAX_STACK_LINES,
} from '../src/integrations/sanitizeError';

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
