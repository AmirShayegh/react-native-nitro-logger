#!/usr/bin/env bash
#
# The C13 reload harness, run fail-closed.
#
# C13 is the Metro-reload writer leak: a `ReactInstance` dies, its JavaScript
# goes with it, and on Android nothing in the teardown path reaches the writer
# it left open — `finalize()` cannot run, so the descriptor and the registry
# slot are held by a runtime that no longer exists. `SPIKE-C13.md` deferred the
# whole item on one gate, "observable termination signal proven", and this is
# the observation.
#
# It is a separate job from `check-android-instrumented.sh`, on purpose:
#
#   * different module — the harness needs a `ReactHost` and a bundle, and the
#     library's own test APK has neither;
#   * different build type — **release**. A debug build serves JavaScript from
#     Metro, which is not running on a CI emulator, and reloads through the
#     dev-support path rather than the one a shipped app takes;
#   * different question — that suite asks whether the writer's syscalls work
#     on a device, this one asks what the registry does when a runtime dies.
#
# Folding it into the instrumented matrix would run it on API 24 as well, for
# no signal: the reload path is React Native's, not the OS's.
#
# Everything below exists because the obvious YAML passes for the wrong reason.
# `gradlew connectedReleaseAndroidTest` exits 0 when it runs zero tests — an
# emulator that came up without the package installed, a source set that stopped
# compiling, a filter that matched nothing. So:
#
#   * the results directory is DELETED first, and a report that survives that is
#     one this run created;
#   * a missing report is a failure, not an absence of news;
#   * the floor is per class and by test name, so a second suite added later
#     cannot hold the aggregate up while this one loses its own case;
#   * a skipped test is a hole. This suite has exactly one test, and a skip
#     would mean the reload was never driven at all.
#
# What a green run here does NOT establish: the old architecture's teardown
# (this is bridgeless RN 0.85, and the `invalidate()` contract being the same on
# both is an argument, not a test); a process with more than one `ReactHost`;
# `finalize()` running, which it still cannot; durability of records that were
# in the queue at the reload instant beyond the drain the harness waits for.
set -uo pipefail

cd "$(dirname "$0")/.."

MODULE=":app"
RESULTS="example/android/app/build/outputs/androidTest-results/connected"
REQUIRED_CLASS="nitrologger.example.C13ReloadLeakTest"
MINIMUM_TESTS=1

if ! command -v adb >/dev/null 2>&1; then
  echo "FAIL: adb is not on PATH; this needs a device or emulator"
  exit 1
fi

DEVICES="$(adb devices | awk 'NR>1 && $2 == "device" { print $1 }')"
if [ -z "$DEVICES" ]; then
  echo "FAIL: no device is attached. The leak only exists once JavaScript has"
  echo "      built the hybrid, so there is nothing to prove without one."
  exit 1
fi

echo "devices: $(echo "$DEVICES" | tr '\n' ' ')"

# Fresh reports only. A stale XML here would satisfy every assertion below.
rm -rf "$RESULTS"

(cd example/android && ./gradlew "${MODULE}:connectedReleaseAndroidTest" --console=plain)
GRADLE_STATUS=$?

if [ ! -d "$RESULTS" ]; then
  echo "FAIL: the run produced no results directory at $RESULTS"
  exit 1
fi

# Walked rather than globbed: report names carry the device's name, which
# contains spaces and parentheses.
python3 - "$REQUIRED_CLASS" "$MINIMUM_TESTS" "$RESULTS" <<'PY'
import pathlib
import sys
import xml.etree.ElementTree as ET

required_class, minimum = sys.argv[1], int(sys.argv[2])
reports = sorted(pathlib.Path(sys.argv[3]).rglob("TEST-*.xml"))

if not reports:
    print(f"FAIL: the run produced no test reports under {sys.argv[3]}")
    sys.exit(1)

total = failures = errors = skipped = 0
classes = set()
required_cases = set()
messages = []

for path in reports:
    suite = ET.parse(path).getroot()
    total += int(suite.get("tests", 0))
    failures += int(suite.get("failures", 0))
    errors += int(suite.get("errors", 0))
    skipped += int(suite.get("skipped", 0))
    for case in suite.iter("testcase"):
        classes.add(case.get("classname"))
        if case.get("classname") == required_class:
            required_cases.add(case.get("name"))
        for child in case:
            if child.tag.lower() in ("failure", "error"):
                # The `message` attribute is empty in AGP's connected-test
                # reports — the assertion text is the element body, and that
                # body is this suite's entire diagnosis: which nonces reached
                # the disk, and what the registry still held when it gave up.
                detail = (child.get("message") or child.text or "").strip()
                messages.append(f"{case.get('name')}:\n    " + detail.replace("\n", "\n    "))

print(f"  reports    -> {len(reports)}")
print(f"  tests      -> {total} ({failures} failed, {errors} errored, {skipped} skipped)")
print(f"  classes    -> {', '.join(sorted(classes)) or '(none)'}")
print(f"  {required_class.rsplit('.', 1)[-1]} -> {len(required_cases)} case(s)")

# Printed in full, because this suite's failure message *is* the diagnosis: the
# harness dumps the nonces it found, the live writer count and the closing count
# at the moment it gave up, and none of that survives a truncated CI log.
for message in messages:
    print(f"  ! {message}")

problems = []
if not required_cases:
    problems.append(f"{required_class} did not run")
elif len(required_cases) < minimum:
    problems.append(
        f"{required_class} ran {len(required_cases)} case(s), "
        f"below the pinned floor of {minimum}"
    )
if skipped:
    problems.append(f"{skipped} test(s) were skipped; a skip here is a hole, not a pass")
if failures or errors:
    problems.append(f"{failures} failure(s) and {errors} error(s)")

if problems:
    for problem in problems:
        print(f"FAIL: {problem}")
    sys.exit(1)

print("ok:   a destroyed runtime released the writer it opened")
PY
CHECK_STATUS=$?

if [ $GRADLE_STATUS -ne 0 ]; then
  echo "FAIL: gradle exited $GRADLE_STATUS"
  exit $GRADLE_STATUS
fi

exit $CHECK_STATUS
