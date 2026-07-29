#!/usr/bin/env bash
#
# The export map must hand every consumer an artifact it can actually load.
#
# Through 0.1.2 the package shipped ESM only: `exports["."]` had no `require`
# condition and the single `module` target emitted `import`/`export` under a
# `{"type":"module"}` marker. A React Native app's stock Jest — which uses
# @react-native/jest-preset, whose transformIgnorePatterns allowlist is
# `node_modules/(?!((jest-)?react-native|@react-native(-community)?)/)` and so
# does NOT cover `react-native-nitro-logger` — got the ESM file untransformed
# in a CJS context and died with "Cannot use import statement outside a module"
# before a single test ran.
#
# Design notes, because the obvious version of this proves nothing:
#
#   * Assert WHICH FILE each condition resolves to. Loading the package is not
#     a resolution test: `src/index.tsx` and `lib/commonjs/index.js` both throw
#     the same "NitroModules Turbo/Native-Module could not be found" outside an
#     app, so a load-based probe passes identically whichever one it picked.
#   * Never read the resolved path out of a stack trace. bob emits .js.map, so
#     Jest reports frames at their ORIGINAL `src/index.tsx` position while
#     actually executing `lib/commonjs/index.js` — which looks exactly like the
#     bug this guards against.
#   * Run from a temp directory outside the monorepo, against the packed
#     tarball. In-repo, workspace links and the
#     `react-native-nitro-logger-source` condition resolve to `src/`, so the
#     shipped export map is never exercised at all.
#   * Check the resolved files are the DIALECT they claim. A `require` entry
#     containing `import` syntax resolves fine and fails at load.
set -uo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
note() { printf '  %-4s %s\n' "$1" "$2"; }

echo "==> packing the tarball"
TARBALL="$(cd "$WORK" && npm pack "$REPO" --silent 2>/dev/null | tail -1)"
if [ -z "${TARBALL:-}" ] || [ ! -f "$WORK/$TARBALL" ]; then
  echo "could not pack the package"
  exit 1
fi
TARBALL="$WORK/$TARBALL"
echo "  ok   $(basename "$TARBALL")"

# ---------------------------------------------------------------------------
# A consumer project, outside this repository
# ---------------------------------------------------------------------------
FIXTURE="$WORK/consumer"
mkdir -p "$FIXTURE/__tests__"
cd "$FIXTURE" || exit 1

cat > package.json <<'EOF'
{ "name": "exports-consumer", "private": true, "version": "1.0.0" }
EOF
cat > babel.config.js <<'EOF'
module.exports = { presets: ['@react-native/babel-preset'] };
EOF
cat > jest.config.js <<'EOF'
module.exports = { preset: '@react-native/jest-preset' };
EOF

# Reports the file Jest's resolver selected. `require.resolve` is the resolver
# answering directly, so no source map sits between the answer and the check.
cat > __tests__/resolution.test.js <<'EOF'
test('jest resolves the package to a CommonJS entry', () => {
  const resolved = require.resolve('react-native-nitro-logger');
  console.log('JEST_RESOLVED=' + resolved.split('node_modules/').pop());
});
EOF

echo "==> installing the tarball into a consumer project"
if ! npm install --silent --no-audit --no-fund --no-package-lock \
  "$TARBALL" react-native react-native-nitro-modules \
  jest@29 babel-jest@29 @babel/core @babel/runtime \
  @react-native/babel-preset @react-native/jest-preset \
  >"$WORK/install.log" 2>&1; then
  echo "consumer install failed:"
  sed -n '1,8p' "$WORK/install.log"
  exit 1
fi
note ok "installed outside the monorepo"

PKG="$FIXTURE/node_modules/react-native-nitro-logger"

# resolves <label> <expected suffix> <actual>
resolves() {
  local label="$1" want="$2" got="$3"
  if [ "$got" = "$want" ]; then
    note ok "$label -> $got"
  else
    note FAIL "$label -> $got (expected $want)"
    failures=$((failures + 1))
  fi
}

echo "==> which entry each condition selects"
CJS="$(node -e "console.log(require.resolve('react-native-nitro-logger').split('node_modules/').pop())" 2>/dev/null)"
resolves "node require" "react-native-nitro-logger/lib/commonjs/index.js" "$CJS"

ESM="$(node --input-type=module -e "console.log((await import.meta.resolve('react-native-nitro-logger')).split('node_modules/').pop())" 2>/dev/null)"
resolves "node import " "react-native-nitro-logger/lib/module/index.js" "$ESM"

JEST="$(npx jest __tests__/resolution.test.js 2>&1 | grep -o 'JEST_RESOLVED=.*' | head -1 | cut -d= -f2-)"
resolves "jest        " "react-native-nitro-logger/lib/commonjs/index.js" "$JEST"

echo "==> each entry is the dialect its condition promises"
# A file is only CommonJS if BOTH the syntax and the nearest `type` marker say
# so. bob writes lib/<target>/package.json, and getting that marker wrong is
# how an otherwise correct-looking build fails at require().
DIALECT="$(node -e '
  const fs = require("fs"), path = require("path");
  const pkg = process.argv[1];
  const problems = [];
  const check = (dir, wantType, wantSyntax) => {
    const entry = path.join(pkg, "lib", dir, "index.js");
    if (!fs.existsSync(entry)) { problems.push(dir + ": no index.js"); return; }
    const marker = path.join(pkg, "lib", dir, "package.json");
    const type = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf8")).type : "(none)";
    if (type !== wantType) problems.push(`${dir}: type marker is ${type}, expected ${wantType}`);
    const src = fs.readFileSync(entry, "utf8");
    const hasEsm = /^\s*(import|export)\s/m.test(src);
    if (wantSyntax === "esm" && !hasEsm) problems.push(dir + ": expected ESM syntax, found none");
    if (wantSyntax === "cjs" && hasEsm) problems.push(dir + ": CommonJS entry contains ESM syntax");
  };
  check("commonjs", "commonjs", "cjs");
  check("module", "module", "esm");
  console.log(problems.length ? "FAIL|" + problems.join("; ") : "PASS");
' "$PKG" 2>&1)"
if [[ "$DIALECT" == PASS* ]]; then
  note ok "commonjs is CJS, module is ESM, both markers agree"
else
  note FAIL "${DIALECT#FAIL|}"
  failures=$((failures + 1))
fi

echo "==> the types each condition points at exist"
TYPES="$(node -e '
  const fs = require("fs"), path = require("path");
  const pkg = process.argv[1];
  const map = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).exports["."];
  const problems = [];
  for (const cond of ["require", "import"]) {
    const t = map[cond] && map[cond].types;
    if (!t) { problems.push(cond + ": no types condition"); continue; }
    if (!fs.existsSync(path.join(pkg, t))) problems.push(cond + ": types missing at " + t);
  }
  console.log(problems.length ? "FAIL|" + problems.join("; ") : "PASS");
' "$PKG" 2>&1)"
if [[ "$TYPES" == PASS* ]]; then
  note ok "require and import each ship their own declarations"
else
  note FAIL "${TYPES#FAIL|}"
  failures=$((failures + 1))
fi

echo "==> what Metro selects"
# Metro is the consumer Node cannot speak for. It sets
# `unstable_enablePackageExports: true` but matches only the conditions in
# `unstable_conditionNames` — Metro's own default is `[]`, and a React Native
# app via @react-native/metro-config gets `["react-native"]`. Neither includes
# `require` or `import`, so BOTH fall through to `default`.
#
# That makes `default` load-bearing in a way Node can never reveal: point it at
# the CommonJS build and `require`/`import`/Jest all still resolve correctly
# while every Metro bundle silently switches artifact. The conditions are read
# from the installed Metro rather than written down here, so this stops being
# true the moment Metro changes it.
METRO="$(node -e '
  const fs = require("fs"), path = require("path");
  const [pkgDir, fixture] = process.argv.slice(1);
  const exp = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).exports["."];

  // The condition sets Metro actually uses, read from Metro itself.
  const sets = {};
  try {
    const mc = require(require.resolve("metro-config", { paths: [fixture] }));
    sets["metro default"] = [];   // getDefaultConfig is async; [] is its documented default
  } catch {}
  try {
    const rn = require(require.resolve("@react-native/metro-config", { paths: [fixture] }));
    const d = rn.getDefaultConfig(fixture);
    sets["react native"] = d.resolver.unstable_conditionNames ?? [];
  } catch { sets["react native"] = ["react-native"]; }

  // The spec walk: first key whose condition is active wins; `default` always is.
  const pick = (node, active) => {
    if (typeof node === "string") return node;
    for (const [key, value] of Object.entries(node)) {
      if (key === "default" || active.includes(key)) {
        const hit = pick(value, active);
        if (hit) return hit;
      }
    }
    return null;
  };

  const problems = [];
  for (const [label, conditions] of Object.entries(sets)) {
    const got = pick(exp, conditions);
    if (got !== "./lib/module/index.js") {
      problems.push(`${label} (${JSON.stringify(conditions)}) -> ${got}, expected ./lib/module/index.js`);
    }
  }
  console.log(problems.length ? "FAIL|" + problems.join("; ") : "PASS|" + Object.keys(sets).join(", "));
' "$PKG" "$FIXTURE" 2>&1)"
if [[ "$METRO" == PASS* ]]; then
  note ok "falls through to default -> lib/module (${METRO#PASS|})"
else
  note FAIL "${METRO#FAIL|}"
  failures=$((failures + 1))
fi

echo "==> the source condition stays out of a consumer's way"
# `react-native-nitro-logger-source` exists for the in-repo example app. If a
# consumer ever resolved through it they would get TypeScript, which their
# bundler is under no obligation to compile.
if grep -q "src/index.tsx" <<< "$CJS$ESM$JEST"; then
  note FAIL "a consumer resolved to src/ — the source condition leaked"
  failures=$((failures + 1))
else
  note ok "no consumer resolved to src/"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures package-export check(s) failed"
  exit 1
fi
echo "every consumer entry point resolves to the artifact it should"
