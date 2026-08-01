#!/usr/bin/env bash
#
# Manual probe (see docs/HARDENING.md): collectForSupport() end-to-end on
# iOS against a PUBLISHED registry artifact — Release build on a simulator,
# real rotation with compressed archives, real bundle.
#
# The swift-tests package cannot link Nitro by design, so append -> rotate
# -> compress -> collect through the real bridge, from the bytes npm
# actually serves, runs nowhere else. The simulator's container is
# host-visible, so the bundle is read straight off disk and verified
# independently by verify-bundle.js: the gzip members are counted out of the
# bytes and tied to the sourceFileCount native reported, system gzip is made
# to agree with that walk, and a line scan asserts every record arrived
# exactly once, in order, as valid JSON. Then the delete probe: the file
# must actually vanish.
#
#   NITRO_LOGGER_VERSION=0.4.0 ./scripts/probe-collect-ios.sh [simulator-udid]
#
# Defaults to the version in package.json. PROBE_ROOT relocates the scratch
# tree; it lives under ~/.cache and deliberately not /tmp, because a probe's
# evidence should survive the tmp reaper.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SP="$ROOT/scripts/probes"
RN_VERSION=0.85.0
VERSION="${NITRO_LOGGER_VERSION:-$(node -p "require('$ROOT/package.json').version")}"
APP_NAME=NitroCollectProbe
RUN_ID="collect-ios-$(date +%Y%m%d%H%M%S)-$$"
RECORDS=60

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
WORKDIR="$PROBE_ROOT/collect-ios"
MARKER="$WORKDIR/.nitro-probe-workdir"
APP_DIR="$WORKDIR/$APP_NAME"
VERDICTS="$WORKDIR/verdicts.txt"
if [ -e "$WORKDIR" ]; then
  [ -f "$MARKER" ] || {
    echo "FAIL: $WORKDIR exists and no probe created it; refusing to delete it"
    exit 1
  }
  rm -rf "$WORKDIR"
fi
mkdir -p "$WORKDIR"
touch "$MARKER"

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

echo "==> pod install"
export BUNDLE_GEMFILE="$APP_DIR/Gemfile"
if (cd "$APP_DIR" && bundle install >"$WORKDIR/bundle-gems.log" 2>&1); then
  POD=(bundle exec pod)
else
  POD=(pod)
fi
cd "$APP_DIR/ios"
"${POD[@]}" install >"$WORKDIR/pod.log" 2>&1 \
  || { echo "FAIL: pod install"; tail -40 "$WORKDIR/pod.log"; exit 1; }

echo "==> Choosing a simulator"
UDID="${1:-}"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const k of Object.keys(j.devices).sort().reverse()){const d=j.devices[k].find(x=>x.isAvailable&&/iPhone/.test(x.name));if(d){console.log(d.udid);break}}})')"
fi
[ -n "$UDID" ] || { echo "FAIL: no simulator"; exit 1; }
echo "using $UDID"

echo "==> Building Release"
DERIVED="$WORKDIR/derived"
xcodebuild -workspace "$APP_NAME.xcworkspace" -scheme "$APP_NAME" \
  -configuration Release -destination "id=$UDID" -derivedDataPath "$DERIVED" \
  build >"$WORKDIR/xcodebuild.log" 2>&1 \
  || { echo "FAIL: build"; grep -E "error:" -A2 "$WORKDIR/xcodebuild.log" | head -40; exit 1; }
APP_BUNDLE="$DERIVED/Build/Products/Release-iphonesimulator/$APP_NAME.app"
[ -d "$APP_BUNDLE" ] || { echo "FAIL: no .app"; exit 1; }

echo "==> Verdict channel"
rm -f "$VERDICTS"
node "$SP/verdict-server.js" "$VERDICTS" >"$WORKDIR/verdict-server.log" 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT
sleep 1
curl -sf -X POST -d 'selftest' http://localhost:8099/verdict >/dev/null \
  || { echo "FAIL: the verdict server is not reachable"; exit 1; }
rm -f "$VERDICTS"

echo "==> Launching"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP_BUNDLE/Info.plist")"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP_BUNDLE"
xcrun simctl launch "$UDID" "$BUNDLE_ID"

echo "==> Waiting for the collect verdict"
for _ in $(seq 1 60); do
  if grep -qF "ABI_COLLECT $RUN_ID" "$VERDICTS" 2>/dev/null; then break; fi
  sleep 2
done
LINE="$(grep -o "ABI_COLLECT $RUN_ID .*" "$VERDICTS" | head -1 || true)"
[ -n "$LINE" ] || { echo "FAIL: no collect verdict"; tail -10 "$VERDICTS" 2>/dev/null; exit 1; }
echo "--- verdict ---"
echo "$LINE"

echo "$LINE" | grep -q "complete:true" || { echo "FAIL: collect not complete"; exit 1; }
FILES="$(echo "$LINE" | grep -o 'files:[0-9]*' | cut -d: -f2)"
[ "$FILES" -ge 2 ] || { echo "FAIL: sourceFileCount=$FILES — rotation produced no archive, the multi-member property went untested; the probe is vacuous"; exit 1; }
BYTES="$(echo "$LINE" | grep -o 'bytes:[0-9]*' | cut -d: -f2)"
BUNDLE_PATH="$(echo "$LINE" | sed -n 's/.*path=//p')"
[ -f "$BUNDLE_PATH" ] || { echo "FAIL: reported bundle path does not exist: $BUNDLE_PATH"; exit 1; }

LOCAL=$(wc -c < "$BUNDLE_PATH" | tr -d ' ')
[ "$LOCAL" -eq "$BYTES" ] \
  || { echo "FAIL: reported byteCount $BYTES but the file is $LOCAL"; exit 1; }
echo "ok: byteCount $BYTES matches the file in the container"
cp "$BUNDLE_PATH" "$WORKDIR/bundle.gz"

echo "==> Independent verification (member walk + system gzip + line scan)"
node "$SP/verify-bundle.js" "$WORKDIR/bundle.gz" "$RUN_ID" "$RECORDS" "$FILES" || exit 1

echo "==> Waiting for the delete verdict"
for _ in $(seq 1 30); do
  if grep -qF "ABI_COLLECT_DEL $RUN_ID" "$VERDICTS" 2>/dev/null; then break; fi
  sleep 2
done
DEL="$(grep -o "ABI_COLLECT_DEL $RUN_ID .*" "$VERDICTS" | head -1 || true)"
echo "$DEL"
echo "$DEL" | grep -q "deleted=true" || { echo "FAIL: deleteSupportBundle did not report true"; exit 1; }
if [ -e "$BUNDLE_PATH" ]; then
  echo "FAIL: deleteSupportBundle returned true but the bundle still exists — silent no-op"
  exit 1
fi
echo "ok: the bundle is actually gone from the container"

echo "PASS: collectForSupport end-to-end on iOS against react-native-nitro-logger@$V"
