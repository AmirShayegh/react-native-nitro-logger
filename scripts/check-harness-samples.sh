#!/usr/bin/env bash
#
# The consumer apps embedded in the min-rn harness scripts must compile against
# the real exports.
#
# `scripts/check-min-rn-ios.sh` and `scripts/check-min-rn-android.sh` each write
# an `App.tsx` from a quoted heredoc. That file is TypeScript, it is written
# against the public API exactly as a consumer would write it — and it is
# invisible to every static check this repository runs, because to `tsc` and to
# `eslint` it is a string inside a shell script. Nothing can break it at the
# moment it becomes wrong.
#
# What that costs, measured rather than imagined: 0.3.0 moved `createFileSink`
# out of the root entry point to `react-native-nitro-logger/unstable`, both
# templates went on importing it from the root, and the first thing that
# noticed was `min-rn-android` failing after 7m34s of emulator time with
# `TypeError: undefined is not a function`. `min-rn-ios` was still queued and
# would have spent longer to learn the same thing. Typechecking the templates
# turns that into a two-second failure naming the export.
#
# WHAT THIS DOES NOT PROVE. Only that the templates compile. It says nothing
# about whether the app runs, whether the native module links, or whether the
# pipeline works — that is precisely what the min-rn jobs are for, and this
# check exists to stop them being spent on a compile error.
#
# It also does NOT model Metro. `tsc --moduleResolution bundler` honours the
# `exports` map unconditionally, whereas Metro 0.81 — what react-native@0.78.0,
# this repository's stated minimum, pins — defaults
# `unstable_enablePackageExports` to false and cannot resolve a subpath export
# at all. A template importing `react-native-nitro-logger/unstable` would
# typecheck here and fail to bundle there. `check-metro-resolution.sh` is what
# enforces that constraint, by building real bundles; this script would not
# notice it.
#
# `-e` for the same reason as check-doc-samples.sh: a half-finished extraction
# that still produced a green tsc run would be a pass for templates that were
# never checked. The only command allowed to fail is tsc, tested for explicitly.
set -euo pipefail

cd "$(dirname "$0")/.."

# --target src|lib, mirroring check-doc-samples.sh, and for the same reason.
#
# `src` is the working tree: no build needed, so it belongs in `lint`, where
# removing an export breaks the harness in the same commit that removes it.
#
# `lib` is the surface the harness actually meets. These apps `npm install` the
# packed tarball, so they resolve `react-native-nitro-logger` through `exports`
# into `lib/typescript/**` — a type exported from source but dropped by the
# declaration build passes against `src` and fails for the real app. It needs
# `yarn prepare`, so it runs in `build-library`.
TARGET=src
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    *) echo "usage: $0 [--target src|lib]" >&2; exit 2 ;;
  esac
done

case "$TARGET" in
  src)
    ENTRY="$(pwd)/src/index.tsx"
    UNSTABLE="$(pwd)/src/unstable.ts"
    ;;
  lib)
    ENTRY="$(pwd)/lib/typescript/module/src/index.d.ts"
    UNSTABLE="$(pwd)/lib/typescript/module/src/unstable.d.ts"
    [ -f "$ENTRY" ] || {
      echo "FAIL: $ENTRY is missing — run \`yarn prepare\` before --target lib"
      exit 1
    }
    ;;
  *) echo "usage: $0 [--target src|lib]" >&2; exit 2 ;;
esac

OUT="$(mktemp -d "${TMPDIR:-/tmp}/nitro-logger-harness.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT

# Extraction. An absent or renamed marker is a failure and never a skip: a
# silent zero-template run is the one outcome that would make this check
# permanently green and permanently useless.
count=0
for plat in ios android; do
  script="scripts/check-min-rn-$plat.sh"
  python3 - "$script" "$OUT/App.$plat.tsx" <<'PY'
import pathlib, re, sys

script, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
text = script.read_text()

# The exact line each harness uses to open the template, and the quoted
# terminator that closes it. Matching the literal rather than a loose pattern
# means a rewritten harness fails here instead of silently extracting nothing.
match = re.search(r"^cat > \"\$APP_DIR/App\.tsx\" <<'APP'\n(.*?)\n^APP$", text, re.S | re.M)
if match is None:
    sys.exit(f"FAIL: no App.tsx heredoc found in {script} — did the harness change?")

body = match.group(1)
if "__RUN_ID__" not in body:
    sys.exit(f"FAIL: {script}'s template has no __RUN_ID__ placeholder; the "
             "harness stamps one in and asserts it landed, so its absence "
             "means this extraction is reading the wrong block")

# The harness substitutes a real run ID before building. Any string does here.
out.write_text(body.replace("__RUN_ID__", "harness-typecheck"))
PY
  count=$((count + 1))
done

[ "$count" -eq 2 ] || { echo "FAIL: expected 2 templates, extracted $count"; exit 1; }

# `types: []` so an ambient @types package cannot supply a name the real app
# would not have. `jsx: react-jsx` because these are components.
#
# `react` and `react-native` are mapped explicitly because the extracted files
# live in a temp directory outside the repository — deliberately, so a killed
# run cannot leave anything in the working tree — and so node resolution never
# walks up into this repository's `node_modules`. `react` itself declares no
# types, which is why it maps to `@types/react`.
#
# These resolve to whatever React Native this repository develops against, not
# to the minimum version the harness installs. That is the right trade: this
# check is about which of *this library's* exports the templates name, and
# pinning a second RN toolchain to typecheck two files would cost more than it
# could find.
cat > "$OUT/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "module": "esnext",
    "target": "es2020",
    "jsx": "react-jsx",
    "types": [],
    "paths": {
      "react-native-nitro-logger": ["$ENTRY"],
      "react-native-nitro-logger/unstable": ["$UNSTABLE"],
      "react": ["$(pwd)/node_modules/@types/react"],
      "react/jsx-runtime": ["$(pwd)/node_modules/@types/react/jsx-runtime"],
      "react-native": ["$(pwd)/node_modules/react-native"]
    }
  },
  "include": ["$OUT/*.tsx"]
}
JSON

if npx tsc -p "$OUT/tsconfig.json"; then
  echo "both min-rn harness templates typecheck against $TARGET"
else
  echo "min-rn harness templates do not compile against $TARGET"
  exit 1
fi
