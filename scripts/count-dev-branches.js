#!/usr/bin/env node
'use strict';

/**
 * Counts the `__DEV__` *branches* in a TypeScript source file, and prints the
 * number. Called once per allowlisted module by `check-dev-branches.sh`.
 *
 * A grep counts lines, which is neither an upper nor a lower bound on
 * branches, and both directions matter here. Two guards written on one line
 * count once — that is a reveal the pin would wave through. A `__DEV__` inside
 * a block comment counts as code — that is a build failing over a sentence,
 * which is how a gate ends up deleted rather than updated. Neither is
 * acceptable for the one check standing between a release build and a
 * diagnostic that renders private data.
 *
 * So: parse it. A branch is the nearest enclosing *statement* of each
 * `__DEV__` identifier, deduplicated by source position. That reads the way
 * the code does — `typeof __DEV__ !== 'undefined' && __DEV__` is two
 * identifiers inside one `if`, so one branch; two `if`s sharing a line are
 * two — and comments are not in the AST at all, so they cannot be counted by
 * accident.
 *
 * Type checking is not involved and no program is created: this is a
 * syntactic question about one file, and a full program would need the whole
 * tsconfig resolution to answer it no better.
 */

const ts = require('typescript');
const { readFileSync } = require('fs');

const [, , path] = process.argv;
if (!path) {
  console.error('usage: count-dev-branches.js <file.ts>');
  process.exit(2);
}

const file = ts.createSourceFile(
  path,
  readFileSync(path, 'utf8'),
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TS
);

/** Positions of the statements that mention `__DEV__`; a Set, so one each. */
const branches = new Set();

function visit(node) {
  if (ts.isIdentifier(node) && node.text === '__DEV__') {
    // Up to the nearest statement. An identifier always has one above it —
    // an expression at the top of a file is an ExpressionStatement — but the
    // loop stops at the SourceFile regardless, so a shape this does not
    // anticipate is counted rather than crashing the gate.
    let owner = node;
    while (owner.parent && !ts.isStatement(owner)) owner = owner.parent;
    branches.add(`${owner.pos}:${owner.end}`);
  }
  ts.forEachChild(node, visit);
}

visit(file);

console.log(branches.size);
