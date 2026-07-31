import { utf8Length } from '../src/utf8';

/**
 * Declared rather than imported. The package's tsconfig pulls in neither DOM
 * nor Node types — deliberately, because nothing in `src/` may depend on
 * either — so the global that Node and every browser provide has no type here.
 * Naming the one method this file uses is smaller and more honest than adding
 * a whole lib to the compiler for a test.
 */
declare const TextEncoder: {
  new (): { encode(input: string): Uint8Array };
};

/**
 * `utf8Length` against the platform encoder, over everything awkward.
 *
 * This function exists because `TextEncoder` is not guaranteed on every Hermes
 * build the package targets — but it *is* guaranteed in Node, which makes Node
 * the right place to check the two against each other. Every byte budget in
 * the library is a UTF-8 budget, and a counter that disagrees with the encoder
 * by one byte on one input eventually writes a record that does not fit.
 *
 * ## What this does NOT prove
 *
 * **That Hermes agrees.** These run on Node's ICU. `charCodeAt` is specified
 * over UTF-16 code units and has no room to differ, but no test here executes
 * on a device; the SwiftLogger golden fixtures are what catch a real encoding
 * difference reaching a file.
 *
 * **Anything about speed.** The ASCII fast path added in 0.3.0 is a
 * performance change asserted here only for the thing that matters about it:
 * that it counts the same bytes it counted before.
 */

const encoder = new TextEncoder();

/** What the platform's own encoder makes of a string. */
function reference(text: string): number {
  return encoder.encode(text).length;
}

const CORPUS: readonly [string, string][] = [
  ['empty', ''],
  ['pure ascii', 'the quick brown fox jumps over the lazy dog 0123456789'],
  ['one byte at the boundary', ''],
  ['first two-byte', ''],
  ['two-byte latin', 'naïve café résumé'],
  ['two-byte at the boundary', '߿'],
  ['first three-byte', 'ࠀ'],
  ['three-byte cjk', '日本語のログ'],
  ['three-byte at the boundary', '￿'],
  ['four-byte emoji', '🙂'],
  ['four-byte, several', '👩‍👩‍👧‍👦 family'],
  ['astral maths', '𝕳𝖊𝖑𝖑𝖔'],
  ['ascii then astral', 'level=info msg=🙂'],
  ['astral then ascii', '🙂 level=info'],
  ['ascii, astral, ascii', 'a🙂b'],
  ['mixed everything', 'abࠀc🙂d'],
  ['long ascii run then one astral', `${'x'.repeat(4096)}🙂`],
];

describe('utf8Length agrees with the platform encoder', () => {
  test.each(CORPUS)('%s', (_name, text) => {
    expect(utf8Length(text)).toBe(reference(text));
  });

  /**
   * The ASCII fast path stops at the first non-ASCII unit and hands over.
   *
   * The handover index is the whole risk in it: a general loop resuming one
   * character early double-counts, and one late drops a character. This walks
   * the boundary across every position in a fixed-length string rather than
   * trusting one example of it.
   */
  test('the handover between the fast path and the general loop is exact', () => {
    for (let position = 0; position < 24; position += 1) {
      const text = `${'a'.repeat(position)}🙂${'b'.repeat(24 - position)}`;
      expect(utf8Length(text)).toBe(reference(text));
    }
  });

  test('a string of only ASCII counts as its own length', () => {
    const text = 'x'.repeat(1000);
    expect(utf8Length(text)).toBe(1000);
    expect(utf8Length(text)).toBe(reference(text));
  });
});

/**
 * Lone surrogates are the one place this deliberately does NOT match
 * `TextEncoder`'s input handling, and matches its *output* instead.
 *
 * A lone surrogate has no UTF-8 form. Every standard encoder substitutes
 * U+FFFD, which is three bytes, and `TextEncoder.encode` does exactly that —
 * so these still agree with the reference. They are separated out because the
 * agreement is a substitution rather than an encoding, and a future reader
 * comparing the two implementations deserves to know which it is.
 */
describe('unpaired surrogates count as the replacement character', () => {
  const LONE: readonly [string, string][] = [
    ['lone high', '\ud83d'],
    ['lone low', '\ude42'],
    ['reversed pair', '\ude42\ud83d'],
    ['high at end of string', 'ok\ud83d'],
    ['high followed by ascii', '\ud83da'],
    ['low followed by low', '\ude42\ude42'],
    ['valid pair then lone high', '🙂\ud83d'],
  ];

  test.each(LONE)('%s', (_name, text) => {
    expect(utf8Length(text)).toBe(reference(text));
  });

  test('each lone surrogate is exactly three bytes', () => {
    // Spelled out rather than left to the reference, so the number this
    // library commits to is written down somewhere a reader can find it.
    expect(utf8Length('\ud83d')).toBe(3);
    expect(utf8Length('\ude42')).toBe(3);
    expect(utf8Length('\ude42\ud83d')).toBe(6);
  });

  test('a lone high surrogate does not swallow the character after it', () => {
    // `\ud83d` is not followed by a low surrogate, so it is three bytes on its
    // own and the 'a' after it is still counted. A general loop that consumed
    // two units unconditionally would answer 3 here instead of 4.
    expect(utf8Length('\ud83da')).toBe(4);
  });
});
