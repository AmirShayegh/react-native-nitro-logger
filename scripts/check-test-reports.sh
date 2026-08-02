#!/usr/bin/env bash
#
# Runs a test target and refuses to call it a pass unless it discovered the
# tests it was supposed to.
#
# `swift test`, `gradlew test` and `jest` all report success for a run that
# found nothing. That is not hypothetical here: the instrumented Android suite
# was demonstrated exiting 0 with BUILD SUCCESSFUL and zero tests when its
# source file was moved away. The same shape is available to every target in
# this repository — a renamed source set, a filter that stops matching, a
# discovery rule that changes under a toolchain upgrade — and in each case CI
# stays green while coverage silently goes to nothing.
#
# So each mode below:
#
#   * DELETES the report directory first. Without that, a report left by an
#     earlier run — or restored from a cache, which is how this bites in CI —
#     satisfies every count below while this run discovered nothing. It also
#     forces Gradle to consider the task out of date, which is the point: an
#     UP-TO-DATE task that skipped execution should not be able to hand back
#     yesterday's numbers.
#   * Requires the run to have CREATED reports. Missing is a failure, not an
#     absence of news.
#   * Asserts a pinned floor for the target, and that every suite that is meant
#     to exist reported something.
#
# What this does not catch: a suite that loses three tests while another gains
# three keeps the total at the floor. Per-suite floors would close that and
# would mean re-pinning a number on every commit that adds a test; the names
# below are the compromise, and they catch the failure that actually happens —
# a whole suite dropping out of discovery.
#
# Raising a floor when tests are added is the intended cost, and the only part
# of this a person has to keep honest.
set -uo pipefail

cd "$(dirname "$0")/.."

MODE="${1:-}"

case "$MODE" in
  swift)
    REPORTS="$(pwd)/.build/test-reports"
    MINIMUM=260
    REQUIRED_SUITES="FileSinkAnswersTests FileSinkLifecycleRowsTests FileSinkLifecycleTests LogBurstTests LogCollectTests LogFileWriterTests LogPerfTests LogRegistryTests LogRotationTests LogSecureFileTests MonotonicConditionTests NativeConsoleWriterTests PackageManifestTests"
    rm -rf "$REPORTS"
    mkdir -p "$REPORTS"
    # `--xunit-output` is the only machine-readable result SwiftPM emits, and
    # it needs `--parallel`. The suites here share no global state; the
    # registry ones already run against per-test temporary directories.
    swift test --parallel --xunit-output "$REPORTS/swift.xml"
    RUN_STATUS=$?
    ;;
  kotlin)
    REPORTS="$(pwd)/android/build/test-results/testDebugUnitTest"
    MINIMUM=246
    REQUIRED_SUITES="AllocationHarnessTest BridgeNumberTest FileSinkAnswersTest FileSinkLifecycleRowsTest FileSinkLifecycleTest FileSinkMessagesTest LogBurstTest LogCollectTest LogFileWriterTest LogWriterRegistryTest NativeConsoleWriterTest ReactInstanceEpochTest"
    rm -rf "$REPORTS"
    (cd example/android && ./gradlew :react-native-nitro-logger:testDebugUnitTest --console=plain)
    RUN_STATUS=$?
    ;;
  js)
    REPORTS="$(pwd)/.jest-reports"
    MINIMUM=1308
    REQUIRED_SUITES="adapterThinness analytics apiReference batcher consoleDestination construction correlation deadline defaultFormatter degradation eslintPlugin fileDestination fileSinkLifecycleRows integrations jsonLinesFormatter levels logger maintenance nativeConsoleDestination openFailureParity privacy redaction rejectionHandler revealSentinels sanitizeError platformConsoleFormatter scope subsystem timestamp utf8"
    rm -rf "$REPORTS"
    mkdir -p "$REPORTS"
    npx jest --ci --json --outputFile="$REPORTS/jest.json"
    RUN_STATUS=$?
    ;;
  *)
    echo "usage: $0 <swift|kotlin|js>"
    exit 2
    ;;
esac

if [ ! -d "$REPORTS" ]; then
  echo "FAIL: the run produced no report directory at $REPORTS"
  exit 1
fi

# The shared no-handle table, pinned outside the three suites that read it.
#
# Each suite carries its own floor, which is what makes a new row fail that
# target. This pin is for the failure those floors cannot see: all three lowered
# together, or rows deleted from the table and the floors dropped to match in the
# same commit, which looks locally consistent from inside any one of them.
#
# What it does NOT prove: that the rows say anything. A row whose answers were
# emptied still counts. That is the suites' job — this only stops the table
# shrinking quietly.
python3 - <<'PY' || exit 1
import json, pathlib, sys

PINNED_ROWS = 9
PINNED_MODES = ["neverOpened", "openedThenClosed"]

table = json.loads(pathlib.Path("spec/file-sink-lifecycle.rows.json").read_text())
rows, modes = table["rows"], table["modes"]

problems = []
if len(rows) < PINNED_ROWS:
    problems.append(f'the table has {len(rows)} rows, below the pinned {PINNED_ROWS}')
if modes != PINNED_MODES:
    problems.append(f'the table declares modes {modes}, not {PINNED_MODES}')

# A duplicated op raises the row count while testing nothing new, which is the
# one way to satisfy every floor above and the three suites' dispatcher checks
# at the same time.
ops = [row.get("op") for row in rows]
duplicated = sorted({op for op in ops if ops.count(op) > 1})
if duplicated:
    problems.append('these ops are listed more than once: ' + ', '.join(map(str, duplicated)))

for row in rows:
    missing = [m for m in modes if not isinstance(row.get(m), dict) or not row[m]]
    if missing:
        problems.append(f'row `{row.get("op")}` has no answer for: {", ".join(missing)}')

for problem in problems:
    print(f'FAIL: {problem}')
sys.exit(1 if problems else 0)

PY
echo "ok:   the shared no-handle table still carries its pinned rows and modes"

REPORTS="$REPORTS" MODE="$MODE" MINIMUM="$MINIMUM" REQUIRED_SUITES="$REQUIRED_SUITES" \
python3 <<'PY'
import json
import os
import pathlib
import sys
import xml.etree.ElementTree as ET

reports = pathlib.Path(os.environ['REPORTS'])
mode = os.environ['MODE']
minimum = int(os.environ['MINIMUM'])
required = set(os.environ['REQUIRED_SUITES'].split())

total = failures = errors = skipped = 0
suites = set()

if mode == 'js':
    # Jest's own summary, which is the same object its reporters print from.
    path = reports / 'jest.json'
    if not path.exists():
        print(f'FAIL: jest wrote no report at {path}')
        sys.exit(1)
    summary = json.loads(path.read_text())
    total = summary['numTotalTests']
    failures = summary['numFailedTests']
    skipped = summary['numPendingTests'] + summary['numTodoTests']
    for suite in summary['testResults']:
        suites.add(pathlib.Path(suite['name']).name.split('.')[0])
else:
    # Every report here was created by this run: the directory was deleted
    # first, so freshness is by construction rather than by timestamp.
    files = sorted(reports.rglob('*.xml'))
    if not files:
        print(f'FAIL: the run produced no test reports under {reports}')
        sys.exit(1)
    for path in files:
        root = ET.parse(path).getroot()
        for case in root.iter('testcase'):
            total += 1
            suites.add((case.get('classname') or '').rsplit('.', 1)[-1])
            for child in case:
                tag = child.tag.lower()
                if tag == 'failure':
                    failures += 1
                elif tag == 'error':
                    errors += 1
                elif tag == 'skipped':
                    skipped += 1

print(f'  target     -> {mode}')
print(f'  tests      -> {total} ({failures} failed, {errors} errored, {skipped} skipped)')
print(f'  suites     -> {len(suites)}')

problems = []
if total < minimum:
    problems.append(f'{total} tests ran, below the pinned floor of {minimum}')

absent = sorted(name for name in required if name not in suites)
if absent:
    problems.append('these suites reported nothing: ' + ', '.join(absent))

if skipped:
    problems.append(f'{skipped} test(s) were skipped; a skip is a hole, not a pass')
if failures or errors:
    problems.append(f'{failures} failure(s) and {errors} error(s)')

if problems:
    for problem in problems:
        print(f'FAIL: {problem}')
    sys.exit(1)

print(f'ok:   {mode} discovered and passed {total} tests across {len(suites)} suites')
PY
CHECK_STATUS=$?

if [ $RUN_STATUS -ne 0 ]; then
  echo "FAIL: the test command exited $RUN_STATUS"
  exit $RUN_STATUS
fi

exit $CHECK_STATUS
