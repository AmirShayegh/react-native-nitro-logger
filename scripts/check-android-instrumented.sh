#!/usr/bin/env bash
#
# The instrumented Android suite, run fail-closed.
#
# `AndroidPlatformIo` is every `android.system.Os` call the writer makes, and
# through 0.1.2 it appeared in no test file at all. The Kotlin job exercises
# `PlatformIo.Jvm` — a different implementation of the same interface, written
# for the desktop JVM — so the shipped syscall path was uncovered while a green
# tick said "the Android writer is tested".
#
# The reason this is a script and not three lines of YAML is that the obvious
# YAML passes for the wrong reason. `gradlew connectedDebugAndroidTest` exits 0
# when it runs zero tests: an emulator that came up without the package
# installed, a filter that matched nothing, a source set that stopped being
# compiled. So the count is what is asserted, against a pinned floor, from
# reports this run is required to have created.
#
#   * The results directory is DELETED first. Without that, a report left by a
#     previous run — or restored from a cache — satisfies every count below
#     while this run discovered nothing.
#   * A missing report is a failure, not an absence of news.
#   * The floor is a specific number, not "> 0". A suite that silently lost ten
#     of its thirteen tests is the failure worth catching, and it is exactly the
#     one a nonzero check waves through.
#   * The floor is counted **per class**, not across the run. A named class plus
#     an aggregate count is not the same assertion: add a second androidTest
#     suite later and its cases would hold the total at the floor while this
#     one lost most of its own.
#
# Raising the floor when tests are added is the intended cost. It is the only
# part of this that a person has to keep honest.
set -uo pipefail

cd "$(dirname "$0")/.."

MODULE=":react-native-nitro-logger"
RESULTS="android/build/outputs/androidTest-results/connected"
REQUIRED_CLASS="com.margelo.nitro.nitrologger.AndroidPlatformIoTest"
MINIMUM_TESTS=13

if ! command -v adb >/dev/null 2>&1; then
  echo "FAIL: adb is not on PATH; this needs a device or emulator"
  exit 1
fi

DEVICES="$(adb devices | awk 'NR>1 && $2 == "device" { print $1 }')"
if [ -z "$DEVICES" ]; then
  echo "FAIL: no device is attached. This suite exists because the JVM one"
  echo "      cannot make these syscalls, so skipping it proves nothing."
  exit 1
fi

echo "devices: $(echo "$DEVICES" | tr '\n' ' ')"

# Fresh reports only. A stale XML here would satisfy every assertion below.
rm -rf "$RESULTS"

(cd example/android && ./gradlew "${MODULE}:connectedDebugAndroidTest" --console=plain)
GRADLE_STATUS=$?

if [ ! -d "$RESULTS" ]; then
  echo "FAIL: the run produced no results directory at $RESULTS"
  exit 1
fi

# The directory is walked rather than globbed into a variable: the report name
# is the device's, and a device name contains spaces and parentheses
# ("TEST-Medium_Phone_API_36.0(AVD) - 16.xml"), which word splitting turns into
# three paths that do not exist.
#
# Every report under here was created by this run — the directory was deleted
# above, so freshness is by construction rather than by timestamp comparison.
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
# Per required class, and by test NAME rather than by count of elements: the
# floor has to be a statement about this class, or a second suite added later
# would hold the aggregate at the floor while this one quietly lost most of
# its cases. Names also collapse a retried case, which would otherwise count
# twice.
required_cases = set()

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

print(f"  reports    -> {len(reports)}")
print(f"  tests      -> {total} ({failures} failed, {errors} errored, {skipped} skipped)")
print(f"  classes    -> {', '.join(sorted(classes)) or '(none)'}")
print(f"  {required_class.rsplit('.', 1)[-1]} -> {len(required_cases)} case(s)")

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

print("ok:   the instrumented suite ran on a device and every test passed")
PY
CHECK_STATUS=$?

if [ $GRADLE_STATUS -ne 0 ]; then
  echo "FAIL: gradle exited $GRADLE_STATUS"
  exit $GRADLE_STATUS
fi

exit $CHECK_STATUS
