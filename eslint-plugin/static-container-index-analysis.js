'use strict';

function createStaticContainerMemberWriteIndex({
  analysisStats,
  context,
  isWriteTarget,
  memberKey,
  projection,
  resolveVariable,
  transparentParent,
  unwrap,
}) {
  const bindingIndex = new WeakMap();

  const indexBinding = (variable) => {
    const cached = bindingIndex.get(variable);
    if (cached) return cached;
    const stats = analysisStats(context);
    if (stats) stats.staticContainerMemberWriteIndexComputations += 1;
    const aliases = [];
    const writes = [];
    for (const reference of variable.references) {
      if (stats) stats.staticContainerMemberWriteReferenceVisits += 1;
      const identifier = reference.identifier;
      if (!identifier || reference.init === true) continue;
      let referenceNode = identifier;
      let parent = referenceNode.parent;
      while (transparentParent(parent, referenceNode)) {
        referenceNode = parent;
        parent = referenceNode.parent;
      }

      if (
        parent?.type === 'VariableDeclarator' &&
        parent.init === referenceNode &&
        parent.id.type === 'Identifier'
      ) {
        const alias = resolveVariable(context, parent.id);
        if (alias) aliases.push(alias);
        continue;
      }
      if (
        parent?.type !== 'MemberExpression' ||
        parent.object !== referenceNode
      ) {
        continue;
      }
      let member = parent;
      const path = [memberKey(member)];
      while (
        member.parent?.type === 'MemberExpression' &&
        member.parent.object === member
      ) {
        member = member.parent;
        path.push(memberKey(member));
      }
      const owner = member.parent;
      if (owner?.type === 'AssignmentExpression' && owner.left === member) {
        writes.push({ path, value: owner.right });
      } else if (isWriteTarget(member)) {
        writes.push({ path, value: null });
      }
    }
    const writesByFirstSegment = new Map();
    const wildcardWrites = [];
    for (const write of writes) {
      const first = write.path[0];
      if (first === null) {
        wildcardWrites.push(write);
        continue;
      }
      let bucket = writesByFirstSegment.get(first);
      if (!bucket) {
        bucket = [];
        writesByFirstSegment.set(first, bucket);
      }
      bucket.push(write);
    }
    const indexed = {
      aliases,
      overlapCache: new Map(),
      wildcardWrites,
      writes,
      writesByFirstSegment,
    };
    bindingIndex.set(variable, indexed);
    return indexed;
  };

  const overlappingWriteProjection = (indexed, requestedPath) => {
    const cacheKey = JSON.stringify(requestedPath);
    const cached = indexed.overlapCache.get(cacheKey);
    if (cached) return cached;
    const first = requestedPath[0];
    const candidates =
      first === null
        ? indexed.writes
        : [
            ...(indexed.writesByFirstSegment.get(first) ?? []),
            ...indexed.wildcardWrites,
          ];
    const stats = analysisStats(context);
    const values = [];
    let opaque = false;
    for (const write of candidates) {
      if (stats) stats.staticContainerMemberWriteOverlapVisits += 1;
      const comparableLength = Math.min(
        requestedPath.length,
        write.path.length
      );
      let overlaps = true;
      for (let index = 0; index < comparableLength; index += 1) {
        if (
          requestedPath[index] !== null &&
          write.path[index] !== null &&
          requestedPath[index] !== write.path[index]
        ) {
          overlaps = false;
          break;
        }
      }
      if (!overlaps) continue;
      opaque = true;
      if (write.value && write.path.length === requestedPath.length) {
        values.push(write.value);
      }
    }
    const result = projection(values, opaque, values.length > 0);
    indexed.overlapCache.set(cacheKey, result);
    return result;
  };

  return (node, key) => {
    let current = unwrap(node);
    const sourcePath = [];
    while (current?.type === 'MemberExpression') {
      sourcePath.unshift(memberKey(current));
      current = unwrap(current.object);
    }
    if (current?.type !== 'Identifier') return projection([], false, false);
    const initial = resolveVariable(context, current);
    if (!initial) return projection([], false, false);

    const requestedPath = [...sourcePath, key];
    const pending = [initial];
    const seenVariables = new Set();
    const values = [];
    let opaque = false;
    while (pending.length > 0) {
      const variable = pending.pop();
      if (seenVariables.has(variable)) {
        opaque = true;
        continue;
      }
      seenVariables.add(variable);
      const indexed = indexBinding(variable);
      pending.push(...indexed.aliases);
      const overlap = overlappingWriteProjection(indexed, requestedPath);
      values.push(...overlap.values);
      opaque ||= overlap.opaque;
    }
    return projection(values, opaque, values.length > 0);
  };
}

/**
 * Memoize the complete whole-binding source projection for a container.
 *
 * `projectInitial` and `projectReference` return both the domain projection
 * and the static pattern projection for the same write. Keeping dedup state
 * for the whole build avoids rebuilding a Set from every accumulated prefix.
 */
function createStaticContainerSourceSummaryIndex({
  analysisStats,
  context,
  projectInitial,
  projectReference,
  projection,
}) {
  const cache = new WeakMap();

  return (variable) => {
    const cached = cache.get(variable);
    if (cached) {
      const stats = analysisStats(context);
      if (stats) stats.staticContainerSourceCacheHits += 1;
      return cached;
    }

    const stats = analysisStats(context);
    if (stats) stats.staticContainerSourceSummaryComputations += 1;
    const sources = [];
    const seenSources = new Set();
    let opaque = false;
    const append = ({ projected, staticProjected }) => {
      for (const source of [...staticProjected.values, ...projected.values]) {
        if (stats) stats.staticContainerSourceDedupVisits += 1;
        if (seenSources.has(source)) continue;
        seenSources.add(source);
        sources.push(source);
      }
      // The generic projection marks a clean named-container hop opaque
      // because the source node changed. A unique projected value is exact in
      // this domain; mutation and escape are indexed independently.
      opaque ||=
        staticProjected.values.length > 0
          ? staticProjected.opaque
          : projected.opaque && projected.values.length !== 1;
    };

    const initial = projectInitial(variable);
    if (initial) append(initial);
    for (const reference of variable.references) {
      if (stats) stats.staticContainerSourceReferenceVisits += 1;
      if (!reference.isWrite() || reference.init === true) continue;
      append(projectReference(reference));
    }

    const result = projection(sources, opaque, sources.length > 0);
    cache.set(variable, result);
    return result;
  };
}

module.exports = {
  createStaticContainerMemberWriteIndex,
  createStaticContainerSourceSummaryIndex,
};
