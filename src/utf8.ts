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
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
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
