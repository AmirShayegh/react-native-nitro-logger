#!/usr/bin/env bash
#
# Compiles, launches and exercises this library inside a pristine consumer app
# on the OLDEST React Native it claims to support — the Android half of
# `check-min-rn-ios.sh`, asking the same question of a different toolchain.
#
# The example app tracks the newest RN, so it proves nothing about the bottom of
# the range, and the bottom is where a compatibility claim actually gets tested.
# Nitro's generated JNI bindings, the AGP and Kotlin versions the library's
# `build.gradle` resolves against, `compileSdk`, and the React Native gradle
# plugin's contract all moved between 0.78 and today.
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
# ## Why this is a separate job from the C13 reload harness
#
# Different app, different question. That one drives the maintained example on
# the newest RN and reaches into the registry's own test hooks; this one asks
# whether a consumer who has never heard of those hooks can install the package
# and have it work. Neither substitutes for the other.
#
# ## Why the verdict travels through logcat
#
# The iOS script reads the log file out of the simulator's data container. The
# Android equivalent needs `run-as`, which only works on a debuggable build —
# and a debug build is not what this job claims to verify. Everything that
# differs between debug and release on Android is exactly the interesting part:
# R8, the bundled JS, the packaged .so set. So the app reports its own verdict
# through `console.log`, which Hermes routes to the `ReactNativeJS` tag, and
# this script reads that.
#
# The fidelity that costs, stated rather than hidden: the verdict is the app's
# own report rather than an artifact read off the device. A library that lied
# about its own outcome would be believed here, where iOS would catch it. The
# RUN_ID below is what keeps the *other* failure — a stale buffer, a previous
# run's line — from signing this one off.
#
# ## Stated non-proofs
#
#   * arm64 and physical devices. This runs one ABI on an emulator.
#   * Old OS versions. Minimum-OS is `check-android-instrumented.sh`'s claim
#     (API 24); minimum-RN is this one's, and it runs on API 34 so a failure
#     here is unambiguously about the React Native version.
#   * Old-architecture consumers. The template has `newArchEnabled=true` and
#     Nitro requires it, so there is nothing to check.
#
# Usage: ./scripts/check-min-rn-android.sh
# Env:   MIN_RN_VERSION (default 0.78.0), MIN_RN_ABI (default: the device's),
#        MIN_RN_WORKDIR, KEEP_WORKDIR=1

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RN_VERSION="${MIN_RN_VERSION:-0.78.0}"
WORKDIR="${MIN_RN_WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/nitro-logger-minrn-android.XXXXXX")}"
APP_NAME="MinRnConsumer"
APP_DIR="$WORKDIR/$APP_NAME"

# Stamped into the app and required in the verdict line.
#
# logcat is a ring buffer shared by everything on the device and it survives
# app reinstalls, so a line from an earlier run outlives the app that wrote it.
# Without something unique per run, a build that never launched would be signed
# off by the previous run's PASS — the exact failure this job exists to catch,
# hiding in the job itself.
RUN_ID="run-$(date +%Y%m%d%H%M%S)-$$"
SENTINEL="MIN_RN_CONSUMER"

cleanup() {
  if [ "${KEEP_WORKDIR:-0}" != "1" ]; then rm -rf "$WORKDIR"; fi
}
trap cleanup EXIT

command -v adb >/dev/null 2>&1 || {
  echo "FAIL: adb is not on PATH; this needs a device or emulator"
  exit 1
}

DEVICES="$(adb devices | awk 'NR>1 && $2 == "device" { print $1 }')"
if [ -z "$DEVICES" ]; then
  echo "FAIL: no device is attached. A compatibility claim that was only"
  echo "      compiled is not the claim this job makes."
  exit 1
fi
echo "devices: $(echo "$DEVICES" | tr '\n' ' ')"

# Build for the ABI the attached device actually runs, not a hardcoded one.
# CI's emulator is x86_64 and a maintainer's Apple-silicon emulator is
# arm64-v8a; guessing either way produces an APK that installs cleanly and then
# dies looking for a .so, which reads like a runtime failure in the library.
ABI="${MIN_RN_ABI:-$(adb shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')}"
[ -n "$ABI" ] || { echo "FAIL: could not read the device ABI"; exit 1; }
echo "abi: $ABI"

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
# the whole pipeline, write, flush, list, purge, and say what happened. A
# compile-only check would miss every runtime binding problem, which is most of
# what breaks across RN versions.
#
# Deliberately the same exercise as the iOS script's, so a divergence between
# the two jobs is about the platform and not about what was asked of it.
cat > "$APP_DIR/App.tsx" <<'APP'
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import {
  Log,
  FileDestination,
  JsonLinesFormatter,
  createFileSink,
  pub,
} from 'react-native-nitro-logger';

const SENTINEL = 'MIN_RN_CONSUMER';
const RUN_ID = '__RUN_ID__';

export default function App() {
  const [verdict, setVerdict] = useState('running');

  useEffect(() => {
    let result: string;
    try {
      const destination = new FileDestination(createFileSink(), {
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
    } catch (e) {
      result = `${SENTINEL} ${RUN_ID} FAIL ${String(e)}`;
    }
    setVerdict(result);
    // The transport. Hermes routes this to the `ReactNativeJS` logcat tag in a
    // release build, which is the only channel out of a non-debuggable app.
    console.log(result);
  }, []);

  return (
    <View style={{ paddingTop: 80, paddingHorizontal: 16 }}>
      <Text>{verdict}</Text>
    </View>
  );
}
APP

# python3 rather than `sed -i`, whose in-place flag takes an argument on BSD and
# does not on GNU. This script runs on a Linux CI runner and on a maintainer's
# Mac, and a portability wrapper around one substitution is not worth writing.
python3 - "$APP_DIR/App.tsx" "$RUN_ID" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
assert "__RUN_ID__" in text, "the placeholder is gone; the app template changed"
path.write_text(text.replace("__RUN_ID__", sys.argv[2]))
PY
grep -q "$RUN_ID" "$APP_DIR/App.tsx" || {
  echo "FAIL: the run ID was not stamped into the app"
  exit 1
}

echo "==> Building the release APK"
# Release, so the JS is bundled into the APK and no Metro server is needed —
# which is also what makes the run reproducible from a shell, and what makes
# the R8 and packaging questions above answerable at all.
#
# One ABI — the device's, read above — because the emulator runs one and
# building the other three is minutes of NDK work for artifacts nothing
# installs.
BUILD_LOG="$WORKDIR/gradle.log"
set +e
(cd "$APP_DIR/android" && ./gradlew assembleRelease \
  -PreactNativeArchitectures="$ABI" --console=plain) > "$BUILD_LOG" 2>&1
build_status=$?
set -e
if [ "$build_status" -ne 0 ]; then
  # The diagnostics, not the last few lines of a build transcript. A
  # compatibility job whose failure output is "> Task :app:foo FAILED" tells
  # whoever reads it nothing about which version broke what.
  echo "FAIL: the build failed on RN $RN_VERSION"
  grep -E "^e: |error:|FAILURE:|What went wrong|Caused by" -A 4 "$BUILD_LOG" | head -80
  echo "(full log: $BUILD_LOG)"
  exit 1
fi
tail -3 "$BUILD_LOG"

APK="$APP_DIR/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || { echo "FAIL: the build produced no APK at $APK"; exit 1; }

# Read the applicationId out of the generated gradle file rather than deriving
# it from the app name. The template lowercases and prefixes in ways this
# script should not be encoding a guess about: a wrong guess installs fine and
# then fails to launch, which reads like a runtime failure in the library.
#
# The reader is written to a file rather than fed to a heredoc inside `$( )`.
# bash 3.2, which is what macOS still ships, mis-parses that combination — and
# this script has to run on a maintainer's Mac as well as on the Linux runner.
cat > "$WORKDIR/read-application-id.py" <<'PY'
import pathlib
import re
import sys

text = pathlib.Path(sys.argv[1]).read_text()
# Both quote styles: the template has used each of them across versions.
match = re.search(r"""applicationId\s+["']([^"']+)["']""", text)
print(match.group(1) if match else "")
PY
APPLICATION_ID="$(python3 "$WORKDIR/read-application-id.py" \
  "$APP_DIR/android/app/build.gradle")"
[ -n "$APPLICATION_ID" ] || {
  echo "FAIL: could not read applicationId from the generated build.gradle"
  exit 1
}
echo "applicationId: $APPLICATION_ID"

echo "==> Installing and launching"
# A bigger ring buffer before anything is written to it. The default is small
# enough that 500 records' worth of unrelated system chatter can push a verdict
# out before this script gets to read it.
adb logcat -G 16M >/dev/null 2>&1 || echo "note: could not resize the logcat buffer"
# Best effort: on some images `logcat -c` fails against the default buffer set.
# The RUN_ID is what actually makes a stale line harmless; this only keeps the
# reading cheap.
adb logcat -c >/dev/null 2>&1 || echo "note: could not clear logcat"

# Uninstall first. Installing over the same applicationId keeps the previous
# run's files, and this app purges its own log at the end of the exercise —
# but a half-finished earlier run may not have got that far.
adb uninstall "$APPLICATION_ID" >/dev/null 2>&1 || true
adb install -r "$APK"
adb shell monkey -p "$APPLICATION_ID" -c android.intent.category.LAUNCHER 1 >/dev/null

echo "==> Waiting for the verdict"
VERDICT=""
for _ in $(seq 1 60); do
  VERDICT="$(adb logcat -d -s ReactNativeJS:V 2>/dev/null \
    | grep -F "$SENTINEL $RUN_ID" | tail -1 || true)"
  [ -n "$VERDICT" ] && break
  sleep 2
done

if [ -z "$VERDICT" ]; then
  echo "FAIL: the app never reported a verdict for $RUN_ID — it did not launch,"
  echo "      or it crashed before the exercise finished."
  echo "--- last crash-adjacent logcat ---"
  adb logcat -d -s AndroidRuntime:E ReactNativeJS:V ReactNative:E | tail -40
  exit 1
fi

echo "--- verdict line ---"
echo "$VERDICT"

# The run ID has to be in the same line as the verdict. A logcat buffer left
# behind by an earlier run cannot satisfy this, and neither can an install that
# never reached the exercise.
if printf '%s' "$VERDICT" | grep -qF "$SENTINEL $RUN_ID PASS"; then
  echo "ok: react-native-nitro-logger builds, launches and works on RN $RN_VERSION"
  exit 0
fi

echo "FAIL: the consumer app did not pass on RN $RN_VERSION (run $RUN_ID)"
exit 1
