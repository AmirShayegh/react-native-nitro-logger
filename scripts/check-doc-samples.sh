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
# `--ignore-scripts` because packing must not trigger a build here, and `--json`
# because the human-readable output is a formatted tree that would have to be
# scraped. npm rather than yarn: `yarn pack --dry-run` prints its manifest as
# log lines with no machine-readable mode.
npm pack --dry-run --json --ignore-scripts > "$OUT/manifest.json"

python3 - "$OUT" "$OUT/manifest.json" <<'PY'
import json, pathlib, re, sys

out = pathlib.Path(sys.argv[1])

manifest = json.loads(pathlib.Path(sys.argv[2]).read_text())
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

# Resolve `react-native-nitro-logger` to the local source, so samples are
# checked against this working tree rather than whatever is installed. `paths`
# is only accepted from a config file, hence writing one rather than passing
# flags.
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
      "react-native-nitro-logger": ["$(pwd)/src/index.tsx"],
      "react-native-nitro-logger/*": ["$(pwd)/*"]
    }
  },
  "include": ["$OUT/*.ts"]
}
JSON

# The one command allowed to fail: under `set -e` its non-zero status would
# otherwise abort the script before anything could be reported about it.
if npx tsc -p "$OUT/tsconfig.json"; then
  echo "every documentation sample typechecks ($count document(s))"
else
  echo "documentation samples do not compile against this tree"
  exit 1
fi
