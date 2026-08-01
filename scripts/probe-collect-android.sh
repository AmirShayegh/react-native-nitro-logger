#!/usr/bin/env bash
#
# Manual probe (see docs/HARDENING.md): collectForSupport() end-to-end on
# Android against a PUBLISHED registry artifact — real emulator, real
# rotation with compressed archives, real bundle.
#
# What it verifies, and why a green test suite cannot: the JVM suite stops
# at the adapter boundary by design, so append -> rotate -> compress ->
# collect through the real bridge, on a device filesystem, from the bytes
# npm actually serves, runs nowhere else. The bundle is pulled over a
# BINARY-SAFE channel (`exec-out`, never `shell`, which turns \n into \r\n)
# and verified independently by verify-bundle.js: the gzip members are
# counted out of the bytes and tied to the sourceFileCount native reported,
# system gzip is made to agree with that walk, and a line scan asserts every
# record arrived exactly once, in order, as valid JSON. Then the delete
# probe: returning true is not verification, so the script checks the file
# is actually gone.
#
#   NITRO_LOGGER_VERSION=0.4.0 ./scripts/probe-collect-android.sh
#
# Defaults to the version in package.json. Needs a booted emulator/device
# and ANDROID_HOME. PROBE_ROOT relocates the scratch tree; it lives under
# ~/.cache and deliberately not /tmp, because a probe's evidence should
# survive the tmp reaper.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SP="$ROOT/scripts/probes"
RN_VERSION=0.85.0
VERSION="${NITRO_LOGGER_VERSION:-$(node -p "require('$ROOT/package.json').version")}"
APP_NAME=NitroCollectProbeDroid
RUN_ID="collect-$(date +%Y%m%d%H%M%S)-$$"
RECORDS=60
: "${ANDROID_HOME:?set ANDROID_HOME (e.g. \$HOME/Library/Android/sdk)}"
ADB="$ANDROID_HOME/platform-tools/adb"

# The scratch tree is wiped at the start of every run, so the `rm -rf` is
# aimed at a FIXED leaf under the root and never at the root itself, and it
# refuses to delete a directory this probe did not create. Pointing
# PROBE_ROOT at a real directory must cost a failed precondition, not data.
PROBE_ROOT="${PROBE_ROOT:-$HOME/.cache/nitro-logger-probes}"
case "$PROBE_ROOT" in
  /*) ;;
  *) echo "FAIL: PROBE_ROOT must be an absolute path, got '$PROBE_ROOT'"; exit 1 ;;
esac
if [ "$PROBE_ROOT" = "/" ] || [ "$PROBE_ROOT" = "$HOME" ]; then
  echo "FAIL: refusing to use '$PROBE_ROOT' as the probe root"
  exit 1
fi
WORKDIR="$PROBE_ROOT/collect-android"
MARKER="$WORKDIR/.nitro-probe-workdir"
APP_DIR="$WORKDIR/$APP_NAME"
if [ -e "$WORKDIR" ]; then
  [ -f "$MARKER" ] || {
    echo "FAIL: $WORKDIR exists and no probe created it; refusing to delete it"
    exit 1
  }
  rm -rf "$WORKDIR"
fi
mkdir -p "$WORKDIR"
touch "$MARKER"

"$ADB" get-state >/dev/null 2>&1 || { echo "FAIL: no device/emulator attached"; exit 1; }

echo "==> Scaffolding React Native $RN_VERSION"
npx --yes @react-native-community/cli@latest init "$APP_NAME" \
  --version "$RN_VERSION" \
  --directory "$APP_DIR" \
  --skip-install --skip-git-init --install-pods false >"$WORKDIR/init.log" 2>&1 \
  || { echo "FAIL: scaffold"; tail -30 "$WORKDIR/init.log"; exit 1; }

cd "$APP_DIR"
npm pkg set "dependencies.react-native-nitro-logger=$VERSION"
npm pkg set 'dependencies.react-native-nitro-modules=^0.36.3'
for dev in eslint prettier jest @types/jest eslint-config-prettier \
           eslint-plugin-prettier @react-native/eslint-config; do
  npm pkg delete "devDependencies.$dev"
done
npm pkg delete scripts.lint scripts.test
npm install --legacy-peer-deps >"$WORKDIR/npm.log" 2>&1 \
  || { echo "FAIL: npm install"; tail -30 "$WORKDIR/npm.log"; exit 1; }

# The artifact under probe is the one the registry serves — prove it.
INSTALLED="$APP_DIR/node_modules/react-native-nitro-logger"
V="$(node -e 'console.log(require(process.argv[1]+"/package.json").version)' "$INSTALLED")"
[ "$V" = "$VERSION" ] || { echo "FAIL: installed $V, wanted $VERSION"; exit 1; }
# The .hpp, never the .cpp: the .cpp registers methods by NAME only, so a
# parameter-type grep there is vacuously satisfied in every version.
grep -q "ArrayBuffer" "$INSTALLED/nitrogen/generated/shared/c++/HybridFileSinkSpec.hpp" \
  || { echo "FAIL: installed spec is not the ArrayBuffer wire (0.4.0+)"; exit 1; }
echo "ok: probing react-native-nitro-logger@$V from the registry"

cp "$SP/AbiCollect.tsx" "$APP_DIR/App.tsx"
sed -i '' "s/__RUN_ID__/$RUN_ID/" "$APP_DIR/App.tsx"
grep -q "$RUN_ID" "$APP_DIR/App.tsx" || { echo "FAIL: run id not stamped"; exit 1; }

echo "==> Building the debug APK"
cd "$APP_DIR/android"
./gradlew assembleDebug >"$WORKDIR/gradle.log" 2>&1 \
  || { echo "FAIL: gradle"; grep -E "error:|FAILURE|Caused by" -A3 "$WORKDIR/gradle.log" | head -40; exit 1; }
APK="$(find "$APP_DIR/android/app/build/outputs/apk/debug" -name '*.apk' | head -1)"
[ -n "$APK" ] || { echo "FAIL: no apk"; exit 1; }

echo "==> Installing and starting Metro"
PKG="com.$(echo "$APP_NAME" | tr '[:upper:]' '[:lower:]')"
"$ADB" uninstall "$PKG" >/dev/null 2>&1 || true
"$ADB" install -r "$APK" >"$WORKDIR/install.log" 2>&1 \
  || { echo "FAIL: adb install"; tail -20 "$WORKDIR/install.log"; exit 1; }

cd "$APP_DIR"
npx react-native start --reset-cache >"$WORKDIR/metro.log" 2>&1 &
METRO_PID=$!
trap 'kill $METRO_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 40); do
  if curl -sf http://localhost:8081/status >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -sf http://localhost:8081/status >/dev/null 2>&1 \
  || { echo "FAIL: Metro never came up"; tail -20 "$WORKDIR/metro.log"; exit 1; }
"$ADB" reverse tcp:8081 tcp:8081 >/dev/null 2>&1 || true

echo "==> Launching"
"$ADB" logcat -c || true
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
"$ADB" logcat -v brief > "$WORKDIR/logcat.log" 2>&1 &
LOGCAT_PID=$!
trap 'kill $METRO_PID $LOGCAT_PID 2>/dev/null || true' EXIT

echo "==> Waiting for the collect verdict"
for _ in $(seq 1 90); do
  if grep -qF "ABI_COLLECT $RUN_ID" "$WORKDIR/logcat.log" 2>/dev/null; then break; fi
  sleep 2
done
LINE="$(grep -o "ABI_COLLECT $RUN_ID .*" "$WORKDIR/logcat.log" | head -1 || true)"
[ -n "$LINE" ] || { echo "FAIL: no collect verdict"; tail -30 "$WORKDIR/logcat.log"; exit 1; }
echo "--- verdict ---"
echo "$LINE"

echo "$LINE" | grep -q "complete:true" || { echo "FAIL: collect not complete"; exit 1; }
FILES="$(echo "$LINE" | grep -o 'files:[0-9]*' | cut -d: -f2)"
[ "$FILES" -ge 2 ] || { echo "FAIL: sourceFileCount=$FILES — rotation produced no archive, the multi-member property went untested; the probe is vacuous"; exit 1; }
BYTES="$(echo "$LINE" | grep -o 'bytes:[0-9]*' | cut -d: -f2)"
BUNDLE_PATH="$(echo "$LINE" | sed -n 's/.*path=//p')"
[ -n "$BUNDLE_PATH" ] || { echo "FAIL: no bundle path in verdict"; exit 1; }

echo "==> Pulling the bundle (binary-safe: exec-out, never shell)"
"$ADB" exec-out run-as "$PKG" cat "$BUNDLE_PATH" > "$WORKDIR/bundle.gz"
LOCAL=$(wc -c < "$WORKDIR/bundle.gz" | tr -d ' ')
[ "$LOCAL" -eq "$BYTES" ] \
  || { echo "FAIL: reported byteCount $BYTES but the file on device is $LOCAL"; exit 1; }
echo "ok: byteCount $BYTES matches the pulled file"

echo "==> Independent verification (member walk + system gzip + line scan)"
node "$SP/verify-bundle.js" "$WORKDIR/bundle.gz" "$RUN_ID" "$RECORDS" "$FILES" || exit 1

echo "==> Waiting for the delete verdict"
for _ in $(seq 1 30); do
  if grep -qF "ABI_COLLECT_DEL $RUN_ID" "$WORKDIR/logcat.log" 2>/dev/null; then break; fi
  sleep 2
done
DEL="$(grep -o "ABI_COLLECT_DEL $RUN_ID .*" "$WORKDIR/logcat.log" | head -1 || true)"
echo "$DEL"
echo "$DEL" | grep -q "deleted=true" || { echo "FAIL: deleteSupportBundle did not report true"; exit 1; }
if "$ADB" shell run-as "$PKG" ls "$BUNDLE_PATH" >/dev/null 2>&1; then
  echo "FAIL: deleteSupportBundle returned true but the bundle is still on the device — silent no-op"
  exit 1
fi
echo "ok: the bundle is actually gone from the device"

echo "PASS: collectForSupport end-to-end on Android against react-native-nitro-logger@$V"
