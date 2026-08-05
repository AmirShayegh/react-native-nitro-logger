'use strict';

function createStaticContainerMemberProjectionTools({
  builtinNamespaceOf,
  context,
  expandedArrayElements,
  immutableInit,
  propertyKeyName,
  receiverAnalysisStats,
  resolveVariable,
  staticContainerExpressionValues,
  staticContainerKey,
  staticContainerMemberKey,
  staticContainerMemberWriteValues,
  staticContainerProjection,
  unwrap,
}) {
  let staticAccessorReturnIsExact;
  const staticGetterReturnCache = new WeakMap();

  const staticGetterValues = (property, seen = new Set()) => {
    let cached = staticGetterReturnCache.get(property);
    if (!cached) {
      const getter = unwrap(property.value);
      const block = getter?.body;
      if (block?.type !== 'BlockStatement') {
        cached = { only: null, values: [] };
        staticGetterReturnCache.set(property, cached);
      } else {
        const values = [];
        const visitorKeys = context.sourceCode?.visitorKeys ?? {};
        const pending = [...block.body];
        while (pending.length > 0) {
          const current = pending.pop();
          if (!current) continue;
          if (current.type === 'ReturnStatement') {
            if (current.argument) values.push(current.argument);
            continue;
          }
          if (
            current.type === 'FunctionDeclaration' ||
            current.type === 'FunctionExpression' ||
            current.type === 'ArrowFunctionExpression' ||
            current.type === 'ClassDeclaration' ||
            current.type === 'ClassExpression'
          ) {
            continue;
          }
          for (const key of visitorKeys[current.type] ?? Object.keys(current)) {
            if (key === 'parent') continue;
            const child = current[key];
            const children = Array.isArray(child) ? child : [child];
            for (const candidate of children) {
              if (candidate && typeof candidate.type === 'string') {
                pending.push(candidate);
              }
            }
          }
        }
        const only = block.body.length === 1 ? block.body[0] : null;
        cached = { only, values };
        staticGetterReturnCache.set(property, cached);
      }
    }
    if (!cached.only && cached.values.length === 0) {
      return staticContainerProjection([], true, true, true);
    }
    const exact =
      cached.only?.type === 'ReturnStatement' &&
      !!cached.only.argument &&
      staticAccessorReturnIsExact(cached.only.argument, seen);
    return staticContainerProjection(cached.values, !exact, true, !exact);
  };

  const staticObjectPropertyIndexCache = new WeakMap();

  const staticObjectPropertyCandidates = (object, key) => {
    const stats = receiverAnalysisStats.get(context);
    let indexed = staticObjectPropertyIndexCache.get(object);
    if (indexed) {
      if (stats) stats.staticContainerPropertyIndexCacheHits += 1;
    } else {
      if (stats) stats.staticContainerPropertyIndexComputations += 1;
      indexed = { all: [], exact: new Map(), wildcard: [] };
      for (let index = 0; index < object.properties.length; index += 1) {
        if (stats) stats.staticContainerPropertyIndexPropertyVisits += 1;
        const property = object.properties[index];
        const propertyKey =
          property.type === 'SpreadElement'
            ? null
            : property.computed
              ? staticContainerKey(property.key)
              : propertyKeyName(property);
        const entry = Object.freeze({
          index,
          property,
          propertyKey,
          wildcard: property.type === 'SpreadElement' || propertyKey === null,
        });
        indexed.all.push(entry);
        if (entry.wildcard) {
          indexed.wildcard.push(entry);
          continue;
        }
        let bucket = indexed.exact.get(propertyKey);
        if (!bucket) {
          bucket = [];
          indexed.exact.set(propertyKey, bucket);
        }
        bucket.push(entry);
      }
      staticObjectPropertyIndexCache.set(object, indexed);
    }
    if (key === null) return indexed.all;

    const exact = indexed.exact.get(key) ?? [];
    const wildcard = indexed.wildcard;
    if (exact.length === 0) return wildcard;
    if (wildcard.length === 0) return exact;
    const ordered = [];
    let exactIndex = 0;
    let wildcardIndex = 0;
    while (exactIndex < exact.length || wildcardIndex < wildcard.length) {
      if (
        wildcardIndex >= wildcard.length ||
        (exactIndex < exact.length &&
          exact[exactIndex].index < wildcard[wildcardIndex].index)
      ) {
        ordered.push(exact[exactIndex]);
        exactIndex += 1;
      } else {
        ordered.push(wildcard[wildcardIndex]);
        wildcardIndex += 1;
      }
    }
    return ordered;
  };

  const staticObjectKeyValues = (object, key, seen) => {
    let values = [];
    let opaque = key === null;
    let present = false;
    let namespaceOpaque = false;
    for (const entry of staticObjectPropertyCandidates(object, key)) {
      const { property, propertyKey } = entry;
      const stats = receiverAnalysisStats.get(context);
      if (stats) {
        if (entry.wildcard) {
          stats.staticContainerPropertyIndexWildcardCandidateVisits += 1;
        } else {
          stats.staticContainerPropertyIndexExactCandidateVisits += 1;
        }
      }
      if (property.type === 'SpreadElement') {
        const spread = staticContainerKeyValues(
          property.argument,
          key,
          new Set(seen)
        );
        if (spread.present && !spread.opaque) {
          values = [...spread.values];
          opaque = false;
          present = true;
        } else if (spread.opaque) {
          values.push(...spread.values);
          opaque = true;
          present ||= spread.present;
        }
        namespaceOpaque ||= spread.namespaceOpaque;
        continue;
      }
      if (key !== null && propertyKey !== null && propertyKey !== key) {
        continue;
      }
      if (property.kind === 'get') {
        const getter = staticGetterValues(property, seen);
        if (key !== null && propertyKey === key) {
          values = [...getter.values];
          opaque = getter.opaque;
          present = true;
          namespaceOpaque = getter.namespaceOpaque;
        } else {
          values.push(...getter.values);
          opaque = true;
          present = true;
          namespaceOpaque ||= getter.namespaceOpaque;
        }
        continue;
      }
      if (property.kind !== 'init') {
        values = [];
        opaque = true;
        present = true;
        namespaceOpaque = true;
        continue;
      }
      if (key !== null && propertyKey === key) {
        // A later exact property overwrites every earlier spread/computed
        // uncertainty for this key.
        values = [property.value];
        opaque = false;
        present = true;
        namespaceOpaque = false;
      } else {
        // Either the requested key or this property's key is unknown. Keep
        // every statically visible candidate and let the consumer widen only
        // if one of them is actually a builtin.
        values.push(property.value);
        opaque = true;
        present = true;
      }
    }
    return staticContainerProjection(values, opaque, present, namespaceOpaque);
  };

  const staticArrayKeyValues = (array, key) => {
    const index =
      key !== null && /^(0|[1-9]\d*)$/.test(key) ? Number(key) : null;
    const expanded = expandedArrayElements(array, context);
    if (index !== null && Number.isSafeInteger(index)) {
      if (expanded.opaqueAt === null || expanded.opaqueAt > index) {
        const value = expanded.elements[index];
        return staticContainerProjection(value ? [value] : [], false, !!value);
      }
      return staticContainerProjection(
        expanded.elements.filter(Boolean),
        true,
        expanded.elements.length > 0
      );
    }
    if (key !== null) return staticContainerProjection([], false, false);
    return staticContainerProjection(
      expanded.elements.filter(Boolean),
      true,
      expanded.elements.length > 0
    );
  };

  const staticContainerKeyValues = (source, key, seen = new Set()) => {
    const containers = staticContainerExpressionValues(source, seen);
    const values = [];
    let opaque = containers.opaque;
    let namespaceOpaque = containers.namespaceOpaque;
    let present = false;
    let absent = false;
    for (const container of containers.values) {
      const selected =
        container.type === 'ObjectExpression'
          ? staticObjectKeyValues(container, key, seen)
          : staticArrayKeyValues(container, key);
      values.push(...selected.values);
      opaque ||= selected.opaque;
      namespaceOpaque ||= selected.namespaceOpaque;
      present ||= selected.present;
      absent ||= !selected.present;
    }
    const writes = staticContainerMemberWriteValues(source, key);
    values.push(...writes.values);
    opaque ||= writes.opaque;
    namespaceOpaque ||= writes.namespaceOpaque;
    present ||= writes.present;
    return staticContainerProjection(
      values,
      opaque || (present && absent),
      present,
      namespaceOpaque
    );
  };

  const staticContainerMemberValueCache = new WeakMap();
  const staticContainerMemberValues = (member, seen = new Set()) => {
    // Top-level consumers conventionally add only the selected member to
    // their guard. Those equivalent projections are safe to share; a broader
    // caller-specific guard still computes independently so cycle opacity is
    // never hidden by a result produced under different ancestry.
    const cacheable = seen.size === 0 || (seen.size === 1 && seen.has(member));
    if (cacheable && staticContainerMemberValueCache.has(member)) {
      return staticContainerMemberValueCache.get(member);
    }
    const projected = staticContainerKeyValues(
      member.object,
      staticContainerMemberKey(member),
      seen
    );
    if (cacheable) staticContainerMemberValueCache.set(member, projected);
    return projected;
  };

  staticAccessorReturnIsExact = (node, seen = new Set()) => {
    const current = unwrap(node);
    if (!current || seen.has(current)) return false;
    if (builtinNamespaceOf(context, current) !== null) return true;
    const nextSeen = new Set(seen);
    nextSeen.add(current);
    if (
      current.type === 'Literal' ||
      current.type === 'ObjectExpression' ||
      current.type === 'ArrayExpression' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression' ||
      current.type === 'ClassExpression' ||
      current.type === 'NewExpression' ||
      current.type === 'TemplateLiteral' ||
      current.type === 'BinaryExpression' ||
      current.type === 'UnaryExpression'
    ) {
      return true;
    }
    if (
      current.type === 'ConditionalExpression' ||
      current.type === 'LogicalExpression'
    ) {
      const branches =
        current.type === 'ConditionalExpression'
          ? [current.consequent, current.alternate]
          : [current.left, current.right];
      return branches.every((branch) =>
        staticAccessorReturnIsExact(branch, nextSeen)
      );
    }
    if (current.type === 'MemberExpression') {
      const selected = staticContainerMemberValues(current, nextSeen);
      return (
        !selected.opaque &&
        !selected.namespaceOpaque &&
        selected.values.length > 0 &&
        selected.values.every((value) =>
          staticAccessorReturnIsExact(value, nextSeen)
        )
      );
    }
    if (current.type !== 'Identifier') return false;
    const variable = resolveVariable(context, current);
    if (!variable || variable.defs.length === 0) return true;
    const init = immutableInit(variable);
    return !!init && staticAccessorReturnIsExact(init, nextSeen);
  };

  return Object.freeze({
    staticContainerKeyValues,
    staticContainerMemberValues,
  });
}

module.exports = { createStaticContainerMemberProjectionTools };
