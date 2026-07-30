#!/usr/bin/env bash
#
# Every link in the shipped documentation must resolve for the reader who has
# only the npm tarball.
#
# This exists because it did not. `README.md` and `docs/PARITY.md` both cited
# the SwiftLogger repository as `github.com/amirshayegh/logger` — the name of
# the working directory it sits in locally, not the name of the repository —
# and that 404'd through the entire 0.1.0 release. Eleven references in
# PARITY.md and three in the README pointed at nothing, including the one
# backing the strongest claim this package makes.
#
# Relative links are checked against the **tarball manifest**, not the working
# tree, and are resolved relative to the document that contains them. Both
# details matter, and a first version of this script got them wrong: checking
# `-e` in the repository would have happily passed the README's original links
# to `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`, which exist here and are
# absent from the package — exactly the breakage this is meant to catch. A
# reader inside `node_modules` follows the link and gets nothing.
#
# Four things are checked: that absolute URLs answer, that relative targets are
# in the tarball, that `#fragment` anchors match a heading, and that every
# reference-style `[id]` has a definition. The last two are the quiet ones — a
# dead anchor lands the reader at the top of the page and an undefined id
# renders as literal square brackets, so neither announces itself the way a 404
# does.
#
# Network-dependent by nature, so it is not in the CI matrix where a
# rate-limited runner would turn an unrelated pull request red. `yarn release`
# runs it instead, which is the moment a broken link would otherwise escape.
set -uo pipefail

cd "$(dirname "$0")/.."

echo "==> building the tarball manifest"
# `npm pack` runs `prepare`, so the build's own chatter precedes the JSON on
# stdout; slice from the opening bracket rather than trusting the whole stream.
manifest=$(npm pack --dry-run --json 2>/dev/null \
  | sed -n '/^\[/,$p' \
  | python3 -c "import json,sys; print('\n'.join(f['path'] for f in json.load(sys.stdin)[0]['files']))")

if [ -z "$manifest" ]; then
  echo "could not read the package manifest from 'npm pack --dry-run --json'"
  exit 1
fi

export MANIFEST="$manifest"
python3 - "$@" <<'PY'
import os, pathlib, re, subprocess, sys, time

manifest = set(os.environ['MANIFEST'].splitlines())

# Only documents that actually ship are checked; a link inside CONTRIBUTING.md
# is a repository concern, not something a reader of the package can hit.
#
# Derived from the manifest rather than listed here, so a document added to
# `files` is covered the day it ships. The list used to be hardcoded, and
# adding `CHANGELOG.md` to the package left it outside the gate without
# anything saying so — a coverage hole that looks exactly like coverage.
docs = sorted(p for p in manifest
              if p.lower().endswith('.md') and pathlib.Path(p).exists())

if not docs:
    print('no markdown files in the tarball — the manifest parse is wrong')
    sys.exit(1)

link = re.compile(r'\[[^\]]*\]\(([^)]+)\)')          # inline [text](target)
ref = re.compile(r'^\[([^\]]+)\]:\s*(\S+)\s*$', re.M)  # definition [id]: target
# Usage, capturing both labels: `[text][id]` and the collapsed `[id][]`, where
# Markdown resolves the reference using the first label.
use = re.compile(r'\[([^\]]+)\]\[([^\]]*)\]')

def slugs_of(text):
    """The anchors a Markdown document offers, by GitHub's slug rules.

    Lowercase, drop everything that is not a word character, hyphen or space,
    then spaces to hyphens — and a `-1`, `-2` suffix on repeats, which is how
    two identically named headings stay separately addressable.

    An approximation of `github-slugger` rather than a port of it. It agrees on
    the punctuation these documents actually use — backticks, parentheses,
    em dashes, middots — and would disagree on a heading that contains a
    Markdown link, where GitHub slugs the link text and this slugs the URL
    along with it. There is no such heading here, and the failure mode is a
    false positive on a link nobody wrote yet.

    Headings are matched by CommonMark's ATX rule rather than "the line starts
    with a hash", because the loose version invents anchors that do not exist:
    `#not-a-heading` is a paragraph to every renderer, and treating it as a
    heading would let a genuinely dead `#not-a-heading` link pass.
    """
    slugs, counts = [], {}
    fence = None

    for line in text.splitlines():
        # A fence is three or more backticks or tildes, indented up to three
        # spaces. It is closed only by the same character, at least as many of
        # them, and nothing after — so ``` does not close ````, and ~~~ does
        # not close a backtick block. Toggling on any fence line instead would
        # leave the block early and read the `#` lines inside it as headings.
        if fence is not None:
            char, length = fence
            if re.match(rf'^ {{0,3}}{re.escape(char)}{{{length},}}[ \t]*$', line):
                fence = None
            continue

        opening = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if opening:
            fence = opening.group(1)[0], len(opening.group(1))
            continue

        # Up to three spaces, one to six hashes, then end-of-line or at least
        # one space before the content — and an optional closing run of hashes.
        heading = re.match(r'^ {0,3}#{1,6}(?:[ \t]+(.*?))?[ \t]*$', line)
        if heading is None:
            continue

        title = re.sub(r'[ \t]+#+$', '', heading.group(1) or '')
        slug = re.sub(r'[^\w\- ]', '', title.strip().lower()).replace(' ', '-')
        seen = counts.get(slug, 0)
        counts[slug] = seen + 1
        slugs.append(slug if seen == 0 else f'{slug}-{seen}')

    return slugs


absolute, relative = {}, []
anchors = []
dangling = []
for doc in docs:
    text = pathlib.Path(doc).read_text()

    # A reference-style link whose id has no definition renders as literal
    # text — square brackets and all — rather than failing loudly. Checking
    # only the definitions would miss it entirely: a typo in the *usage*
    # leaves a perfectly valid, and now unused, definition behind for this
    # script to tick off. Markdown matches these ids case-insensitively.
    defined = {name.lower() for name, _ in ref.findall(text)}
    for first, second in use.findall(text):
        # `[text][id]` uses the second label; `[id][]` collapses to the first.
        used = (second or first).strip()
        if used and used.lower() not in defined:
            dangling.append((doc, used))

    for target in link.findall(text) + [t for _, t in ref.findall(text)]:
        target = target.split(' ')[0].strip()
        if target.startswith('mailto:'):
            continue
        if target.startswith('http://') or target.startswith('https://'):
            absolute.setdefault(target.rstrip('.,'), []).append(doc)
            continue

        path, _, fragment = target.partition('#')
        if path:
            relative.append((doc, target))

        # Anchors were skipped entirely by the first version of this script, so
        # a renamed heading left a dead link behind it and the run still said
        # every link resolved. Checkable only where the document being pointed
        # into is Markdown that can be read from here; the file check above
        # covers whether it ships at all.
        owner = (os.path.normpath(str(pathlib.Path(doc).parent / path))
                 if path else doc)
        if (fragment and owner.lower().endswith('.md')
                and pathlib.Path(owner).exists()):
            anchors.append((doc, target, owner, fragment))

failures = 0

def status_of(url, attempts=3):
    """HTTP status, retried.

    This gates `yarn release`, so a transient 5xx or a rate-limited moment
    would otherwise block a publish over nothing — and observed doing exactly
    that: one run reported six failures that the next run, unchanged, did not.
    A genuinely dead link fails all three attempts; a flaky one usually does
    not survive the first retry.
    """
    code = ''
    for attempt in range(attempts):
        code = subprocess.run(
            ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}',
             '-L', '--max-time', '20', url],
            capture_output=True, text=True).stdout.strip()
        if code == '200':
            return code, attempt + 1
        # A 4xx is an answer, not a hiccup — except the two that mean "ask
        # again later". GitHub reports both primary and secondary rate limits
        # as 403 at least as often as 429, and this whole retry exists for
        # rate limiting, so not retrying 403 would have left the gate flaky
        # for precisely the case it was added to survive.
        if code.startswith('4') and code not in ('403', '429'):
            return code, attempt + 1
        if attempt + 1 < attempts:
            time.sleep(2 * (attempt + 1))
    return code, attempts


print('==> absolute URLs')
for url, sources in sorted(absolute.items()):
    code, tries = status_of(url)
    if code == '200':
        note = '' if tries == 1 else f'  (after {tries} attempts)'
        print(f'  ok   {url}{note}')
    else:
        print(f'  FAIL {url}  (HTTP {code} after {tries} attempts)  '
              f'in {", ".join(sources)}')
        failures += 1

print('==> relative links (resolved per document, checked against the tarball)')
for doc, target in sorted(set(relative)):
    path, _, anchor = target.partition('#')
    if not path:
        continue
    # Resolved against the directory of the document that contains the link,
    # which is how every markdown renderer reads it.
    resolved = os.path.normpath(str(pathlib.Path(doc).parent / path))
    if resolved in manifest:
        print(f'  ok   {target}  (from {doc})')
    elif pathlib.Path(resolved).exists():
        print(f'  FAIL {target}  (from {doc}) — exists in the repo but is NOT '
              f'in the tarball, so this link is dead inside node_modules')
        failures += 1
    else:
        print(f'  FAIL {target}  (from {doc}) — no such file')
        failures += 1

print('==> heading anchors')
slug_cache = {}
for doc, target, owner, fragment in sorted(set(anchors)):
    if owner not in slug_cache:
        slug_cache[owner] = slugs_of(pathlib.Path(owner).read_text())
    if fragment in slug_cache[owner]:
        print(f'  ok   {target}  (from {doc})')
    else:
        print(f'  FAIL {target}  (from {doc}) — {owner} has no heading that '
              f'slugs to "{fragment}", so this link lands at the top of the '
              f'page instead')
        failures += 1
if not anchors:
    print('  ok   no anchor links to check')

print('==> reference-style link ids')
if dangling:
    for doc, used in dangling:
        print(f'  FAIL [{used}] in {doc} — no matching [{used}]: definition, '
              f'so this renders as literal text rather than a link')
    failures += len(dangling)
else:
    print('  ok   every reference-style link resolves to a definition')

total = (len(absolute) + len(set(relative)) + len(set(anchors))
         + len(dangling))
print()

# Floors, because "no failures" and "nothing checked" print the same way.
#
# Every category above is found by a regex over Markdown. Change how a document
# writes its links, or break one of those patterns, and this script reports
# `all 0 documentation links resolve` and exits 0 — a clean pass over an empty
# set, which is the exact defect it was built to catch in other people's
# documentation. So the count itself is asserted.
#
# Split by category rather than one total: absolute URLs and relative paths are
# found by different patterns and would fail independently, and a total alone
# lets one category's links cover for the other's pattern having died. Anchors
# have no floor — a document legitimately might not link into a heading, and
# the branch above says so out loud rather than silently.
MINIMUM_LINKS = 15
MINIMUM_ABSOLUTE = 5
MINIMUM_RELATIVE = 3

vacuous = []
if total < MINIMUM_LINKS:
    vacuous.append(f'{total} link(s) found in total, below the floor of '
                   f'{MINIMUM_LINKS}')
if len(absolute) < MINIMUM_ABSOLUTE:
    vacuous.append(f'{len(absolute)} absolute URL(s), below the floor of '
                   f'{MINIMUM_ABSOLUTE}')
if len(set(relative)) < MINIMUM_RELATIVE:
    vacuous.append(f'{len(set(relative))} relative link(s), below the floor of '
                   f'{MINIMUM_RELATIVE}')

if vacuous:
    for problem in vacuous:
        print(f'FAIL: {problem}')
    print('this run checked less than the documentation contains, so a pass '
          'would mean nothing. Either the link patterns stopped matching or '
          'the manifest is wrong.')
    sys.exit(1)

if failures:
    print(f'{failures} of {total} documentation links are broken')
    sys.exit(1)
print(f'all {total} documentation links resolve')
PY
