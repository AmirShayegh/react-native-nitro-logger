#!/usr/bin/env bash
#
# Every ```ts block in the shipped documentation must compile against the real
# exports.
#
# A sample that merely looks plausible is worse than none: it is the first
# thing a reader copies, and a wrong option name or a renamed export sends them
# debugging the library instead of their app. Type-checking the samples means
# renaming an export breaks the docs at the same moment it breaks the code,
# rather than whenever someone next reads them.
#
# Blocks are concatenated per document in reading order, not checked in
# isolation, because these docs deliberately build on each other: a later block
# uses the `file` an earlier one constructed without repeating the import, and
# that is how a reader meets them. Checking each block alone would report good
# documentation style as an error. Named imports of this package are merged
# into a single statement, so two blocks that each import `Log` stay correct in
# the document without becoming a redeclaration in the concatenation.
#
# A block can opt out with `// doc-check: skip` on its first line, for
# illustrating a shape that is deliberately not real code.
# `-e` matters here specifically: without it a failed extraction still left
# whatever files it had already written, the count came out non-zero, and tsc
# passed against a partial set — a green result for documentation that was
# never checked. The only command allowed to fail is tsc itself, which is
# tested for explicitly below.
set -euo pipefail

cd "$(dirname "$0")/.."

# --target src|lib — which build of the package the samples are checked
# against, and the reason there are two.
#
# `src` is the working tree: fast, needs no build, and is what belongs in
# `lint`, where a renamed export should break the docs in the same commit that
# renames it. What it cannot see is the boundary a consumer actually meets. The
# samples resolve `react-native-nitro-logger` to `src/index.tsx` — a file the
# tarball ships but nothing published ever imports, because `exports` sends
# every consumer to `lib/typescript/**`. A type that is exported from the
# source and dropped by the declaration build typechecks here and fails for
# every reader.
#
# `lib` resolves the same specifier the way `exports` does — through
# `exports['.'].import.types`, the condition a bundler and `tsc
# --moduleResolution bundler` take — so it is the published surface being
# checked.
#
# It needs no separate build step, and that is worth stating because the
# obvious assumption is wrong in a way that would make this target quietly
# meaningless. The manifest step below runs `npm pack`, and npm runs `prepare`
# on pack even under `--ignore-scripts` (verified on npm 10.9.3), so `lib/` is
# rebuilt from the current tree on every run of this script. The existence
# check further down is therefore a fail-closed guard for the day that stops
# being true, not a routine precondition — an absent build must never quietly
# fall back to the source, which is the one thing this target exists not to
# check.
#
# It still belongs in `build-library` rather than in `lint`: `lint` runs on
# every change and this target pays for a full declaration build, while `src`
# gives the same answer for everything except the source-versus-declarations
# boundary.
TARGET=src
while [ $# -gt 0 ]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --target=*)
      TARGET="${1#--target=}"
      shift
      ;;
    *)
      echo "usage: $0 [--target src|lib]" >&2
      exit 2
      ;;
  esac
done
case "$TARGET" in
  src | lib) ;;
  *)
    echo "unknown target '$TARGET' — expected 'src' or 'lib'" >&2
    exit 2
    ;;
esac

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

# The document list comes from the tarball, not from this file.
#
# It used to be five hardcoded paths, which answers the wrong question: what
# matters is whether the documentation a *consumer receives* compiles, and the
# two lists drift in the direction that hides the problem. Add a document to
# `files` and it ships unchecked; the hardcoded list stays green because it
# never heard of it. (CHANGELOG.md was exactly that: shipped, never checked.)
#
# `--json` because the human-readable output is a formatted tree that would have
# to be scraped. npm rather than yarn: `yarn pack --dry-run` prints its manifest
# as log lines with no machine-readable mode.
#
# `--ignore-scripts` asks for the manifest without a build. npm honours it for
# the dependency lifecycle and *not* for `prepare` on `pack` — verified on npm
# 10.9.3, where the build runs anyway and prints to stdout, ahead of the JSON.
# So the stream is not assumed to be a manifest and the manifest is located in
# it below; a stream with no manifest in it is a failure, never an empty
# document list, which would report "every shipped document compiles" about
# nothing at all.
npm pack --dry-run --json --ignore-scripts > "$OUT/manifest.json"

python3 - "$OUT" "$OUT/manifest.json" <<'PY'
import json, pathlib, re, sys

out = pathlib.Path(sys.argv[1])

def is_manifest(value):
    """Whether a decoded value has the full shape `npm pack --json` produces.

    Every field npm puts there is required, not just `files`. A weaker test —
    "a list whose first element mentions files" — is satisfied by
    `[{"files": []}]`, which a lifecycle script could print for its own reasons,
    and accepting that hands back a document list that is merely short. Short is
    the failure mode that matters here: the whole point of reading the manifest
    is that nothing shipped goes unchecked.
    """
    if not isinstance(value, list) or not value:
        return False
    return all(
        isinstance(package, dict)
        and isinstance(package.get('name'), str)
        and isinstance(package.get('version'), str)
        and isinstance(package.get('filename'), str)
        and isinstance(package.get('files'), list)
        and package['files']
        and all(isinstance(entry, dict) and isinstance(entry.get('path'), str)
                for entry in package['files'])
        for package in value
    )


def manifest_in(stream):
    """The `npm pack --json` array, wherever a lifecycle script left it.

    Every candidate start is decoded rather than the first one accepted, and
    *one* has to survive `is_manifest`. Two would mean the stream contains
    something else shaped exactly like a pack manifest, and picking either would
    be a guess about which describes the tarball — so that is a failure too,
    rather than a coin toss that reports a document list nobody checked.
    """
    decoder = json.JSONDecoder()
    found = []
    for index, character in enumerate(stream):
        if character != '[':
            continue
        try:
            value, _ = decoder.raw_decode(stream[index:])
        except ValueError:
            continue
        if is_manifest(value):
            found.append(value)
    return found


candidates = manifest_in(pathlib.Path(sys.argv[2]).read_text())
if len(candidates) != 1:
    print(f'FAIL: `npm pack --json` left {len(candidates)} manifests to read, not 1')
    sys.exit(1)
manifest = candidates[0]
docs = sorted(
    entry['path']
    for package in manifest
    for entry in package.get('files', [])
    if entry['path'].lower().endswith('.md')
)

# A manifest that produced nothing, or almost nothing, would make every check
# below pass over an empty set — the failure this whole script exists to avoid,
# relocated into its own input. Three is below the number this package ships
# and above the number a broken manifest produces.
if len(docs) < 3:
    print(f'the tarball manifest lists {len(docs)} markdown document(s): '
          f'{docs or "none"}', file=sys.stderr)
    print('that is not the shipped documentation set; refusing to report a '
          'pass over it', file=sys.stderr)
    sys.exit(1)

print('documents from the tarball manifest: ' + ', '.join(docs))

fence = re.compile(r'```ts\n(.*?)```', re.S)

PKG = 'react-native-nitro-logger'
IMPORT = re.compile(r'^import\b.*?;?$', re.M | re.S)


def split_imports(body):
    """Separate whole import statements from the rest of a block.

    Statement-wise, not line-wise: the common form in these docs spans several
    lines, and splitting one mid-brace produces a syntax error that looks like
    a broken sample when it is not.
    """
    imports, rest = [], []
    lines = body.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('import '):
            stmt = [line]
            while ' from ' not in line and not line.rstrip().endswith(';'):
                i += 1
                if i >= len(lines):
                    break
                line = lines[i]
                stmt.append(line)
            imports.append('\n'.join(stmt))
        else:
            rest.append(line)
        i += 1
    return imports, rest


# Every opening fence that claims to be TypeScript, however spelled. Counted
# separately from what `fence` extracts so that a fence this script does not
# understand — ```typescript, or one left unclosed — is reported rather than
# silently skipped while the other documents keep the run green.
declared = re.compile(r'^```\s*(ts|typescript|tsx)\b', re.M | re.I)

blocks = 0
files = 0
skipped = 0
unmatched = []
for name in docs:
    path = pathlib.Path(name)
    if not path.exists():
        continue

    # One file per document, blocks concatenated in reading order at module
    # scope. Samples in these docs deliberately build on each other — a later
    # block uses the `file` an earlier one constructed, without repeating the
    # import — and that is how they are meant to be read. Checking each block
    # in isolation would flag good documentation style as an error.
    text = path.read_text()
    found = fence.findall(text)
    claimed = len(declared.findall(text))
    if claimed != len(found):
        unmatched.append(f'{name}: {claimed} TypeScript fence(s) opened, '
                         f'{len(found)} extracted')

    named, others, bodies = [], [], []
    for body in found:
        if body.lstrip().startswith('// doc-check: skip'):
            skipped += 1
            continue
        blocks += 1
        head, rest = split_imports(body)
        for stmt in head:
            # Named imports of this package are merged into one statement,
            # because two blocks that each import `Log` are correct in the
            # document and a redeclaration in the concatenation.
            m = re.match(r'import\s*\{(.*?)\}\s*from\s*[\'"]([^\'"]+)[\'"]',
                         stmt, re.S)
            if m and m.group(2) == PKG:
                named.extend(s.strip() for s in m.group(1).split(',') if s.strip())
            elif stmt not in others:
                others.append(stmt)
        bodies.append('\n'.join(rest).strip())

    if not bodies:
        continue

    head = list(others)
    if named:
        head.insert(0, 'import {\n'
                    + ''.join(f'  {s},\n' for s in dict.fromkeys(named))
                    + f"}} from '{PKG}';")

    stem = f'{path.parent.name}-{path.stem}'.strip('-').replace('.', '-')
    (out / f'{stem}.ts').write_text(
        '\n'.join(head) + '\n\n' + '\n\n'.join(bodies) + '\n'
    )
    files += 1

if unmatched:
    for line in unmatched:
        print(f'unreadable fence — {line}', file=sys.stderr)
    print('a TypeScript fence was opened that this script did not extract; '
          'it would have gone unchecked', file=sys.stderr)
    sys.exit(1)

print(f'extracted {blocks} sample(s) from {files} document(s)'
      + (f', {skipped} skipped' if skipped else ''))
PY

count=$(find "$OUT" -name '*.ts' | wc -l | tr -d ' ')
if [ "$count" = "0" ]; then
  echo "no samples found — the fence pattern probably stopped matching"
  exit 1
fi

# Where the specifier resolves, which is the whole difference between the two
# targets. `paths` is only accepted from a config file, hence writing one
# rather than passing flags.
if [ "$TARGET" = lib ]; then
  # Read from the manifest rather than written down here: `exports` is what
  # decides where a consumer's `import` lands, and a second copy of that answer
  # in this script is a second thing to keep correct. The `import`/`types`
  # condition is the one a bundler and `tsc --moduleResolution bundler` take.
  ENTRY_TYPES="$(node -p "require('./package.json').exports['.'].import.types")"
  UNSTABLE_TYPES="$(node -p "require('./package.json').exports['./unstable'].import.types")"
  for declaration in "$ENTRY_TYPES" "$UNSTABLE_TYPES"; do
    if [ ! -f "$declaration" ]; then
      echo "no declarations at $declaration."
      echo "The pack step above normally rebuilds them; if it no longer does,"
      echo "run \`yarn prepare\`. This target checks the PUBLISHED surface, so"
      echo "an absent build is a failure rather than a reason to fall back to"
      echo "the source — which would check nothing this target exists for."
      exit 1
    fi
  done
  ENTRY="$(pwd)/$ENTRY_TYPES"
  UNSTABLE_PATH="\"react-native-nitro-logger/unstable\": [\"$(pwd)/$UNSTABLE_TYPES\"],"
else
  ENTRY="$(pwd)/src/index.tsx"
  UNSTABLE_PATH=""
fi

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
      $UNSTABLE_PATH
      "react-native-nitro-logger/*": ["$(pwd)/*"]
    }
  },
  "include": ["$OUT/*.ts"]
}
JSON

# The one command allowed to fail: under `set -e` its non-zero status would
# otherwise abort the script before anything could be reported about it.
if npx tsc -p "$OUT/tsconfig.json"; then
  echo "every documentation sample typechecks against $TARGET ($count document(s))"
else
  echo "documentation samples do not compile against $TARGET"
  exit 1
fi
