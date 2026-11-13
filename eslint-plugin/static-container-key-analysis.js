'use strict';

function createStaticContainerKeyTools({
  context,
  immutableInit,
  resolveVariable,
  unwrap,
}) {
  const staticCallKey = (node) => {
    const current = unwrap(node);
    if (current?.type === 'Literal') {
      return typeof current.value === 'string' ? current.value : null;
    }
    if (
      current?.type === 'TemplateLiteral' &&
      current.expressions.length === 0
    ) {
      return current.quasis[0]?.value?.cooked ?? null;
    }
    return null;
  };

  const staticForwarderKey = (node, seen = new Set()) => {
    const current = unwrap(node);
    if (!current) return null;
    if (current.type === 'Literal') {
      return typeof current.value === 'string' ? current.value : null;
    }
    if (current.type === 'Identifier') {
      const variable = resolveVariable(context, current);
      if (!variable || seen.has(variable)) return null;
      const nextSeen = new Set(seen);
      nextSeen.add(variable);
      return staticForwarderKey(immutableInit(variable), nextSeen);
    }
    if (current.type === 'BinaryExpression' && current.operator === '+') {
      const left = staticForwarderKey(current.left, new Set(seen));
      const right = staticForwarderKey(current.right, new Set(seen));
      return left === null || right === null ? null : left + right;
    }
    if (current.type === 'TemplateLiteral') {
      let value = current.quasis[0]?.value.cooked ?? '';
      for (let index = 0; index < current.expressions.length; index += 1) {
        const expression = staticForwarderKey(
          current.expressions[index],
          new Set(seen)
        );
        if (expression === null) return null;
        value += expression + (current.quasis[index + 1]?.value.cooked ?? '');
      }
      return value;
    }
    return null;
  };

  const staticMemberKey = (member) =>
    member.computed
      ? staticForwarderKey(member.property)
      : member.property.type === 'Identifier'
        ? member.property.name
        : null;

  const staticContainerKey = (node, seen = new Set()) => {
    const current = unwrap(node);
    if (!current) return null;
    if (current.type === 'Literal') {
      return ['string', 'number'].includes(typeof current.value)
        ? String(current.value)
        : null;
    }
    if (current.type === 'Identifier') {
      const variable = resolveVariable(context, current);
      if (!variable || seen.has(variable)) return null;
      const nextSeen = new Set(seen);
      nextSeen.add(variable);
      return staticContainerKey(immutableInit(variable), nextSeen);
    }
    return staticForwarderKey(current);
  };

  const staticContainerMemberKey = (member) =>
    member.computed
      ? staticContainerKey(member.property)
      : member.property.type === 'Identifier'
        ? member.property.name
        : null;

  return Object.freeze({
    staticCallKey,
    staticContainerKey,
    staticContainerMemberKey,
    staticMemberKey,
  });
}

module.exports = { createStaticContainerKeyTools };
