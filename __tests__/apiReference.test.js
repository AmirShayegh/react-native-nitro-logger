const { readFileSync } = require('fs');
const { join } = require('path');
const ts = require('typescript');

/**
 * `docs/API.md` claims to document every export. This is what keeps that true.
 *
 * The reference was written by hand from the source doc comments, which makes
 * it good prose and a standing liability: nothing about adding an export makes
 * anyone open the reference, so the natural end state of a hand-written API
 * document is one that quietly describes an older library than the one that
 * ships.
 *
 * Same reasoning as the `LOGGER_OWN_METHODS` pin in `eslintPlugin.test.js` — a
 * new emitting method there fails the suite until it is classified, and a new
 * export here fails until it is documented or consciously exempted.
 *
 * JavaScript rather than TypeScript for the same reason that file is: this
 * reads from disk, and the project's `tsconfig` pins `types` to react-native
 * and jest with no `@types/node`. Adding a dependency so a documentation guard
 * can call `readFileSync` is a worse trade than writing it in the language the
 * repository already uses for tests that touch the filesystem.
 *
 * Nothing here matches loose against the file. Two structures are parsed, and
 * each is compared against the exports in both directions:
 *
 * - the **Index** section, which is the inventory; and
 * - the `<!-- api: … -->` **markers**, one per subsection, which say where a
 *   name is actually described.
 *
 * Both exist because either alone is too weak. An index is easy to satisfy
 * without writing a word of documentation. A prose search is easier still:
 * the first version of this test looked for the export name anywhere in the
 * body with a word-boundary regex, which meant the page's own table of
 * contents was enough to make a name count as documented. The markers give
 * "described" a location, and running each check in reverse catches the other
 * failure — a rename leaves the old name behind, advertising an API that no
 * longer exists, and a one-sided check stays green through it.
 *
 * All of that rests on knowing what the exports *are*, which is why the export
 * list comes from the TypeScript parser rather than from regexes over the
 * source. See `parseExports`.
 *
 * ## What the subsection checks do and do not claim
 *
 * The above was the whole of this file through 0.1.2, and it was satisfied by a
 * document with no documentation in it: `docs/API.md` reduced to a title, its
 * Index and nineteen bare markers — 82% deleted, every word of prose gone —
 * passed all ten tests. Both structures were intact, so both comparisons held.
 *
 * So the markers are now read as boundaries as well as claims, and each
 * subsection is checked for content. Precisely:
 *
 * - **It has prose.** The subsection is stripped of its heading, code fences,
 *   HTML and markers, and what remains must reach `MINIMUM_PROSE_WORDS`. This
 *   is what the gutted file fails, and what a `TODO` placeholder fails.
 * - **The name is identified inside it.** Every name a marker claims must
 *   appear in the subsection that marker closes — the heading, a rendered
 *   signature, or the prose — with the **marker itself excluded**, since
 *   searching the raw subsection would find the name inside the very comment
 *   making the claim and the assertion would be tautological.
 *
 * Two things are deliberately **not** claimed, and saying so is the point:
 *
 * - **Relevance.** A subsection of threshold-length prose that mentions the
 *   name and describes something else entirely passes. No word count can tell
 *   the difference, and a gate that implied otherwise would be worse than one
 *   that admits it.
 * - **A rendered signature per export.** The plan considered requiring one.
 *   This document renders signatures where they help and writes sentences where
 *   they do not — a type alias, a constant, the `Log` singleton — and forcing
 *   code fences into those places would degrade the page to satisfy a checker.
 *
 * Semantic accuracy stays human review. What is mechanical is that every export
 * is accounted for, described in a specific place, that the place contains
 * something, and that nothing is described that is gone.
 */

const SOURCE = join(__dirname, '..', 'src', 'index.tsx');
const REFERENCE = join(__dirname, '..', 'docs', 'API.md');

/**
 * Exports deliberately left out of the reference, each with its reason.
 *
 * Empty, and worth keeping that way. The Nitro call-result types were once
 * exempted here on the grounds that a consumer meets them only through
 * `FileDestination` — but they are root exports, and a `FileSinkLike`
 * implementation has to construct them, so something you must build is part of
 * the API whether or not you were meant to notice it. They are documented
 * under "Native call results" instead.
 *
 * The mechanism stays because a genuinely internal export may appear later.
 * Anything added here is then a decision with a reason attached rather than an
 * oversight, which is the point of a list over a pattern.
 */
const UNDOCUMENTED = new Map();

/**
 * Every export of `src/index.tsx`, read with the TypeScript parser.
 *
 * Returns `{ names, unresolvable }` — the exported names, and any export
 * statement whose names cannot be determined from this file alone.
 *
 * Regexes did this job first and could not be made safe. Whatever syntax the
 * patterns were not taught became a blind spot, and an export in that blind
 * spot is missing from *both* sides of every comparison below: undocumented
 * and unreported at once. Scanning for the leftover `export` keywords narrowed
 * the hole without closing it, because deciding which keywords are declarations
 * means knowing which are inside comments and strings, and that is parsing.
 *
 * So this parses. `typescript` is already a devDependency — the repository
 * typechecks with it — so the exact answer costs nothing but the import, and
 * `createSourceFile` on a hundred-line barrel is syntax-only and immediate.
 * `export const`, `export class`, `export default function`, a declaration
 * behind a block comment: all read correctly rather than approximately.
 *
 * What parsing one file still cannot resolve is `export * from './x'`, whose
 * names live in another module, and `export default`, which has no name to
 * index. Those go to `unresolvable` and fail the suite with the offending
 * statement, because "this barrel re-exports something I cannot enumerate" has
 * to be loud — it is the one case where the reference could be silently
 * incomplete.
 */
function parseExports() {
  const source = readFileSync(SOURCE, 'utf8');
  const file = ts.createSourceFile(
    SOURCE,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );

  const names = [];
  const unresolvable = [];
  const statementText = (node) => {
    const [firstLine] = node.getText(file).split('\n');
    return firstLine.trim().replace(/\s*\{$/, ' {…}');
  };

  const modifiersOf = (node) =>
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? [];
  const hasModifier = (node, kind) =>
    modifiersOf(node).some((modifier) => modifier.kind === kind);

  /** `export const { a, b } = …` binds more than one name. */
  const boundNames = (name) => {
    if (ts.isIdentifier(name)) return [name.text];
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      return name.elements.flatMap((element) =>
        ts.isBindingElement(element) ? boundNames(element.name) : []
      );
    }
    return [];
  };

  for (const node of file.statements) {
    // `export { a } from './x'`, `export type { A } from './x'`,
    // `export * as ns from './x'`, `export * from './x'`.
    if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      if (!clause) unresolvable.push(statementText(node));
      else if (ts.isNamespaceExport(clause)) names.push(clause.name.text);
      // `a as b` exports `b`, which is what `element.name` holds.
      else for (const element of clause.elements) names.push(element.name.text);
      continue;
    }

    // `export default …` and `export = …`.
    if (ts.isExportAssignment(node)) {
      unresolvable.push(statementText(node));
      continue;
    }

    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) continue;

    // `export default function f()` is exported as `default`, not as `f`.
    if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
      unresolvable.push(statementText(node));
      continue;
    }

    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        names.push(...boundNames(declaration.name));
      }
    } else if (node.name && ts.isIdentifier(node.name)) {
      // function, class, interface, type alias, enum, namespace.
      names.push(node.name.text);
    } else {
      unresolvable.push(statementText(node));
    }
  }

  return { names: [...new Set(names)].sort(), unresolvable };
}

/** Entries appearing more than once, in first-repeat order. */
function duplicates(names) {
  const seen = new Set();
  return names.filter((name) => {
    if (seen.has(name)) return true;
    seen.add(name);
    return false;
  });
}

/**
 * The `## Index` section: one `` - `Name` `` per line, to the next heading.
 *
 * Parsed rather than matched loose against the whole file so that "documented"
 * means an entry someone wrote on purpose, not a name that happens to occur in
 * a code sample. Repeats are preserved, for the same reason `markedNames`
 * preserves them: a membership check cannot see a name listed twice.
 */
function indexedNames(reference) {
  const section = reference.split(/^## Index$/m)[1];
  if (section === undefined) return null;

  const body = section.split(/^## /m)[0];
  return [...body.matchAll(/^- `([A-Za-z_][A-Za-z0-9_]*)`$/gm)]
    .map((match) => match[1])
    .sort();
}

/**
 * Names claimed by `<!-- api: A, B, C -->` markers, in document order.
 *
 * Each marker sits at the end of the subsection that documents the names it
 * lists, which is what lets the guard below assert that an export is described
 * *in a particular place* rather than mentioned somewhere in a long file.
 *
 * Repeats are preserved. The caller needs them to notice a name claimed twice,
 * which means one of the two markers has drifted away from the prose it was
 * meant to attest to — and the guard would still pass on the strength of the
 * other one.
 */
function markedNames(reference) {
  const names = [];

  for (const match of reference.matchAll(/^<!-- api: ([^>]*?) -->$/gm)) {
    for (const raw of match[1].split(',')) {
      const name = raw.trim();
      if (name) names.push(name);
    }
  }

  return names;
}

/**
 * The floor a documented subsection's prose has to clear.
 *
 * Chosen from the document rather than picked out of the air: the thinnest
 * subsection that anyone would call documented sits a little above this, and
 * the two that sat below it when this check was written were thin enough to be
 * worth rewriting rather than exempting. Raising it further would start
 * rejecting entries that are short because the thing they describe is simple.
 */
const MINIMUM_PROSE_WORDS = 25;

const HEADING = /^#{1,6} /;
const MARKER = /^<!-- api: ([^>]*?) -->$/;

/**
 * Each marker paired with the subsection it closes.
 *
 * The boundary is explicit rather than inferred from blank lines: a subsection
 * runs from the nearest preceding heading — or from the previous marker, if one
 * sits between that heading and this — down to the marker itself. That is what
 * makes "described here" a claim about a region of the file rather than about
 * the file.
 *
 * `context` widens the search for a *name* by the enclosing `##` section's
 * preamble, and only that. `LogDestination` is the case: it is the interface
 * introduced under `## Destinations` and claimed by the `ConsoleDestination`
 * marker below it, which is where a reader meets it. The preamble is
 * deliberately not counted toward the prose floor — one section introduction
 * must not stand in for the subsections under it.
 */
function subsections(reference) {
  const lines = reference.split('\n');

  const sectionStarts = [];
  lines.forEach((line, index) => {
    if (/^## /.test(line)) sectionStarts.push(index);
  });

  /** The `## …` heading above `index`, down to the first heading under it. */
  const preambleAbove = (index) => {
    let start = -1;
    for (const candidate of sectionStarts) {
      if (candidate <= index) start = candidate;
    }
    if (start < 0) return '';

    // Capped at the marker, not just at the first child heading. A marker
    // sitting directly under a `##` — `## Native sinks` is one — would
    // otherwise be handed the text that follows it, and a name introduced
    // after the marker would satisfy a claim the marker had already closed.
    let end = index;
    for (let cursor = start + 1; cursor < end; cursor += 1) {
      if (/^#{2,3} /.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    return lines.slice(start, end).join('\n');
  };

  const found = [];
  let boundary = -1;
  let heading = null;

  lines.forEach((line, index) => {
    if (HEADING.test(line)) {
      heading = line;
      boundary = index;
      return;
    }

    const match = line.match(MARKER);
    if (!match) return;

    found.push({
      heading,
      line: index + 1,
      names: match[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
      // From the heading inclusive: the heading is where most of these names
      // are identified, and it is part of the subsection by any reading.
      subsection: lines.slice(boundary, index).join('\n'),
      // Without it: a heading is a label, not documentation.
      body: lines.slice(boundary + 1, index).join('\n'),
      context: preambleAbove(index),
    });
    boundary = index;
  });

  return found;
}

/**
 * What is left of a subsection once everything that is not prose is removed.
 *
 * Fenced code goes because a signature is not a description — the gutted-file
 * failure this exists to catch would otherwise be survivable by pasting the
 * type back in. Headings go because the title is the claim being tested.
 * Markers and HTML go because they are machinery. Index-style `- \`Name\``
 * lines go because an inventory entry is not prose either.
 */
function proseOf(text) {
  return text
    .replace(/^```[\s\S]*?^```/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^#{1,6} .*$/gm, ' ')
    .replace(/^- `[A-Za-z_][A-Za-z0-9_]*`\s*$/gm, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The subsection with only its own markers removed — see the header. */
function searchableOf(text) {
  return text.replace(/<!--[\s\S]*?-->/g, ' ');
}

describe('docs/API.md', () => {
  const reference = readFileSync(REFERENCE, 'utf8');
  const { names: exported, unresolvable } = parseExports();
  const indexed = indexedNames(reference);
  const markedWithRepeats = markedNames(reference);
  const marked = [...new Set(markedWithRepeats)];

  test('all three lists are being read at all', () => {
    // Guards the parsers above. If any stopped matching, the comparisons below
    // would pass vacuously against an empty set.
    expect(exported.length).toBeGreaterThan(50);
    expect(exported).toContain('Log');
    expect(exported).toContain('createFileSink');
    expect(exported).toContain('ERROR_METADATA_KEYS');

    expect(indexed).not.toBeNull();
    expect(indexed.length).toBeGreaterThan(50);

    expect(marked.length).toBeGreaterThan(50);
    expect(marked).toContain('Log');
  });

  test('every export statement names something resolvable from this file', () => {
    // A statement whose names cannot be enumerated here — `export * from`,
    // `export default` — leaves the reference silently incomplete, because an
    // export nobody can name is absent from both sides of every comparison
    // below. Adding one is a decision, and this is where it gets made.
    expect(unresolvable).toEqual([]);
  });

  test('the index documents every export', () => {
    const missing = exported.filter(
      (name) => !UNDOCUMENTED.has(name) && !indexed.includes(name)
    );

    expect(missing).toEqual([]);
  });

  test('the index lists nothing twice', () => {
    // Membership checks are blind to repetition, and the page promises one
    // entry per export.
    expect(duplicates(indexed)).toEqual([]);
  });

  test('the index describes nothing that is no longer exported', () => {
    // The other direction, and the one a one-sided check misses: a rename
    // leaves the old name in the reference, advertising an API that is gone.
    const phantom = indexed.filter((name) => !exported.includes(name));

    expect(phantom).toEqual([]);
  });

  test('every export has a description marker where it is documented', () => {
    // The index is an inventory, not the documentation, so this asserts that
    // each name is described *somewhere specific*: an `<!-- api: … -->`
    // marker sits at the end of the subsection that documents it.
    //
    // Searching the body for the name instead — the previous version — was
    // satisfied by any incidental mention, and this file opens with a table
    // of contents, so several names passed on that alone.
    const undescribed = exported.filter(
      (name) => !UNDOCUMENTED.has(name) && !marked.includes(name)
    );

    expect(undescribed).toEqual([]);
  });

  test('no marker claims a name that is not exported', () => {
    const phantom = marked.filter((name) => !exported.includes(name));

    expect(phantom).toEqual([]);
  });

  test('no export is claimed by two different markers', () => {
    // Two markers for one name means one of them drifted away from the prose
    // it was meant to attest to, and the guard would still be satisfied by
    // the other.
    expect(duplicates(markedWithRepeats)).toEqual([]);
  });

  test('the omission list has no stale entries', () => {
    // An exemption for something no longer exported describes a library that
    // is gone, and would hide a real gap if the name were reintroduced.
    const stale = [...UNDOCUMENTED.keys()].filter(
      (name) => !exported.includes(name)
    );

    expect(stale).toEqual([]);
  });

  test('every omission carries a reason', () => {
    for (const [name, reason] of UNDOCUMENTED) {
      expect(name).not.toBe('');
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  describe('the subsections the markers point at', () => {
    const documented = subsections(reference);

    test('every marker was matched to a subsection', () => {
      // Guards the parser above the same way the first test guards the others:
      // a boundary rule that stopped matching would make every assertion below
      // pass over an empty list.
      expect(documented.length).toBeGreaterThan(10);
      // Same markers, same names: the boundary parser and the claim parser
      // must be reading one document. A marker the boundaries missed would
      // take its names out of every check below with nothing to notice.
      expect(documented.flatMap((entry) => entry.names).sort()).toEqual(
        [...markedWithRepeats].sort()
      );
      // Every marker closes something a heading opened. One that did not would
      // be attached to whatever preceded it.
      expect(documented.filter((entry) => entry.heading === null)).toEqual([]);
    });

    test('every subsection contains prose, not just its marker', () => {
      // The one this file was missing. `docs/API.md` cut down to a title, the
      // Index and nineteen bare markers passed every other test here.
      const thin = documented
        .map((entry) => ({
          heading: entry.heading,
          line: entry.line,
          words: proseOf(entry.body).length,
        }))
        .filter((entry) => entry.words < MINIMUM_PROSE_WORDS);

      expect(thin).toEqual([]);
    });

    test('every name a marker claims is identified in the subsection it closes', () => {
      // Not in the marker — that is stripped, or this would be a comment
      // agreeing with itself — and not merely somewhere in the file, which the
      // Index alone would satisfy for every name on the page.
      const unidentified = [];

      for (const entry of documented) {
        const haystack = searchableOf(`${entry.subsection}\n${entry.context}`);
        for (const name of entry.names) {
          if (!new RegExp(`\\b${name}\\b`).test(haystack)) {
            unidentified.push(`${name} (line ${entry.line}: ${entry.heading})`);
          }
        }
      }

      expect(unidentified).toEqual([]);
    });
  });
});
