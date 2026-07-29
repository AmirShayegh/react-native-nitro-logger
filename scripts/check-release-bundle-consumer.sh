#!/usr/bin/env bash
#
# Proves the reveal branches are absent from the artifact CONSUMERS bundle.
#
# `check-release-bundle.sh` builds from `example/`, whose metro.config.js sets
# `conditions: ['react-native-nitro-logger-source']` — the first key in this
# package's export map. So it bundles `src/index.tsx`. A real app has only the
# `react-native` condition and resolves `./lib/module/index.js` instead. The
# two are produced by different toolchains: src goes through the app's Babel,
# lib through bob. A reveal branch that survives bob's transform but not the
# app's would be invisible to the source-based check, which has therefore never
# said anything about what ships.
#
# Design notes:
#
#   * `lib/` is DELETED and rebuilt. Pointing the old check at `lib/` without
#     this would happily validate output from an edit two commits ago.
#   * The fixture lives outside the monorepo and installs the packed tarball.
#     Inside it, workspace links and the `-source` condition win and the shipped
#     files are never the ones bundled.
#   * Resolution is asserted BEFORE bundling: inside the fixture's own
#     node_modules, and under `lib/`, never `src/`. Otherwise a fixture that
#     silently reached back into the repo would produce a passing bundle that
#     proves nothing.
#   * The bundle's exit status is captured directly. `npx react-native bundle
#     ... | tail` reports tail's status, so a failed bundle reads as success and
#     the greps below run against a stale or missing file.
#   * Witnesses must be present. A sentinel is also absent when the module was
#     never bundled at all.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failed=0
note() { printf '  %-4s %s\n' "$1" "$2"; }

SENTINELS=(
  '__NITRO_LOGGER_PRIVATE_REVEAL__'
  '__NITRO_LOGGER_ERROR_REVEAL__'
)
declare -a WITNESSES=(
  '<private>:the privacy module'
  '<frame>:the error sanitiser'
)

echo "==> rebuilding lib/ from scratch"
rm -rf "$ROOT/lib"
# `yarn` may not be on PATH outside CI; corepack is what this repo pins.
YARN="yarn"
command -v yarn >/dev/null 2>&1 || YARN="corepack yarn"
if ! (cd "$ROOT" && $YARN prepare) >"$WORK/build.log" 2>&1; then
  echo "the library build failed:"
  tail -12 "$WORK/build.log"
  exit 1
fi
[ -f "$ROOT/lib/module/index.js" ] || { echo "lib/module/index.js was not produced"; exit 1; }
note ok "lib/ rebuilt, so nothing stale can be inspected"

echo "==> packing"
TARBALL="$(cd "$WORK" && npm pack "$ROOT" --silent 2>/dev/null | tail -1)"
[ -n "${TARBALL:-}" ] && [ -f "$WORK/$TARBALL" ] || { echo "could not pack"; exit 1; }
note ok "$TARBALL"

echo "==> building a consumer app outside the monorepo"
APP="$WORK/app"
mkdir -p "$APP"
cd "$APP" || exit 1

cat > package.json <<'EOF'
{ "name": "release-bundle-consumer", "private": true, "version": "1.0.0" }
EOF
# Stock config: no monorepo helper, no `-source` condition. This is the whole
# point — the app must resolve the package the way a stranger's app does.
cat > metro.config.js <<'EOF'
const { getDefaultConfig } = require('@react-native/metro-config');
module.exports = getDefaultConfig(__dirname);
EOF
cat > babel.config.js <<'EOF'
module.exports = { presets: ['@react-native/babel-preset'] };
EOF
# Reference enough surface that both gated modules are reachable; an
# unreferenced module is stripped, and its sentinel would be absent for the
# wrong reason.
cat > index.js <<'EOF'
import { Log, pub, priv } from 'react-native-nitro-logger';

export function boot() {
  Log.privacyDefault('private');
  Log.info('booted', { requestId: pub('r'), token: priv('t') });
  try {
    throw new Error('probe');
  } catch (error) {
    Log.error('failed', { message: priv(String(error)) });
  }
  return Log;
}
EOF

if ! npm install --silent --no-audit --no-fund --no-package-lock \
  "$WORK/$TARBALL" react-native react-native-nitro-modules react \
  @react-native/metro-config @react-native/babel-preset @react-native-community/cli \
  @babel/runtime >"$WORK/install.log" 2>&1; then
  echo "consumer install failed:"
  sed -n '1,8p' "$WORK/install.log"
  exit 1
fi
note ok "installed"

echo "==> the app resolves the shipped files, not this repository"
# Compare realpaths on both sides. On macOS `mktemp -d` hands back /var/... while
# `require.resolve` reports /private/var/..., and a naive prefix test calls a
# perfectly correct resolution "unexpected".
RESOLVED="$(node -e "console.log(require.resolve('react-native-nitro-logger'))" 2>/dev/null)"
APP_REAL="$(cd "$APP" && pwd -P)"
ROOT_REAL="$(cd "$ROOT" && pwd -P)"
case "$RESOLVED" in
  "$APP_REAL"/node_modules/react-native-nitro-logger/lib/*)
    note ok "-> ${RESOLVED#"$APP_REAL"/node_modules/}" ;;
  "$APP_REAL"/node_modules/react-native-nitro-logger/src/*)
    note FAIL "resolved to src/ — the source condition leaked into a consumer"
    failed=1 ;;
  "$ROOT_REAL"/*)
    note FAIL "resolved back into the repository at $RESOLVED"
    failed=1 ;;
  *)
    note FAIL "resolved somewhere unexpected: $RESOLVED"
    failed=1 ;;
esac
[ "$failed" -eq 0 ] || exit 1

echo "==> bundling for release (--dev false)"
BUNDLE="$APP/release.jsbundle"
npx react-native bundle --platform ios --dev false \
  --entry-file index.js --bundle-output "$BUNDLE" >"$WORK/bundle.log" 2>&1
STATUS=$?
if [ "$STATUS" -ne 0 ] || [ ! -s "$BUNDLE" ]; then
  echo "the release bundle was not produced (exit $STATUS):"
  tail -12 "$WORK/bundle.log"
  exit 1
fi
note ok "$(wc -c < "$BUNDLE" | tr -d ' ') bytes"

echo "==> reveal sentinels must be absent"
for sentinel in "${SENTINELS[@]}"; do
  if grep -qF "$sentinel" "$BUNDLE"; then
    note FAIL "$sentinel survived into the shipped artifact"
    failed=1
  else
    note ok "$sentinel absent"
  fi
done

echo "==> witnesses must be present, or the checks above are vacuous"
for witness in "${WITNESSES[@]}"; do
  token="${witness%%:*}"
  what="${witness#*:}"
  if grep -qF "$token" "$BUNDLE"; then
    note ok "$what is bundled (found '$token')"
  else
    note FAIL "'$token' missing — $what is not in the bundle, so its sentinel check proved nothing"
    failed=1
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  echo "the shipped artifact failed the privacy bundle check"
  exit 1
fi
echo "the artifact consumers bundle carries no reveal branch"
