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
 * What this still cannot assert is whether a description is any *good* — only
 * that every export is accounted for, described somewhere specific, and that
 * nothing is described that is gone.
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
});
