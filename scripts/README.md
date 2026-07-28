# Regenerating the SwiftLogger goldens

`__tests__/fixtures/swiftloggerGoldens.ts` is the output of SwiftLogger's own
`JSONLogFormatter` over a fixed corpus. It is generated, not written by hand —
a golden someone typed out is a record of what they believed the Swift side
does, which is precisely the thing under test.

It is a TypeScript module rather than a data file the test reads at runtime
because this package targets Hermes and its tsconfig carries no Node type
definitions on purpose. Nothing in the test tree should need `fs`.

`GenGoldens.swift` produces it. It is kept here rather than in the Swift repo
so that checking parity never requires leaving a stray target behind in a
project this one only reads.

```sh
SWIFT_LOGGER=~/Developer/logger   # wherever the SwiftLogger checkout lives

mkdir -p "$SWIFT_LOGGER/Sources/GenGoldens"
cp scripts/GenGoldens.swift "$SWIFT_LOGGER/Sources/GenGoldens/main.swift"

# Add the target to Package.swift, above the .testTarget entry:
#
#     .executableTarget(name: "GenGoldens", dependencies: ["Logger"]),

(cd "$SWIFT_LOGGER" && swift run GenGoldens) | node scripts/goldensToModule.mjs \
  > __tests__/fixtures/swiftloggerGoldens.ts

# Then put the Swift checkout back:
(cd "$SWIFT_LOGGER" && git checkout Package.swift && rm -rf Sources/GenGoldens)
```

The generator emits one `{"json": …, "name": …}` object per line;
`goldensToModule.mjs` wraps those into the TypeScript module.

Do this when SwiftLogger's formatter changes, or when adding a case to the
corpus. Then run `yarn test` — `jsonLinesFormatter.test.ts` asserts byte
equality against every line, after removing the `"line":N` field that Swift
emits unconditionally and this package does not have. If a golden changes for
any other reason, that is a parity break and `docs/PARITY.md` needs to say so.
