/**
 * UTF-8 byte length, without allocating an encoder.
 *
 * `TextEncoder` is not guaranteed on every Hermes build this package targets,
 * and counting is cheaper than encoding when the answer is all that is
 * wanted. Every byte budget in this package — the sink's payload cap, the
 * batcher's pending cap, a formatter's truncation limit — is a UTF-8 budget,
 * because that is what actually reaches the file.
 *
 * An unpaired surrogate counts as 3, matching every standard encoder: it has
 * no UTF-8 form of its own, so encoders substitute U+FFFD, which is three
 * bytes.
 *
 * The leading run of ASCII is counted by *skipping* it rather than by adding
 * one per character. Log text is overwhelmingly ASCII — level tags, timestamps,
 * subsystem names, metadata keys, and most messages — and this function runs
 * once per record per destination, so the common case is worth a cheaper loop.
 * Where the scan stops, the general loop resumes from exactly that index with
 * the count already correct, which is what makes this byte-neutral rather than
 * an approximation: the SwiftLogger golden fixtures run unchanged as the proof.
 *
 * That skip is done two ways — a hand-written loop over a short prefix, then
 * the engine's own scanner for the rest — and the two agreeing about where
 * ASCII stops is the invariant everything below rests on. See
 * {@link NON_ASCII} and {@link SEARCH_MIN_UNITS}.
 */

/**
 * The first unit that is not ASCII, for the engine to find instead of a loop.
 *
 * All it has to find is the first UTF-16 position holding a unit above 0x7F,
 * which is exactly where the loop below would have stopped. No Unicode
 * semantics are wanted or needed: `search` reports a code-UNIT index either
 * way, so the handover index is the same whether or not the pattern is in
 * Unicode mode — including for unpaired surrogates, which this file has a
 * whole describe block about. The `u` flag is omitted because nothing here
 * asks for it, and the surrogate cases in `__tests__/utf8.test.ts` are the
 * executable guard on the equivalence rather than this paragraph.
 *
 * **The range starts at NUL, not at 0x20.** Control characters are ASCII and
 * encode as one byte each, and log text contains them — a tab in a message, a
 * `\r` in a captured stack trace. Starting at 0x20 would hand every such
 * string to the general loop from its first control character: still correct,
 * slower, and a second way for the two paths to disagree. The lint rule below
 * is about regexes that match control characters by accident; this one does it
 * on purpose.
 */
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * Below this many UTF-16 units the hand-written loop wins outright, and it is
 * also the length of prefix always walked by hand before the engine is asked.
 *
 * `search` is an engine primitive scanning several bytes at a time, but it
 * costs a call and a regex entry, and on a short string that fixed cost is
 * most of the work. Log text is mostly short — a level tag, a subsystem name,
 * a metadata key — so the gate is what keeps this from being a pessimisation
 * on the strings this library measures most often.
 *
 * Calibrated on the engine that ships, not on Node; see `bench/README.md`.
 */
const SEARCH_MIN_UNITS = 32;

export function utf8Length(text: string): number {
  const length = text.length;

  // A short prefix is always walked by hand first, and it is what decides
  // whether the engine is worth calling at all. Three cases fall out of it:
  // a string that ends inside the prefix is finished here; a string that
  // turns non-ASCII inside the prefix hands straight to the general loop
  // having paid nothing extra; and only a string still in ASCII after the
  // whole prefix has a run long enough to be worth a `search`.
  //
  // That middle case is why the prefix exists. Gating on `length` alone made
  // a 1 KB line whose first emoji sits at unit 8 pay for a `search` that
  // returned almost immediately and then walk the other 1000 units anyway —
  // measured at +9.5% on `utf8.emoji-mixed-1kb`, which is a realistic shape
  // for this library, not a contrived one.
  let i = 0;
  const prefixEnd = length < SEARCH_MIN_UNITS ? length : SEARCH_MIN_UNITS;
  while (i < prefixEnd && text.charCodeAt(i) < 0x80) i += 1;
  if (i === length) return length;

  if (i === SEARCH_MIN_UNITS) {
    // Still ASCII after the whole prefix. `search` returns the index of the
    // first non-ASCII unit — exactly the handover the loop below resumes
    // from — or -1 when there is none. It rescans the prefix, which is
    // bounded and constant.
    const found = text.search(NON_ASCII);
    if (found === -1) return length;
    i = found;
  }

  let bytes = i;
  for (; i < length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        // Lone high surrogate: encodes as U+FFFD.
        bytes += 3;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Lone low surrogate: likewise.
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
