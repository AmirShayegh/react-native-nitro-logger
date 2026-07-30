#!/usr/bin/env bash
#
# Inventories the `__DEV__` branches in the built library.
#
# `__DEV__` is how this package decides whether a private value may render as
# itself. Every use is therefore a place where redaction can be turned off, and
# the set of those places is meant to be small, deliberate, and unchanging. This
# does not forbid `__DEV__` — builder-bob leaves it for the app's bundler to
# substitute, which is correct — it forbids *new* uses appearing without anyone
# deciding to add one.
#
# A new dev-only branch is not necessarily wrong. It just has to be a decision:
# add the file here, and say in the commit why redaction may be relaxed there.
#
# Run it anywhere: `yarn prepare && ./scripts/check-dev-branches.sh`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/lib"

# Modules allowed to branch on `__DEV__`, and why.
#
#   privacy            — the `priv()` reveal. The original one.
#   sanitizeError      — the uncaught-error message reveal, same contract.
#   Logger             — NOT a reveal. `metadataKeyCatalog` warns when a call
#                        narrowed the approved keys, because both ways of
#                        getting that wrong are silent and end with every
#                        field rendering `<private>`. The messages carry counts
#                        and never a key name — the narrowing one reports the
#                        size before and after, the first-call one reports that
#                        zero were approved. Deliberately: an approved key is
#                        application vocabulary and a rejected one may be the
#                        PHI-shaped literal the catalog exists to keep out of
#                        the log. Dev-gated so a release build does not carry a
#                        diagnostic nobody can read.
ALLOWED=(
  'privacy'
  'integrations/sanitizeError'
  'Logger'
)

# How many `__DEV__` branches each allowed module is expected to contain,
# index for index with ALLOWED.
#
# Without this the allowlist is a *module* exemption, which is far coarser than
# the decision it records. `Logger` is on the list for one dev-only warning that
# reveals nothing; a `priv()` reveal added to the same file tomorrow would
# inherit that exemption and this gate would say nothing at all. Each entry is
# one branch today, so one is what is pinned: adding a second is a decision
# somebody has to write down here and justify in the commit, which is the whole
# point of the file.
EXPECTED_BRANCHES=(
  1
  1
  1
)

if [ ! -d "$LIB" ]; then
  echo "FAIL: $LIB does not exist. Run 'yarn prepare' first."
  exit 1
fi

# Module paths, deduplicated across the module/commonjs/typescript outputs
# builder-bob emits — the same source file appears in each.
#
# Source maps are excluded: they embed the original source verbatim, so every
# gated module shows up through its map as well and the list would double for
# no new information. `sed -E`, because BSD sed does not take `\?` in a basic
# regex and would silently leave the extension on — which reads as a mismatch
# against every allowlist entry.
found="$(
  grep -rlF --include='*.js' --include='*.ts' '__DEV__' "$LIB" 2>/dev/null \
    | sed -E -e "s|^$LIB/||" -e 's|^[^/]+/||' -e 's|\.[cm]?js$||' -e 's|\.d\.ts$||' \
    | sort -u || true
)"

echo "Modules branching on __DEV__ in lib/:"
if [ -z "$found" ]; then
  echo "  (none)"
else
  echo "$found" | sed 's/^/  /'
fi

failed=0
while IFS= read -r module; do
  [ -z "$module" ] && continue
  allowed=0
  for entry in "${ALLOWED[@]}"; do
    if [ "$module" = "$entry" ]; then allowed=1; break; fi
  done
  if [ "$allowed" -eq 0 ]; then
    echo "FAIL: $module branches on __DEV__ and is not in the allowlist."
    echo "      If the branch is deliberate, add it to ALLOWED in this script"
    echo "      and explain in the commit why redaction may be relaxed there."
    failed=1
  fi
done <<< "$found"

# The reverse direction matters just as much: an allowlisted entry that no
# longer branches means the gate was removed or renamed, and the CI job that
# greps for its sentinel has quietly stopped proving anything.
for entry in "${ALLOWED[@]}"; do
  if ! echo "$found" | grep -qx "$entry"; then
    echo "FAIL: $entry is allowlisted but no longer branches on __DEV__."
    echo "      Either the gate was removed — update this script — or it was"
    echo "      renamed, in which case the release-bundle check is now vacuous."
    failed=1
  fi
done

# Counted in `src/`, not in `lib/`: the same source file appears once per
# builder-bob output, so a lib-side count would be a multiple of the real one
# and would change with the build targets rather than with the code.
#
# Counted by parsing rather than by grep — see scripts/count-dev-branches.js
# for why a line count is wrong in both directions here.
for i in "${!ALLOWED[@]}"; do
  entry="${ALLOWED[$i]}"
  expected="${EXPECTED_BRANCHES[$i]}"
  src="$ROOT/src/$entry.ts"

  if [ ! -f "$src" ]; then
    echo "FAIL: $entry is allowlisted but $src does not exist."
    echo "      The allowlist names lib/ module paths, which are src/ paths"
    echo "      with the extension dropped; a rename means both lists move."
    failed=1
    continue
  fi

  # A counter that cannot run is a failure, not a skip: this is the only check
  # that would notice a second reveal added to an already-exempt module.
  if ! actual="$(node "$ROOT/scripts/count-dev-branches.js" "$src" 2>&1)"; then
    echo "FAIL: could not count the __DEV__ branches in $entry."
    echo "$actual" | sed 's/^/      /'
    failed=1
    continue
  fi

  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $entry has $actual __DEV__ branch(es), expected $expected."
    echo "      An allowlist entry exempts the whole module, so the count is"
    echo "      pinned as well: a new branch here would otherwise inherit the"
    echo "      decision recorded for a different one. If the new branch is"
    echo "      deliberate, say what it is in the comment above, update"
    echo "      EXPECTED_BRANCHES, and justify the reveal in the commit."
    failed=1
  fi
done

[ "$failed" -eq 0 ] && echo "ok: every __DEV__ branch is accounted for"
exit "$failed"
