'use strict';

function createStaticContainerPatternTools({
  context,
  expandedArrayElements,
  propertyKeyName,
  staticContainerExpressionValues,
  staticContainerKey,
  staticContainerKeyValues,
  staticContainerProjection,
}) {
  const patternContainsTarget = (pattern, target) => {
    if (!pattern) return false;
    if (pattern === target) return true;
    if (pattern.type === 'AssignmentPattern') {
      return patternContainsTarget(pattern.left, target);
    }
    if (pattern.type === 'RestElement') {
      return patternContainsTarget(pattern.argument, target);
    }
    if (pattern.type === 'ArrayPattern') {
      return pattern.elements.some((element) =>
        patternContainsTarget(element, target)
      );
    }
    if (pattern.type === 'ObjectPattern') {
      return pattern.properties.some((property) =>
        patternContainsTarget(
          property.type === 'RestElement' ? property.argument : property.value,
          target
        )
      );
    }
    return false;
  };

  const staticContainerPatternValues = (
    pattern,
    target,
    source,
    seen = new Set()
  ) => {
    if (!patternContainsTarget(pattern, target)) {
      return staticContainerProjection([], true, false);
    }
    if (pattern === target) {
      return staticContainerProjection(
        source ? [source] : [],
        !source,
        !!source
      );
    }
    if (pattern.type === 'AssignmentPattern') {
      const primary = staticContainerPatternValues(
        pattern.left,
        target,
        source,
        new Set(seen)
      );
      const fallback = staticContainerPatternValues(
        pattern.left,
        target,
        pattern.right,
        new Set(seen)
      );
      return staticContainerProjection(
        [...primary.values, ...fallback.values],
        primary.opaque || fallback.opaque || primary.present,
        primary.present || fallback.present
      );
    }
    if (pattern.type === 'RestElement') {
      return staticContainerProjection([], true, false);
    }
    if (pattern.type === 'ObjectPattern') {
      const property = pattern.properties.find(
        (candidate) =>
          candidate.type === 'Property' &&
          patternContainsTarget(candidate.value, target)
      );
      if (!property) return staticContainerProjection([], true, false);
      const key = property.computed
        ? staticContainerKey(property.key)
        : propertyKeyName(property);
      const selected = staticContainerKeyValues(source, key, seen);
      const values = [];
      let opaque = selected.opaque;
      let empty = false;
      for (const value of selected.values) {
        const nested = staticContainerPatternValues(
          property.value,
          target,
          value,
          new Set(seen)
        );
        values.push(...nested.values);
        opaque ||= nested.opaque;
        empty ||= nested.values.length === 0;
      }
      return staticContainerProjection(
        values,
        opaque || (values.length > 0 && empty),
        selected.present
      );
    }
    if (pattern.type === 'ArrayPattern') {
      const index = pattern.elements.findIndex((element) =>
        patternContainsTarget(element, target)
      );
      if (index < 0) return staticContainerProjection([], true, false);
      const element = pattern.elements[index];
      if (element?.type === 'RestElement') {
        const containers = staticContainerExpressionValues(source, seen);
        const values = [];
        let opaque = containers.opaque;
        let present = false;
        for (const container of containers.values) {
          if (container.type !== 'ArrayExpression') {
            opaque = true;
            continue;
          }
          const expanded = expandedArrayElements(container, context);
          const rest = {
            type: 'ArrayExpression',
            elements: expanded.elements.slice(index),
          };
          const nested = staticContainerPatternValues(
            element.argument,
            target,
            rest,
            new Set(seen)
          );
          values.push(...nested.values);
          opaque ||=
            nested.opaque ||
            (expanded.opaqueAt !== null &&
              expanded.opaqueAt <= expanded.elements.length);
          present ||= nested.present;
        }
        return staticContainerProjection(values, opaque, present);
      }
      const selected = staticContainerKeyValues(source, String(index), seen);
      const values = [];
      let opaque = selected.opaque;
      let empty = false;
      for (const value of selected.values) {
        const nested = staticContainerPatternValues(
          pattern.elements[index],
          target,
          value,
          new Set(seen)
        );
        values.push(...nested.values);
        opaque ||= nested.opaque;
        empty ||= nested.values.length === 0;
      }
      return staticContainerProjection(
        values,
        opaque || (values.length > 0 && empty),
        selected.present
      );
    }
    return staticContainerProjection([], true, false);
  };

  const referenceStaticContainerPatternValues = (reference) => {
    const identifier = reference.identifier;
    if (!identifier) {
      return staticContainerProjection(
        reference.writeExpr ? [reference.writeExpr] : [],
        !reference.writeExpr,
        !!reference.writeExpr
      );
    }
    let current = identifier;
    for (let parent = current.parent; parent; parent = current.parent) {
      const transparent =
        parent.type === 'AssignmentPattern'
          ? parent.left === current
          : parent.type === 'Property'
            ? parent.value === current
            : parent.type === 'ObjectPattern' ||
              parent.type === 'ArrayPattern' ||
              parent.type === 'RestElement';
      if (transparent) {
        current = parent;
        continue;
      }
      if (
        parent.type === 'AssignmentExpression' &&
        parent.left === current &&
        ['=', '&&=', '||=', '??='].includes(parent.operator)
      ) {
        return staticContainerPatternValues(current, identifier, parent.right);
      }
      break;
    }
    return staticContainerProjection([], true, false);
  };

  return Object.freeze({
    referenceStaticContainerPatternValues,
    staticContainerPatternValues,
  });
}

module.exports = { createStaticContainerPatternTools };
