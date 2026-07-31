#!/usr/bin/env bash
#
# Compiles, launches and exercises this library inside a pristine consumer app
# on the OLDEST React Native it claims to support.
#
# The example app tracks the newest RN, so it proves nothing about the bottom of
# the range — and the bottom is where a compatibility claim actually gets
# tested. Nitro's generated bindings, the podspec, `min_ios_version_supported`,
# and every React header the vendored Swift touches are all things that moved
# between 0.78 and today.
#
# It installs a `yarn pack` tarball rather than a path dependency, so the file
# list in package.json is exercised too: a source file left out of `files` fails
# here rather than in someone's install.
#
# The app is generated from the community template each run instead of being
# vendored into this repo. A checked-in consumer app is a second app to keep
# building, and it stops being pristine the moment anyone touches it to fix a
# build.
#
# TOOLCHAIN: this needs an Xcode that React Native 0.78 itself supports — 16.x.
# 0.78 pins `fmt 11.0.2` through RCT-Folly, and clang from Xcode 26 rejects its
# `format-inl.h` ("call to consteval function ... is not a constant expression").
# That is upstream and has nothing to do with this library, but it means the
# check cannot run on a machine whose only Xcode is 26 or newer. Building 0.78
# with Xcode 26 also is not a combination any real consumer is in: an app on
# 0.78 is on the toolchain 0.78 shipped against, which is what CI pins.
#
# Usage: ./scripts/check-min-rn-ios.sh [simulator-udid]
# Env:   MIN_RN_VERSION (default 0.78.0), MIN_RN_WORKDIR, KEEP_WORKDIR=1

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RN_VERSION="${MIN_RN_VERSION:-0.78.0}"
WORKDIR="${MIN_RN_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/nitro-logger-minrn.XXXXXX")}"
APP_NAME="MinRnConsumer"
APP_DIR="$WORKDIR/$APP_NAME"

# Stamped into the app and required in the verdict line.
#
# The simulator keeps an app's data container across reinstalls of the same
# bundle identifier, so a log file from an earlier run outlives the app that
# wrote it. Without something unique per run, a build that never launches would
# be signed off by the previous run's PASS — the exact failure this job exists
# to catch, hiding in the job itself.
RUN_ID="run-$(date +%Y%m%d%H%M%S)-$$"

cleanup() {
  if [ "${KEEP_WORKDIR:-0}" != "1" ]; then rm -rf "$WORKDIR"; fi
}
trap cleanup EXIT

command -v xcodebuild >/dev/null || { echo "FAIL: xcodebuild is not available"; exit 1; }
XCODE_MAJOR="$(xcodebuild -version | sed -n '1s/Xcode \([0-9]*\).*/\1/p')"
if [ -n "$XCODE_MAJOR" ] && [ "$XCODE_MAJOR" -ge 26 ]; then
  echo "WARNING: Xcode $XCODE_MAJOR cannot build React Native $RN_VERSION."
  echo "         0.78 pins fmt 11.0.2, which clang from Xcode 26 rejects in"
  echo "         format-inl.h. This is upstream, not this library. Select an"
  echo "         Xcode 16.x with xcode-select, or read the result as unproven."
  echo "         Continuing anyway so the failure is visible rather than assumed."
fi

if command -v yarn >/dev/null 2>&1; then
  YARN=(yarn)
else
  YARN=(corepack yarn)
fi

echo "==> Building the library tarball"
cd "$ROOT"
"${YARN[@]}" prepare
TARBALL="$WORKDIR/react-native-nitro-logger.tgz"
"${YARN[@]}" pack --out "$TARBALL"

echo "==> Scaffolding React Native $RN_VERSION"
mkdir -p "$WORKDIR"
npx --yes @react-native-community/cli@15.1.3 init "$APP_NAME" \
  --version "$RN_VERSION" \
  --directory "$APP_DIR" \
  --skip-install \
  --skip-git-init \
  --install-pods false

echo "==> Installing the library into the consumer"
cd "$APP_DIR"
npm pkg set "dependencies.react-native-nitro-logger=file:$TARBALL"
npm pkg set 'dependencies.react-native-nitro-modules=^0.36.3'

# The template ships its own eslint/jest/prettier stack. This job builds and
# runs the app; it never lints or tests it, and those trees are a few hundred
# megabytes of download on every run.
for dev in eslint prettier jest @types/jest eslint-config-prettier \
           eslint-plugin-prettier @react-native/eslint-config; do
  npm pkg delete "devDependencies.$dev"
done
npm pkg delete scripts.lint scripts.test

npm install --legacy-peer-deps

# The smallest thing that is still a real exercise: open a file sink through
# the whole pipeline, write, flush, and record the outcome somewhere a shell
# can read it. A compile-only check would miss every runtime binding problem,
# which is most of what breaks across RN versions.
cat > "$APP_DIR/App.tsx" <<'APP'
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
// The root entry point only. `createFileSink` moved to
// `react-native-nitro-logger/unstable` in 0.3.0, and that subpath is
// deliberately NOT imported here: Metro 0.81 — what react-native@0.78.0 pins —
// defaults `unstable_enablePackageExports` to false, so a stock app at this
// repository's minimum supported RN cannot resolve any subpath export. That is
// a real constraint on consumers, recorded in the README, not something to
// route around by configuring this app differently from the one it stands in
// for.
import {
  Log,
  JsonLinesFormatter,
  createFileDestination,
  pub,
} from 'react-native-nitro-logger';

const SENTINEL = 'MIN_RN_CONSUMER';
const RUN_ID = '__RUN_ID__';

export default function App() {
  const [verdict, setVerdict] = useState('running');

  useEffect(() => {
    let result: string;
    try {
      const destination = createFileDestination({
        formatter: new JsonLinesFormatter(),
        rotation: {
          maxFileSizeBytes: 8 * 1024,
          maxArchivedFilesCount: 2,
          compressArchives: true,
        },
      });
      Log.addDestination(destination);

      for (let i = 0; i < 500; i += 1) {
        Log.info('min-rn record', { index: i, run: pub(SENTINEL) });
      }
      const flushed = destination.flush(10000);
      const paths = destination.getLogFilePaths();
      const purged = destination.purge(5000);

      const ok =
        flushed.durable && paths.length > 0 && purged.durable && purged.rebound;
      result = ok
        ? `${SENTINEL} ${RUN_ID} PASS files=${paths.length} deleted=${purged.deletedCount}`
        : `${SENTINEL} ${RUN_ID} FAIL durable=${flushed.durable} files=${paths.length} purge=${purged.durable}/${purged.rebound}`;

      Log.info('min-rn verdict', { verdict: pub(result) });
      destination.flush(5000);
    } catch (e) {
      result = `${SENTINEL} ${RUN_ID} FAIL ${String(e)}`;
    }
    setVerdict(result);
    console.log(result);
  }, []);

  return (
    <View style={{ paddingTop: 80, paddingHorizontal: 16 }}>
      <Text>{verdict}</Text>
    </View>
  );
}
APP
sed -i '' "s/__RUN_ID__/$RUN_ID/" "$APP_DIR/App.tsx"
grep -q "$RUN_ID" "$APP_DIR/App.tsx" || {
  echo "FAIL: the run ID was not stamped into the app"
  exit 1
}

echo "==> pod install"
# The template's Gemfile is at the app root, not in ios/. Prefer its pinned
# CocoaPods, but fall back to whatever is on PATH: the bundled Ruby on macOS is
# old enough that `bundle install` fails on some machines, and that is not a
# reason to skip the compatibility check.
export BUNDLE_GEMFILE="$APP_DIR/Gemfile"
if (cd "$APP_DIR" && bundle install); then
  POD=(bundle exec pod)
else
  echo "note: bundler unavailable, using the pod on PATH"
  POD=(pod)
fi
cd "$APP_DIR/ios"
"${POD[@]}" install

# The simulator is chosen before the build, not after, because the build needs
# it: `-sdk iphonesimulator` alone leaves the architecture open, and on Apple
# silicon that means also compiling an x86_64 slice that nothing here will ever
# run. React Native 0.78's pods do not all build for it, so the job would fail
# on an architecture it does not need.
echo "==> Choosing a simulator"
UDID="${1:-}"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available --json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const k of Object.keys(j.devices).sort().reverse()){const d=j.devices[k].find(x=>x.isAvailable&&/iPhone/.test(x.name));if(d){console.log(d.udid);break}}})')"
fi
[ -n "$UDID" ] || { echo "FAIL: no available iPhone simulator"; exit 1; }
echo "using $UDID"

echo "==> Building for the simulator"
# Release, so the JS is bundled into the app and no Metro server is needed —
# which is also what makes the run reproducible from a shell.
DERIVED="$WORKDIR/derived"
BUILD_LOG="$WORKDIR/xcodebuild.log"
set +e
xcodebuild \
  -workspace "$APP_NAME.xcworkspace" \
  -scheme "$APP_NAME" \
  -configuration Release \
  -destination "id=$UDID" \
  -derivedDataPath "$DERIVED" \
  build > "$BUILD_LOG" 2>&1
build_status=$?
set -e
if [ "$build_status" -ne 0 ]; then
  # The diagnostics, not the last few lines of a build transcript. A
  # compatibility job whose failure output is "(2 failures)" tells whoever
  # reads it nothing about which version broke what.
  echo "FAIL: the build failed on RN $RN_VERSION"
  grep -E "error:|The following build commands failed" -A 2 "$BUILD_LOG" | head -60
  echo "(full log: $BUILD_LOG)"
  exit 1
fi
tail -3 "$BUILD_LOG"

echo "==> Launching"
APP_BUNDLE="$DERIVED/Build/Products/Release-iphonesimulator/$APP_NAME.app"

# Read the identifier rather than assuming it. The community template derives
# it from the app name (`org.reactjs.native.example.MinRnConsumer`), which is
# not something this script should be encoding a guess about — a wrong guess
# installs fine and then fails to launch, which reads like a runtime failure in
# the library.
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "$APP_BUNDLE/Info.plist")"
[ -n "$BUNDLE_ID" ] || { echo "FAIL: could not read the bundle identifier"; exit 1; }
echo "bundle id: $BUNDLE_ID"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
# Uninstall first: installing over the same identifier keeps the previous
# run's data container, log file included.
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP_BUNDLE"
xcrun simctl launch "$UDID" "$BUNDLE_ID"

echo "==> Waiting for the verdict"
CONTAINER=""
for _ in $(seq 1 60); do
  CONTAINER="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data 2>/dev/null || true)"
  if [ -n "$CONTAINER" ] && grep -qsF "$RUN_ID" "$CONTAINER/Library/Logs/app.log"; then
    break
  fi
  sleep 2
done

LOGFILE="$CONTAINER/Library/Logs/app.log"
if [ ! -f "$LOGFILE" ]; then
  echo "FAIL: the app never wrote a log file — it did not run, or the sink never opened"
  exit 1
fi

echo "--- verdict line ---"
grep -oF "MIN_RN_CONSUMER $RUN_ID" "$LOGFILE" >/dev/null \
  && grep -o "MIN_RN_CONSUMER $RUN_ID [^\"]*" "$LOGFILE" | tail -1

# The run ID has to be in the same line as the verdict. A log file left behind
# by an earlier run cannot satisfy this, and neither can a build that installed
# but never reached the exercise.
if grep -qF "MIN_RN_CONSUMER $RUN_ID PASS" "$LOGFILE"; then
  echo "ok: react-native-nitro-logger builds, launches and works on RN $RN_VERSION"
  exit 0
fi

echo "FAIL: the consumer app did not pass on RN $RN_VERSION (run $RUN_ID)"
exit 1
