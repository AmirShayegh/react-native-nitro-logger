#!/usr/bin/env bash
#
# `docs/PARITY.md` states how many tests each target runs. This is what stops
# that from being a number somebody typed once.
#
# The document's whole argument is "nothing here is aspirational", and a stale
# count is the one claim in it that decays on its own: every other row is
# backed by a test that fails when it stops being true, while a number in a
# table is true until somebody notices. Nobody notices.
#
# So the counts are checked against `check-test-reports.sh`'s floors, in both
# directions. That is not the same as checking them against a test run, and the
# difference is worth being precise about:
#
#   * What this proves: the document and the gate agree. Raising a floor
#     without updating the document, or updating the document without raising
#     the floor, fails here.
#   * What this does NOT prove: that either number matches what the suites
#     actually run today. `check-test-reports.sh` proves that, per target,
#     against a report it just produced — and it is the only thing that can,
#     because it needs the run. This script deliberately needs no run, so it
#     belongs in `lint` where it costs nothing.
#
# Together they close the loop: the reports gate ties the floor to reality, and
# this ties the document to the floor.
set -euo pipefail

cd "$(dirname "$0")/.."

DOC=docs/PARITY.md
GATE=scripts/check-test-reports.sh

python3 - "$DOC" "$GATE" <<'PY'
import pathlib
import re
import sys

doc = pathlib.Path(sys.argv[1])
gate = pathlib.Path(sys.argv[2])
text = doc.read_text()
script = gate.read_text()

problems = []


def fail(message):
    problems.append(message)


# --- the marker -------------------------------------------------------------
#
# One machine-readable line, so the table below it can be prose without this
# script having to parse a Markdown table. The table is checked against the
# marker afterwards, which is what keeps the human-readable half honest.
marker = re.search(r'<!-- test-counts: (.*?) -->', text)
if marker is None:
    fail(f'{doc} has no <!-- test-counts: ... --> marker')
    print('\n'.join(f'  FAIL {p}' for p in problems))
    sys.exit(1)

declared = {}
for field in marker.group(1).split():
    match = re.fullmatch(r'(js|swift|kotlin)=(\d+)/(\d+)', field)
    if match is None:
        fail(f'marker field {field!r} is not <target>=<tests>/<suites>')
        continue
    declared[match.group(1)] = (int(match.group(2)), int(match.group(3)))

for target in ('js', 'swift', 'kotlin'):
    if target not in declared:
        fail(f'the marker does not mention {target}')

# --- the floors -------------------------------------------------------------
#
# Read out of the gate's own `case` arms rather than from a shared file,
# because the gate is what CI runs: a shared constant that the gate had stopped
# reading would leave this checking a number nothing enforces.
floors = {}
suites = {}
for target in ('js', 'swift', 'kotlin'):
    arm = re.search(
        rf'^\s*{target}\)\n(.*?)^\s*;;',
        script,
        re.S | re.M,
    )
    if arm is None:
        fail(f'{gate} has no `{target})` arm — this script is reading it wrong')
        continue
    minimum = re.search(r'^\s*MINIMUM=(\d+)', arm.group(1), re.M)
    if minimum is None:
        fail(f'{gate}: the `{target})` arm declares no MINIMUM')
        continue
    floors[target] = int(minimum.group(1))

    required = re.search(r'REQUIRED_SUITES="([^"]*)"', arm.group(1))
    if required is None:
        fail(f'{gate}: the `{target})` arm declares no REQUIRED_SUITES')
        continue
    suites[target] = len(required.group(1).split())

# --- they must agree --------------------------------------------------------
for target in sorted(set(declared) & set(floors)):
    tests, declared_suites = declared[target]
    if tests != floors[target]:
        fail(
            f'{target}: {doc} says {tests} tests, {gate} floors at '
            f'{floors[target]}'
        )
    if target in suites and declared_suites != suites[target]:
        fail(
            f'{target}: {doc} says {declared_suites} suites, {gate} requires '
            f'{suites[target]}'
        )

# --- and the prose must agree with the marker -------------------------------
#
# The marker is for this script; the table is for the reader. Checking only the
# marker would let the two disagree, which is the same stale number one comment
# further down.
for target, label in (
    ('js', r'JavaScript / TypeScript'),
    ('swift', r'iOS'),
    ('kotlin', r'Android'),
):
    if target not in declared:
        continue
    tests, declared_suites = declared[target]
    row = re.search(rf'^\|\s*{label}[^|]*\|([^|]*)\|([^|]*)\|', text, re.M)
    if row is None:
        fail(f'{doc} has no table row for {label}')
        continue
    if row.group(1).strip() != str(tests):
        fail(
            f'{target}: the table says {row.group(1).strip()} tests, the '
            f'marker says {tests}'
        )
    if row.group(2).strip() != str(declared_suites):
        fail(
            f'{target}: the table says {row.group(2).strip()} suites, the '
            f'marker says {declared_suites}'
        )

if problems:
    for problem in problems:
        print(f'  FAIL {problem}')
    print()
    print(f'{len(problems)} parity-count check(s) failed')
    sys.exit(1)

for target in ('js', 'swift', 'kotlin'):
    tests, declared_suites = declared[target]
    print(f'  ok   {target}: {tests} tests / {declared_suites} suites, '
          f'document and floor agree')
print()
print('the parity counts match the floors CI enforces')
PY
