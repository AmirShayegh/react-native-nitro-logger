#!/usr/bin/env bash
#
# The documented ESLint setup must actually lint the files a consumer has.
#
# This exists because it did not. Through 0.1.0 and 0.1.1 all three documents
# printed a config built from `configs.strict`, which carries no `files` key —
# so under ESLint flat config it applied only to `.js`, `.mjs` and `.cjs`. In a
# React Native app, which is TypeScript, it matched nothing: `eslint .` printed
# no findings and exited 0, and `eslint src/app.ts` answered "File ignored
# because no matching configuration was supplied". Message text, correlation
# IDs and subsystems have no runtime redaction, so those rules were the entire
# protection, and their silence was indistinguishable from compliance.
#
# THE REPOSITORY CANNOT CATCH THIS ON ITSELF. Its own `eslint.config.mjs`
# inherits `files` and a TypeScript parser from `@react-native/eslint-config`,
# which supplies exactly what the shipped config was missing. Every run in CI
# was green while the published config was inert. So this check builds the
# tarball and runs it the way a stranger would, from outside the repository.
#
# Design notes, because the obvious version of this script passes for the wrong
# reason:
#
#   * Assert on PARSED JSON, never on the exit code. ESLint exits nonzero for a
#     parse error and for a configuration error too, so "it exited nonzero"
#     would be satisfied by the very breakage this is meant to detect.
#   * Assert exact files AND exact rule IDs, plus clean controls that must
#     report nothing. A count alone passes when the wrong file is flagged.
#   * Give each parser case its OWN dependency tree, and prove the parser is
#     absent with `require.resolve` before the missing-parser case runs.
#     A package manager that auto-installs a peer would otherwise turn that
#     case into the success path without saying so.
#   * Take the config from the documentation rather than retyping it, so the
#     docs cannot rot while this stays green.
#
# Not in the default CI matrix by accident: it is wired into the lint job.
set -uo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
note() { printf '  %-4s %s\n' "$1" "$2"; }

# ---------------------------------------------------------------------------
# The three documented snippets
# ---------------------------------------------------------------------------
# Marked in the source documents so this cannot drift from them. Equality alone
# would be satisfied by three identically WRONG snippets, so the agreed text is
# then executed below.
echo "==> extracting the documented config from all three documents"
python3 - "$WORK" <<'PY'
import pathlib, re, sys

work = pathlib.Path(sys.argv[1])
docs = ['README.md', 'docs/PRIVACY.md', 'eslint-plugin/README.md']
block = re.compile(
    r'<!-- eslint-setup:begin -->\s*```js\n(.*?)```\s*<!-- eslint-setup:end -->',
    re.S)

found = {}
for doc in docs:
    text = pathlib.Path(doc).read_text()
    match = block.search(text)
    if match is None:
        sys.exit(f'FAIL {doc} has no <!-- eslint-setup --> block to extract')
    found[doc] = match.group(1)

# Normalized comparison: the documents differ in their `// eslint.config` hint
# line, which is prose, not configuration.
def normalized(text):
    lines = [l.rstrip() for l in text.strip().splitlines()]
    return '\n'.join(l for l in lines if l and not l.startswith('//'))

bodies = {doc: normalized(src) for doc, src in found.items()}
distinct = set(bodies.values())
if len(distinct) != 1:
    for doc, body in bodies.items():
        print(f'--- {doc}\n{body}')
    sys.exit('FAIL the three documented snippets are not equivalent')

canonical = found['README.md']
(work / 'eslint.config.mjs').write_text(canonical)
print('  ok   all three documents agree; using the README copy')
print('  ---- ' + '\n  ---- '.join(canonical.strip().splitlines()))
PY
[ $? -eq 0 ] || exit 1

# ---------------------------------------------------------------------------
# Pack once, reuse for every case
# ---------------------------------------------------------------------------
echo "==> packing the tarball"
TARBALL="$(cd "$WORK" && npm pack "$REPO" --silent 2>/dev/null | tail -1)"
if [ -z "${TARBALL:-}" ] || [ ! -f "$WORK/$TARBALL" ]; then
  echo "could not pack the package"
  exit 1
fi
TARBALL="$WORK/$TARBALL"
echo "  ok   $(basename "$TARBALL")"

ESLINT_VERSION="$(node -p "require('$REPO/package.json').devDependencies.eslint")"
VERIFIED_RANGE="$(node -p "require('$REPO/eslint-plugin').VERIFIED_PARSER_RANGE")"

# The parser peer must stay unconstrained. `optional` only says the package may
# be ABSENT — npm still enforces the RANGE when it is present, so any floor
# here becomes an ERESOLVE for a consumer whose parser already works.
# @react-native/eslint-config@0.78 pins parser ^7.1.1, which a `>=8` floor
# would reject outright.
PEER_RANGE="$(node -p "require('$REPO/package.json').peerDependencies['@typescript-eslint/parser']")"
if [ "$PEER_RANGE" != "*" ]; then
  echo "the parser peer is '$PEER_RANGE'; it must be '*' so no consumer's"
  echo "existing parser can fail to resolve against it"
  exit 1
fi

# The ends of the range CI proves, resolved from the registry rather than
# written down, so widening the range cannot widen it past what is exercised.
PARSER_LOCKED="$(node -p "require('$REPO/package.json').devDependencies['@typescript-eslint/parser']")"
PARSER_LOWEST="$(npm view "@typescript-eslint/parser@$VERIFIED_RANGE" version --json 2>/dev/null \
  | python3 -c "import json,sys; v=json.load(sys.stdin); print(v[0] if isinstance(v,list) else v)")"
if [ -z "${PARSER_LOWEST:-}" ]; then
  echo "could not resolve the lowest parser version in range $VERIFIED_RANGE"
  exit 1
fi

# TypeScript is pinned per case rather than left to npm. The parser's own peer
# decides which TypeScript it accepts, and the oldest parsers declare no
# TypeScript peer at all — left alone, npm gives 8.0.0 a TypeScript 6 it cannot
# read and it dies on `BarBarToken`, which looks like a plugin bug and is not.
TS_LOCKED="$(node -p "require('$REPO/package.json').devDependencies.typescript")"
TS_FOR_LOWEST="$(npm view "@typescript-eslint/parser@$PARSER_LOWEST" peerDependencies.typescript 2>/dev/null)"
TS_FOR_LOWEST="${TS_FOR_LOWEST:-<5.6.0}"
echo "  ok   parser peer is unconstrained ('*'); verifying $VERIFIED_RANGE"

# The package manager itself. Peer auto-install behaviour — which decides
# whether the missing-parser cases test anything — changed across npm majors,
# so a gate that reasons about it has to say which npm it observed.
NPM_VERSION="$(npm --version)"
NPM_MAJOR="${NPM_VERSION%%.*}"
if [ "$NPM_MAJOR" -lt 7 ]; then
  echo "npm $NPM_VERSION predates automatic peer installation; this gate's"
  echo "missing-parser cases would not mean what they claim"
  exit 1
fi
echo "  ok   npm $NPM_VERSION (>=7, the behaviour these cases assume)"

# fixture <dir> <config-expression> [parser-spec] [typescript-spec]
# Fails loudly if the consumer install does not succeed: npm can exit nonzero
# and still leave a partially usable tree, which would let every check below
# pass while a real consumer installation was broken.
fixture() {
  local dir="$WORK/$1" config="$2" parser="${3:-}" typescript="${4:-}"
  mkdir -p "$dir"
  cd "$dir" || return 1

  cat > package.json <<EOF
{ "name": "consumer-$1", "private": true, "type": "module", "version": "1.0.0" }
EOF

  # The documented snippet, with only the config selector substituted, so the
  # shape under test stays the documented shape.
  sed "s|nitroLogger.configs.strictTypeScript|nitroLogger.configs.$config|" \
    "$WORK/eslint.config.mjs" > eslint.config.mjs

  # Same violation in each language. `patient.name` interpolated into the
  # message is the leak the rules exist to stop.
  for ext in ts tsx js; do
    cat > "violating.$ext" <<'EOF'
import { Log } from 'react-native-nitro-logger';
const patient = { name: 'Jane Doe' };
Log.info(`patient ${patient.name} admitted`);
EOF
  done
  # Controls: the correct form must produce nothing at all.
  for ext in ts tsx js; do
    cat > "clean.$ext" <<'EOF'
import { Log } from 'react-native-nitro-logger';
const patient = { name: 'Jane Doe' };
Log.info('patient admitted', { patientName: patient.name });
EOF
  done

  local deps=("eslint@$ESLINT_VERSION" "$TARBALL")
  [ -n "$parser" ] && deps+=("@typescript-eslint/parser@$parser")
  [ -n "$typescript" ] && deps+=("typescript@$typescript")

  local log="$dir/npm-install.log"
  if ! npm install --silent --no-audit --no-fund --no-package-lock \
    --install-strategy=nested "${deps[@]}" >"$log" 2>&1; then
    note FAIL "npm install failed for '$1' — a consumer could not install this"
    sed -n '1,6p' "$log" | sed 's/^/       /'
    failures=$((failures + 1))
    cd "$REPO" || return 1
    return 1
  fi
  cd "$REPO" || return 1
}

# Does this fixture resolve the parser? Proving absence matters: if a peer got
# auto-installed, the "missing parser" case would quietly become the success
# case and this whole script would attest to nothing.
parser_present() {
  node -e "require.resolve('@typescript-eslint/parser',{paths:['$WORK/$1']})" \
    >/dev/null 2>&1
}

# Assert on the JSON: which files carry which rule IDs, and no fatal errors.
# expect_findings <fixture> <files that must report> <label> <files to lint>
#
# The lint set is a parameter because the JavaScript-only config is SUPPOSED to
# ignore TypeScript. Handing it a `.ts` file and calling the resulting "File
# ignored" a failure would test the documented behaviour backwards.
expect_findings() {
  local dir="$1" expected="$2" label="$3" targets="$4"
  local json
  # shellcheck disable=SC2086
  json="$(cd "$WORK/$dir" && node ./node_modules/eslint/bin/eslint.js \
    --format json $targets 2>/dev/null)"

  RESULT="$(EXPECTED="$expected" TARGETS="$targets" node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      let results;
      try { results = JSON.parse(raw); } catch { console.log("FAIL|eslint produced no JSON"); return; }
      const expected = new Set(process.env.EXPECTED.split(" ").filter(Boolean));
      const targets = process.env.TARGETS.split(" ").filter(Boolean);
      const RULE = "nitro-logger/no-dynamic-message";
      const problems = [];
      const flagged = new Set();
      const seen = [];

      for (const r of results) {
        const name = r.filePath.split("/").pop();
        seen.push(name);
        if (r.fatalErrorCount > 0) {
          const m = r.messages.find((x) => x.fatal) || r.messages[0];
          problems.push(`${name}: fatal — ${m && m.message}`);
        }
        for (const m of r.messages) {
          if (m.ruleId === RULE) flagged.add(name);
          else if (!m.fatal) problems.push(`${name}: unexpected ${m.ruleId || m.message}`);
        }
        if (/File ignored/.test(JSON.stringify(r.messages))) problems.push(`${name}: ignored, no matching config`);
      }

      // Every requested target must come back exactly once. Without this a
      // clean control that ESLint dropped entirely — ignored, unresolved,
      // silently skipped — never enters `flagged` and never enters `expected`,
      // so it satisfies both loops below while proving nothing at all.
      const counts = new Map();
      for (const name of seen) counts.set(name, (counts.get(name) || 0) + 1);
      for (const t of targets) {
        const n = counts.get(t) || 0;
        if (n === 0) problems.push(`${t}: requested but absent from the results`);
        else if (n > 1) problems.push(`${t}: reported ${n} times`);
      }
      for (const name of seen) {
        if (!targets.includes(name)) problems.push(`${name}: reported but never requested`);
      }

      // A control is clean only if it produced NOTHING — not merely nothing
      // from the rule under test.
      for (const r of results) {
        const name = r.filePath.split("/").pop();
        if (expected.has(name)) continue;
        if (r.messages.length || r.errorCount || r.warningCount) {
          problems.push(`${name}: control produced ${r.messages.length} message(s)`);
        }
      }

      for (const f of expected) if (!flagged.has(f)) problems.push(`${f}: expected ${RULE}, got nothing`);
      for (const f of flagged) if (!expected.has(f)) problems.push(`${f}: flagged but should be clean`);
      console.log(problems.length ? "FAIL|" + problems.join("; ") : "PASS|" + [...flagged].sort().join(","));
    });
  ' <<< "$json")"

  if [[ "$RESULT" == PASS* ]]; then
    note ok "$label — flagged ${RESULT#PASS|}"
  else
    note FAIL "$label — ${RESULT#FAIL|}"
    failures=$((failures + 1))
  fi
}

ALL_FILES="violating.ts violating.tsx violating.js clean.ts clean.tsx clean.js"
JS_FILES="violating.js clean.js"

echo "==> case 1: strictTypeScript, locked parser $PARSER_LOCKED + TypeScript $TS_LOCKED"
if fixture ts-locked strictTypeScript "$PARSER_LOCKED" "$TS_LOCKED"; then
  if parser_present ts-locked; then
    note ok "parser resolves, as this case requires"
    expect_findings ts-locked "violating.ts violating.tsx violating.js" \
      "all three languages" "$ALL_FILES"
  else
    note FAIL "parser did not install; this case cannot prove anything"
    failures=$((failures + 1))
  fi
fi

echo "==> case 2: strictTypeScript, lowest verified parser $PARSER_LOWEST + TypeScript '$TS_FOR_LOWEST'"
# TypeScript comes from THIS parser's own peer declaration, not from ours. The
# oldest parsers declare none, and letting npm pick gives them a TypeScript
# they cannot read — a failure that looks like a plugin bug and is not.
if fixture ts-lowest strictTypeScript "$PARSER_LOWEST" "$TS_FOR_LOWEST"; then
  if parser_present ts-lowest; then
    expect_findings ts-lowest "violating.ts violating.tsx violating.js" \
      "all three languages" "$ALL_FILES"
  else
    note FAIL "parser did not install; this case cannot prove anything"
    failures=$((failures + 1))
  fi
fi

echo "==> case 3: strict (JavaScript only), no parser installed"
if fixture js-only strict; then
  if parser_present js-only; then
    note FAIL "the parser is present, so this case does NOT test the missing-peer path"
    failures=$((failures + 1))
  else
    note ok "parser is genuinely absent"
    # The documented JS-only config must still work without the optional peer.
    expect_findings js-only "violating.js" "JavaScript, without the optional peer" "$JS_FILES"
  fi
fi

echo "==> case 4: strictTypeScript without the parser must fail actionably"
if fixture ts-noparser strictTypeScript; then
  if parser_present ts-noparser; then
    note FAIL "the parser is present, so this case does NOT test the missing-peer path"
    failures=$((failures + 1))
  else
    # Capture status separately: substring checks alone would accept a WARNING
    # that happened to contain these words while ESLint exited 0, which is the
    # silent-pass this whole script exists to rule out.
    OUT="$( (cd "$WORK/ts-noparser" && node ./node_modules/eslint/bin/eslint.js violating.ts) 2>&1 )"
    STATUS=$?
    problems=()
    [ "$STATUS" -eq 0 ] && problems+=("exited 0; it must fail closed")
    grep -qF 'react-native-nitro-logger/eslint-plugin:' <<< "$OUT" \
      || problems+=("no plugin error prefix")
    grep -qF '@typescript-eslint/parser' <<< "$OUT" || problems+=("does not name the parser")
    grep -qF 'npm install' <<< "$OUT" || problems+=("no install command")
    # It must not print a version range: the manifest enforces none, so naming
    # one would send a consumer to install something we do not require.
    grep -qE '[><]=?[[:space:]]*[0-9]+\.[0-9]+\.[0-9]+' <<< "$OUT" \
      && problems+=("names a version range the package does not enforce")
    # A parse error or an ignored file would also be a nonzero, wordy failure.
    grep -qF 'File ignored' <<< "$OUT" && problems+=("file was ignored, not parsed")
    grep -qF 'Parsing error' <<< "$OUT" && problems+=("parse error, not the intended message")

    if [ "${#problems[@]}" -eq 0 ]; then
      note ok "exits $STATUS, names the parser and the install command, promises no range"
    else
      note FAIL "$(IFS='; '; echo "${problems[*]}")"
      failures=$((failures + 1))
    fi
  fi
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures documented-ESLint-setup check(s) failed"
  exit 1
fi
echo "the documented ESLint setup lints TypeScript, TSX and JavaScript"
