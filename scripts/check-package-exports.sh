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
test('jest resolves the unstable subpath to a CommonJS entry', () => {
  const resolved = require.resolve('react-native-nitro-logger/unstable');
  console.log('JEST_RESOLVED_UNSTABLE=' + resolved.split('node_modules/').pop());
});
test('jest resolves the analytics subpath to a CommonJS entry', () => {
  const resolved = require.resolve('react-native-nitro-logger/analytics');
  console.log('JEST_RESOLVED_ANALYTICS=' + resolved.split('node_modules/').pop());
});
test('the packed CommonJS analytics artifact executes', () => {
  const {defineEvents, oneOf} = require('react-native-nitro-logger/analytics');
  const events = defineEvents({probe: {value: oneOf('ok')}});
  expect(events.validate('probe', {value: 'ok'}).ok).toBe(true);
  expect(events.validate('probe', {value: 'no'}).ok).toBe(false);
});
EOF

echo "==> installing the tarball into a consumer project"
if ! npm install --silent --no-audit --no-fund --no-package-lock \
  "$TARBALL" react-native react-native-nitro-modules \
  jest@29 babel-jest@29 @babel/core @babel/runtime \
  typescript \
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

if JEST_OUT="$(npx jest __tests__/resolution.test.js 2>&1)"; then
  :
else
  note FAIL "packed Jest runtime suite failed"
  sed -n '1,12p' <<< "$JEST_OUT"
  failures=$((failures + 1))
fi
# Each public entry is declared once so every resolution condition stays in
# lockstep as subpaths are added.
ENTRIES=(
  "|react-native-nitro-logger/lib/commonjs/index.js|react-native-nitro-logger/lib/module/index.js|JEST_RESOLVED"
  "/unstable|react-native-nitro-logger/lib/commonjs/unstable.js|react-native-nitro-logger/lib/module/unstable.js|JEST_RESOLVED_UNSTABLE"
  "/analytics|react-native-nitro-logger/lib/commonjs/analytics.js|react-native-nitro-logger/lib/module/analytics.js|JEST_RESOLVED_ANALYTICS"
)
RESOLVED_PATHS=""
for entry in "${ENTRIES[@]}"; do
  IFS='|' read -r subpath expected_cjs expected_esm jest_marker <<< "$entry"
  specifier="react-native-nitro-logger${subpath}"
  heading="${subpath:-root entry}"
  echo "==> which entry each condition selects for $heading"

  cjs="$(node -e "console.log(require.resolve(process.argv[1]).split('node_modules/').pop())" "$specifier" 2>/dev/null)"
  esm="$(node --input-type=module -e "console.log((await import.meta.resolve(process.argv[1])).split('node_modules/').pop())" "$specifier" 2>/dev/null)"
  jest="$(grep -o "${jest_marker}=.*" <<< "$JEST_OUT" | head -1 | cut -d= -f2-)"

  resolves "node require ${subpath}" "$expected_cjs" "$cjs"
  resolves "node import  ${subpath}" "$expected_esm" "$esm"
  resolves "jest         ${subpath}" "$expected_cjs" "$jest"
  RESOLVED_PATHS+="$cjs$esm$jest"
done

ESM_ANALYTICS="$(node --input-type=module -e "
  const {defineEvents, oneOf} = await import('react-native-nitro-logger/analytics');
  const events = defineEvents({probe: {value: oneOf('ok')}});
  if (!events.validate('probe', {value: 'ok'}).ok) process.exit(1);
  if (events.validate('probe', {value: 'no'}).ok) process.exit(1);
  console.log('PASS');
" 2>&1)"
if [ "$ESM_ANALYTICS" = "PASS" ]; then
  note ok "packed ESM /analytics executes its validator"
else
  note FAIL "packed ESM /analytics failed: $ESM_ANALYTICS"
  failures=$((failures + 1))
fi

cat > analytics-consumer.ts <<'EOF'
import {
  defineEvents,
  oneOf,
  type EventProperties,
} from 'react-native-nitro-logger/analytics';

const events = defineEvents({probe: {value: oneOf('ok', 'ready')}});
const properties: EventProperties<typeof events, 'probe'> = {value: 'ok'};
const result = events.validate('probe', properties);
if (result.ok && result.eventName === 'probe') {
  const value: 'ok' | 'ready' | object = result.properties.value;
  console.log(value);
}
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": []
  },
  "files": ["analytics-consumer.ts"]
}
EOF
if npx tsc -p tsconfig.json >"$WORK/analytics-types.log" 2>&1; then
  note ok "packed /analytics declarations type-check in a consumer"
else
  note FAIL "packed /analytics declarations do not type-check"
  sed -n '1,8p' "$WORK/analytics-types.log"
  failures=$((failures + 1))
fi

echo "==> ./unstable carries the names it promises"
# Resolution is not the whole claim: bob compiles the whole src tree, so a
# subpath can resolve to a file that exists and exports nothing under the name
# promised — a rename inside src/ does exactly that, silently.
#
# Read, never loaded, for the reason at the top of this file: importing this
# package outside an app fails on `react-native` itself (Flow syntax in a
# CommonJS context), so a load-based probe would report a missing export for a
# module that is perfectly fine. What this proves is that each built artifact
# declares the name; that calling it works needs a device, which is what the
# min-rn jobs are for.
NAMES="$(node -e '
  const fs = require("fs"), path = require("path");
  const pkg = process.argv[1];
  const want = ["createFileSink", "createNativeConsoleSink"];
  const targets = [
    ["lib/commonjs/unstable.js", (src, n) => new RegExp("exports\\." + n + "\\s*=").test(src)],
    ["lib/module/unstable.js", (src, n) => new RegExp("export\\b[^;]*\\b" + n + "\\b").test(src)],
    ["lib/typescript/commonjs/src/unstable.d.ts", (src, n) => new RegExp("declare (function|const) " + n + "\\b").test(src)],
    ["lib/typescript/module/src/unstable.d.ts", (src, n) => new RegExp("declare (function|const) " + n + "\\b").test(src)],
  ];
  const problems = [];
  for (const [rel, has] of targets) {
    const file = path.join(pkg, rel);
    if (!fs.existsSync(file)) { problems.push(rel + ": missing"); continue; }
    const src = fs.readFileSync(file, "utf8");
    const missing = want.filter((n) => !has(src, n));
    if (missing.length) problems.push(rel + ": no export of " + missing.join(", "));
  }
  console.log(problems.length ? "FAIL|" + problems.join("; ") : "PASS");
' "$PKG" 2>&1)"
if [[ "$NAMES" == PASS* ]]; then
  note ok "every built /unstable artifact exports both sink factories"
else
  note FAIL "${NAMES#FAIL|}"
  failures=$((failures + 1))
fi

echo "==> ./analytics carries the names it promises"
ANALYTICS_NAMES="$(node -e '
  const fs = require("fs"), path = require("path");
  const pkg = process.argv[1];
  const functions = ["defineEvents", "int", "namedString", "oneOf", "optional", "screenName"];
  const types = ["EventArtifact", "EventName", "EventProperties", "ValidationResult"];
  const jsTargets = [
    ["lib/commonjs/analytics.js", (src, n) =>
      new RegExp("exports\\." + n + "\\s*=").test(src) ||
      new RegExp("Object\\.defineProperty\\(exports,\\s*\\\"" + n + "\\\"").test(src)],
    ["lib/module/analytics.js", (src, n) => new RegExp("export\\b[^;]*\\b" + n + "\\b").test(src)],
  ];
  const declarationTargets = [
    "lib/typescript/commonjs/src/analytics.d.ts",
    "lib/typescript/module/src/analytics.d.ts",
  ];
  const problems = [];
  for (const [rel, has] of jsTargets) {
    const file = path.join(pkg, rel);
    if (!fs.existsSync(file)) { problems.push(rel + ": missing"); continue; }
    const src = fs.readFileSync(file, "utf8");
    const missing = functions.filter((name) => !has(src, name));
    if (missing.length) problems.push(rel + ": no export of " + missing.join(", "));
  }
  for (const rel of declarationTargets) {
    const file = path.join(pkg, rel);
    if (!fs.existsSync(file)) { problems.push(rel + ": missing"); continue; }
    const src = fs.readFileSync(file, "utf8");
    const names = [...functions, ...types];
    const missing = names.filter((name) => {
      const direct = new RegExp("export (declare )?(function|interface|type) " + name + "\\b").test(src);
      const reexport = new RegExp("export(?:\\s+type)?\\s*\\{[\\s\\S]*?\\b" + name + "\\b[\\s\\S]*?\\}\\s*from").test(src);
      return !direct && !reexport;
    });
    if (missing.length) problems.push(rel + ": no export of " + missing.join(", "));
  }
  console.log(problems.length ? "FAIL|" + problems.join("; ") : "PASS");
' "$PKG" 2>&1)"
if [[ "$ANALYTICS_NAMES" == PASS* ]]; then
  note ok "every built /analytics artifact exports its schema API"
else
  note FAIL "${ANALYTICS_NAMES#FAIL|}"
  failures=$((failures + 1))
fi

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
  const exp = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).exports;
  const problems = [];
  for (const entry of [".", "./unstable", "./analytics"]) {
    const map = exp[entry];
    if (!map) { problems.push(entry + ": no export map entry"); continue; }
    for (const cond of ["require", "import"]) {
      const t = map[cond] && map[cond].types;
      if (!t) { problems.push(entry + " " + cond + ": no types condition"); continue; }
      if (!fs.existsSync(path.join(pkg, t))) problems.push(entry + " " + cond + ": types missing at " + t);
    }
  }
  console.log(problems.length ? "FAIL|" + problems.join("; ") : "PASS");
' "$PKG" 2>&1)"
if [[ "$TYPES" == PASS* ]]; then
  note ok "all entries ship declarations for require and import"
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
  const all = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).exports;

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

  // Both entries, because `default` is load-bearing for each of them and a
  // subpath that falls through to the wrong artifact is invisible to Node.
  const wanted = {
    ".": "./lib/module/index.js",
    "./unstable": "./lib/module/unstable.js",
    "./analytics": "./lib/module/analytics.js",
  };
  const problems = [];
  for (const [entry, want] of Object.entries(wanted)) {
    for (const [label, conditions] of Object.entries(sets)) {
      const got = pick(all[entry], conditions);
      if (got !== want) {
        problems.push(`${entry} ${label} (${JSON.stringify(conditions)}) -> ${got}, expected ${want}`);
      }
    }
  }
  console.log(problems.length ? "FAIL|" + problems.join("; ") : "PASS|" + Object.keys(sets).join(", "));
' "$PKG" "$FIXTURE" 2>&1)"
if [[ "$METRO" == PASS* ]]; then
  note ok "all entries fall through to default -> lib/module (${METRO#PASS|})"
else
  note FAIL "${METRO#FAIL|}"
  failures=$((failures + 1))
fi

echo "==> the source condition stays out of a consumer's way"
# `react-native-nitro-logger-source` exists for the in-repo example app. If a
# consumer ever resolved through it they would get TypeScript, which their
# bundler is under no obligation to compile.
if grep -qE "src/(index\.tsx|unstable\.ts|analytics\.ts)" <<< "$RESOLVED_PATHS"; then
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
