'use strict';

const {
  resolveVariable,
  singleDef,
  staticStringValue,
  unwrap,
} = require('./shared');
const { hasOwn } = require('./event-artifact');
const {
  hasSpread,
  immutableInit,
  importedName,
  importSource,
} = require('./event-call-analysis');
const { PRIVACY_WRAPPER_NAMES, privacyModules } = require('./event-options');

function wrapper(context, node) {
  const current = unwrap(node);
  if (!current || current.type !== 'CallExpression') return null;
  const callee = unwrap(current.callee);
  if (!callee || callee.type !== 'Identifier') return null;
  const variable = resolveVariable(context, callee);
  const def = variable && singleDef(variable);
  const name = importedName(def);
  if (
    !PRIVACY_WRAPPER_NAMES.has(name) ||
    !privacyModules(context).has(importSource(def))
  ) {
    return null;
  }
  if (current.arguments.length !== 1 || hasSpread(current.arguments)) {
    return Object.freeze({ invalid: true, payload: null });
  }
  return Object.freeze({ invalid: false, payload: current.arguments[0] });
}

function staticNumber(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return null;
  if (current.type === 'Literal' && typeof current.value === 'number') {
    return current.value;
  }
  if (
    current.type === 'UnaryExpression' &&
    (current.operator === '-' || current.operator === '+')
  ) {
    const value = staticNumber(context, current.argument, seen);
    return value === null ? null : current.operator === '-' ? -value : value;
  }
  if (current.type !== 'Identifier') return null;
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return null;
  seen.add(variable);
  return staticNumber(context, immutableInit(variable), seen);
}

function staticPrimitive(context, node) {
  const string = staticStringValue(context, node);
  if (string !== null) return Object.freeze({ known: true, value: string });
  const number = staticNumber(context, node);
  if (number !== null) return Object.freeze({ known: true, value: number });
  const current = unwrap(node);
  if (
    current?.type === 'Literal' &&
    (typeof current.value === 'boolean' || current.value === null)
  ) {
    return Object.freeze({ known: true, value: current.value });
  }
  return Object.freeze({ known: false, value: undefined });
}

function satisfies(constraint, value) {
  if (constraint.type === 'integer') {
    return (
      Number.isSafeInteger(value) &&
      value >= constraint.minimum &&
      value <= constraint.maximum
    );
  }
  return typeof value === 'string' && hasOwn(constraint.members, value);
}

function classifyEventPrivacy(context, structure) {
  if (structure.error) return Object.freeze([]);
  const values = [];
  for (const property of structure.properties) {
    if (!property.value) continue;
    const wrapped = wrapper(context, property.value);
    if (wrapped?.invalid) {
      values.push(Object.freeze({ ...property, privacy: 'invalid-wrapper' }));
      continue;
    }
    const candidate = wrapped ? wrapped.payload : property.value;
    const primitive = staticPrimitive(context, candidate);
    const valid =
      !primitive.known ||
      (!!property.descriptor &&
        satisfies(property.descriptor.constraint, primitive.value));
    values.push(
      Object.freeze({
        ...property,
        privacy: wrapped ? 'wrapped' : primitive.known ? 'static' : 'unwrapped',
        staticKnown: primitive.known,
        valid,
      })
    );
  }
  return Object.freeze(values);
}

module.exports = { classifyEventPrivacy, satisfies };
