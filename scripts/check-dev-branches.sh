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
ALLOWED=(
  'privacy'
  'integrations/sanitizeError'
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

[ "$failed" -eq 0 ] && echo "ok: every __DEV__ branch is accounted for"
exit "$failed"
