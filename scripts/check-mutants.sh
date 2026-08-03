#!/usr/bin/env bash
#
# Proves that specific defects are still caught, by reintroducing them.
#
# A passing suite says the tests agree with the code. It does not say they
# would notice if the code changed — and this repository has produced six
# tests that asserted nothing at all while reporting a pass: an assertion on a
# buffer state the code never reaches, an `if let` that never bound because
# the fault it arranged makes `open` fail outright, an end-state count that
# both the correct and the broken implementation arrive at. Every one was
# green. Coverage would have called them covered.
#
# So each patch in `scripts/mutants/` reintroduces one real defect, and the
# manifest names the single test that must fail because of it. A mutant that
# survives means the test guarding that behaviour has stopped guarding it.
#
# ## What this proves, and what it does not
#
#   * It proves the manifest-listed defects stay caught. It is not a coverage
#     measure and not a substitute for one — a line can be executed by every
#     test in the suite and asserted on by none.
#   * It cannot notice an invariant added after the manifest was written. New
#     behaviour needs a new mutant; nothing here will ask for one.
#   * It is JavaScript only. A native mutant costs a full Swift or Gradle
#     rebuild per row — minutes each — so the Swift and Kotlin suites keep the
#     manual discipline instead. Deliberate, not an oversight.
#   * It patches `src/` and `eslint-plugin/` only. A defect whose shape
#     requires a *new export* — a payload-recovery function, say — cannot be
#     expressed here, because adding one also trips the privacy sweep's
#     fail-closed inventory assertion and the kill would be attributed to the
#     wrong check. Those shapes are covered by that inventory assertion
#     instead, which is what it is for.
#
# The harness checks its own vacuity before trusting itself: the control run
# below requires the UNMUTATED copy to pass every suite a mutant expects to
# break. Without that, a suite broken for an unrelated reason would let every
# mutant "die" and the whole gate would report success having proved nothing.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
MUTANTS="$ROOT/scripts/mutants"
MANIFEST="$MUTANTS/manifest.json"

if [ ! -f "$MANIFEST" ]; then
  echo "FAIL: no manifest at $MANIFEST"
  exit 1
fi

# Every file git tracks, copied to scratch. The working tree is never touched:
# a harness that mutated it in place would lose uncommitted work the moment it
# was interrupted, and `git checkout` to undo a mutation is exactly how that
# happens.
WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

git ls-files -z | tar --null -cf - -T - | (cd "$WORK" && tar xf -)
ln -s "$ROOT/node_modules" "$WORK/node_modules"

# The manifest and the patch directory have to agree. A patch nobody runs is
# dead weight that reads like protection; a manifest row with no patch is a
# claim with nothing behind it.
python3 - "$MANIFEST" "$MUTANTS" <<'PY' || exit 1
import json, pathlib, sys
manifest = json.loads(pathlib.Path(sys.argv[1]).read_text())
listed = {m["patch"] for m in manifest["mutants"]}
present = {p.name for p in pathlib.Path(sys.argv[2]).glob("*.patch")}
if listed != present:
    for p in sorted(listed - present):
        print(f"FAIL: manifest names {p}, which does not exist")
    for p in sorted(present - listed):
        print(f"FAIL: {p} exists but no manifest row runs it")
    sys.exit(1)
print(f"ok:   {len(listed)} patches, {len(manifest['mutants'])} manifest rows, in agreement")
PY

SUITES="$(python3 -c "
import json,sys
m=json.load(open('$MANIFEST'))
print(' '.join(sorted({x['expect_red']['suite'] for x in m['mutants']})))
")"

echo "==> control run: the unmutated copy must pass every suite a mutant targets"
# shellcheck disable=SC2086
(cd "$WORK" && npx jest --ci --silent $SUITES) >"$WORK/control.log" 2>&1
if [ $? -ne 0 ]; then
  echo "FAIL: the control run is red, so no mutant below could be trusted to"
  echo "      die for its own reason. Fix the suite first."
  tail -30 "$WORK/control.log"
  exit 1
fi
echo "ok:   control run green across: $SUITES"
echo

failed=0
total=0

while IFS=$'\t' read -r id patch target suite test; do
  total=$((total + 1))
  printf '  %-34s ' "$id"

  if ! (cd "$WORK" && git apply --check "$MUTANTS/$patch") 2>/dev/null; then
    # Not a skip. A patch that no longer applies is a patch whose target moved
    # under it, and the defect it pinned is now unpinned — which is the thing
    # this gate exists to notice.
    echo "FAIL — patch no longer applies to $target"
    failed=$((failed + 1))
    continue
  fi

  (cd "$WORK" && git apply "$MUTANTS/$patch")
  (cd "$WORK" && npx jest --ci --silent --json \
    --outputFile="$WORK/result.json" "$suite") >/dev/null 2>&1
  status=$?
  (cd "$WORK" && git apply -R "$MUTANTS/$patch")

  if [ $status -eq 0 ]; then
    echo "SURVIVED — '$test' passed with the defect present"
    failed=$((failed + 1))
    continue
  fi

  # Red is not enough: the run has to be red for the NAMED test. A mutant that
  # broke something unrelated — a type error, an import — would otherwise sign
  # itself off while the behaviour it targets went unguarded.
  if ! TEST="$test" python3 - "$WORK/result.json" <<'PY'
import json, os, sys
data = json.load(open(sys.argv[1]))
want = os.environ["TEST"]
for suite in data.get("testResults", []):
    for case in suite.get("assertionResults", []):
        if case.get("status") == "failed" and want in case.get("fullName", ""):
            sys.exit(0)
sys.exit(1)
PY
  then
    echo "FAIL — red, but not at '$test'"
    failed=$((failed + 1))
    continue
  fi

  echo "killed by '$test'"
done < <(python3 -c "
import json
m=json.load(open('$MANIFEST'))
for x in m['mutants']:
    print('\t'.join([x['id'], x['patch'], x['target'],
                     x['expect_red']['suite'], x['expect_red']['test']]))
")

echo
ACCEPTED="$(python3 -c "
import json
m=json.load(open('$MANIFEST'))
print(len(m.get('accepted_survivors', [])))
")"
if [ "$ACCEPTED" != "0" ]; then
  echo "note: $ACCEPTED knowingly accepted survivor(s) recorded in the manifest"
fi

if [ "$failed" -ne 0 ]; then
  echo "FAIL: $failed of $total mutants were not caught"
  exit 1
fi

echo "ok:   all $total pinned defects are still caught"
