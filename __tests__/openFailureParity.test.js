const fs = require('fs');
const path = require('path');

/**
 * The two adapters' open-failure messages, compared.
 *
 * Neither native suite can see the other: `swift test` and Gradle run in
 * different processes against different trees, so "the Kotlin strings match the
 * Swift ones" was a claim a reviewer had to check by eye. It was wrong — all
 * eight disagreed, Android sending "this sink is already open" where iOS sent
 * "FileSink: already open" — and it stayed wrong through a release, because
 * nothing executed both lists at once.
 *
 * Jest can read both files, so it does. This is the only place in the repo
 * where a Swift source and a Kotlin source are compared to each other.
 *
 * ## What this does NOT prove
 *
 * That either list is *reached*. It parses declarations, so a constant that no
 * throw site uses still matches its twin perfectly. Each platform's own suite
 * covers use: `FileSinkMessagesTest` on Kotlin drives the mapper, and the Swift
 * side's messages are exercised through `FileSinkLifecycleTests`.
 *
 * It also does not prove the strings are *good* — only that they are the same.
 * Two identically unhelpful messages pass.
 */

const ROOT = path.resolve(__dirname, '..');
const SWIFT = path.join(ROOT, 'ios/HybridFileSink.swift');
const KOTLIN = path.join(
  ROOT,
  'android/src/main/java/com/margelo/nitro/nitrologger/FileSinkMessages.kt'
);

/** SCREAMING_SNAKE_CASE -> lowerCamelCase, the only difference in the names. */
function camel(screamingSnake) {
  return screamingSnake
    .toLowerCase()
    .replace(/_(.)/g, (_, c) => c.toUpperCase());
}

/**
 * Declarations of the form `<keyword> <name> =\n? "<value>"`.
 *
 * Deliberately not a general Swift/Kotlin parser: it matches the exact shape
 * both files are written in, and a declaration that stops matching it shows up
 * as a missing key rather than being silently skipped — see the count guards.
 */
function declarations(source, pattern) {
  const found = new Map();
  for (const match of source.matchAll(pattern)) {
    found.set(match[1], match[2]);
  }
  return found;
}

describe('open-failure message parity', () => {
  const swiftSource = fs.readFileSync(SWIFT, 'utf8');
  const kotlinSource = fs.readFileSync(KOTLIN, 'utf8');

  // Scoped to the `enum Message { ... }` block so a stray string literal
  // elsewhere in the adapter cannot join the comparison.
  const messageBlock = swiftSource.match(
    /\n {2}enum Message \{\n([\s\S]*?)\n {2}\}\n/
  );
  const swift = declarations(
    messageBlock ? messageBlock[1] : '',
    /static let (\w+)\s*=\s*\n?\s*"([^"]*)"/g
  );
  const kotlin = declarations(
    kotlinSource,
    /const val (\w+)\s*=\s*\n?\s*"([^"]*)"/g
  );

  // Vacuity guards. Every assertion below passes trivially against two empty
  // maps, which is what a renamed file or a reformatted declaration produces.
  it('finds the Swift list', () => {
    expect(messageBlock).not.toBeNull();
    expect(swift.size).toBe(8);
  });

  it('finds the Kotlin list', () => {
    expect(kotlin.size).toBe(8);
  });

  it('declares the same names on both platforms', () => {
    const fromKotlin = [...kotlin.keys()].map(camel).sort();
    expect(fromKotlin).toEqual([...swift.keys()].sort());
  });

  it.each([
    'ALREADY_OPEN',
    'CLOSING',
    'DISPOSED',
    'CONFIG_CONFLICT',
    'SYMLINK_ESCAPE',
    'LOCKED',
    'STILL_CLOSING',
    'OPEN_FAILED',
  ])('%s is byte-identical on both platforms', (name) => {
    expect(kotlin.get(name)).toBe(swift.get(camel(name)));
  });

  // These cross a bridge into an app's own logging. A path carries a username
  // and an errno description carries the path, so the rule is that the text is
  // fixed — no interpolation, no format specifiers, nothing derived from what
  // the caller passed in.
  it('carries no payload on either platform', () => {
    for (const [name, value] of [...kotlin, ...swift]) {
      expect(`${name}: ${value}`).not.toMatch(/[$%]|\\\(/);
    }
  });
});
