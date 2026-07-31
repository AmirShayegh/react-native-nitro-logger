#!/usr/bin/env bash
#
# Runs the bench case list on Hermes — the engine that ships — and harvests
# one JSON result per case from logcat into a results file.
#
# `bench/run.js` measures V8, and V8 numbers do not transfer: Hermes has its
# own regex engine, weaker escape analysis, and its own `toISOString`. Any
# finding gated on Hermes behaviour (B1, B6 in the 0.4.0 audit) is decided by
# THIS script's output, never by the Node run. The same case files and the
# same measurement core execute here — `example/src/BenchHarness.tsx` imports
# them through Metro — so a difference between the two runs is the engine,
# not the harness.
#
# On-demand tooling, not CI. A release build plus an emulator run costs
# minutes and the numbers are only comparable within one device and session;
# CI's executes-only guarantee for the case list is the `--quick` Node run in
# `build-library`, and this script's bundling is covered by the same Metro
# config the min-rn jobs exercise.
#
# ## The transport, and why it is trustworthy
#
# The harness activity is started with a per-run ID (`--es benchRunId ...`),
# the activity forwards its extras as launch props, and every line the
# harness prints carries that ID — so a stale logcat buffer from an earlier
# run cannot contribute a single case to this one. The min-rn lesson, reused.
#
# ## What this does not prove
#
# That the numbers mean anything beyond "this commit, this device, this
# session". Compare before/after from the same invocation environment;
# nothing here is a gate.
#
# Usage:
#   scripts/bench-hermes-android.sh [results.json]
# Needs: a booted emulator or connected device, ANDROID_HOME set.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${1:-bench-hermes-results.json}"
RUN_ID="bench-$(date +%Y%m%d%H%M%S)-$$"
APPLICATION_ID="nitrologger.example"
CASE_COUNT="$(node -e '
  const files = ["hotpath", "format", "batcher"];
  let n = 0;
  for (const f of files) n += require("./bench/cases/" + f + ".js").cases.length;
  process.stdout.write(String(n));
')"

command -v adb >/dev/null 2>&1 || {
  echo "FAIL: adb is not on PATH; this needs a device or emulator"
  exit 1
}

DEVICES="$(adb devices | awk 'NR>1 && $2 == "device" { print $1 }')"
DEVICE_COUNT="$(printf '%s\n' "$DEVICES" | sed '/^$/d' | wc -l | tr -d ' ')"
[ "$DEVICE_COUNT" -gt 0 ] || {
  echo "FAIL: no device is connected and ready"
  exit 1
}
# With several devices, every bare adb call below would die with "more than
# one device/emulator" AFTER the minutes-long Gradle build. adb honours
# ANDROID_SERIAL on every invocation, so requiring it up front is the whole
# fix — no per-call -s threading.
if [ "$DEVICE_COUNT" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
  echo "FAIL: $DEVICE_COUNT devices are connected; export ANDROID_SERIAL to pick one:"
  printf '%s\n' "$DEVICES"
  exit 1
fi

# The device's own ABI, never a hardcoded one: an APK built for the wrong ABI
# installs fine and then loads no native library.
ABI="$(adb shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r')"
echo "device ABI: $ABI; run: $RUN_ID; expecting $CASE_COUNT cases"

(cd example/android && ./gradlew :app:assembleRelease \
  "-PreactNativeArchitectures=$ABI" --console=plain)

APK="example/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || {
  echo "FAIL: expected APK at $APK"
  exit 1
}

adb logcat -G 16M >/dev/null 2>&1 || echo "note: could not resize the logcat buffer"
adb logcat -c >/dev/null 2>&1 || echo "note: could not clear logcat"

adb uninstall "$APPLICATION_ID" >/dev/null 2>&1 || true
adb install -r "$APK"
adb shell am start -n "$APPLICATION_ID/.BenchHarnessActivity" \
  --es benchRunId "$RUN_ID" >/dev/null

# ~30 cases at up to a few hundred ms of calibration plus nine 20 ms batches
# each; three minutes is generous, and the DONE marker ends the wait early.
DEADLINE=$((SECONDS + 180))
DONE_LINE=""
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  DONE_LINE="$(adb logcat -d -s ReactNativeJS:V 2>/dev/null \
    | grep -F "NITRO_BENCH $RUN_ID DONE" | tail -1 || true)"
  [ -n "$DONE_LINE" ] && break
  sleep 2
done

[ -n "$DONE_LINE" ] || {
  echo "FAIL: no completion marker for $RUN_ID within the deadline"
  adb logcat -d -s ReactNativeJS:V | tail -20 || true
  exit 1
}

# Harvest: strip the logcat prefix and the marker, keep the JSON payloads.
adb logcat -d -s ReactNativeJS:V \
  | grep -F "NITRO_BENCH $RUN_ID {" \
  | sed "s/^.*NITRO_BENCH $RUN_ID //" \
  > "$OUT.lines"

LINES="$(wc -l < "$OUT.lines" | tr -d ' ')"
[ "$LINES" -eq "$CASE_COUNT" ] || {
  echo "FAIL: harvested $LINES case results, expected $CASE_COUNT"
  exit 1
}

node -e '
  const fs = require("fs");
  const [linesPath, outPath, runId] = process.argv.slice(1);
  const results = fs
    .readFileSync(linesPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // Count parity is not identity: a duplicated line and a dropped case
  // balance to the same total. The harvested names must equal the case
  // list exactly — no duplicates, nothing missing, nothing unknown.
  const expected = [];
  for (const f of ["hotpath", "format", "batcher"])
    for (const c of require("./bench/cases/" + f + ".js").cases)
      expected.push(c.name);
  const seen = results.map((r) => r.name);
  const problems = [];
  const duplicated = seen.filter((n, i) => seen.indexOf(n) !== i);
  if (duplicated.length) problems.push("duplicated: " + duplicated.join(", "));
  const missing = expected.filter((n) => !seen.includes(n));
  if (missing.length) problems.push("missing: " + missing.join(", "));
  const unknown = seen.filter((n) => !expected.includes(n));
  if (unknown.length) problems.push("unknown: " + unknown.join(", "));
  if (problems.length) {
    for (const p of problems) console.error("FAIL: harvested names " + p);
    process.exit(1);
  }
  fs.writeFileSync(
    outPath,
    JSON.stringify({ engine: "hermes-android", runId, results }, null, 2) + "\n"
  );
' "$OUT.lines" "$OUT" "$RUN_ID"
rm -f "$OUT.lines"

echo "ok:   $CASE_COUNT Hermes case results in $OUT (run $RUN_ID)"
