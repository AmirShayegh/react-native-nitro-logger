'use strict';

/**
 * Build an iterative SCC/condensation plan for a dependency graph.
 *
 * Domains own graph discovery, lattice joins, cache policy and publication.
 * This module owns only graph mechanics: iterative Kosaraju traversal, reverse
 * edges, condensation dependencies and a dependency-first topological order.
 */
function planStrongComponents(
  records,
  dependenciesOf = (record) => record.dependencies
) {
  const nodes = [...records.keys()];
  const nodeSet = new Set(nodes);
  const dependenciesByNode = new Map();
  for (const node of nodes) {
    dependenciesByNode.set(
      node,
      [...new Set(dependenciesOf(records.get(node)))].filter((dependency) =>
        nodeSet.has(dependency)
      )
    );
  }

  const finished = [];
  const visited = new Set();
  for (const root of nodes) {
    if (visited.has(root)) continue;
    visited.add(root);
    const stack = [{ at: 0, node: root }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const dependencies = dependenciesByNode.get(frame.node);
      if (frame.at < dependencies.length) {
        const dependency = dependencies[frame.at++];
        if (visited.has(dependency)) continue;
        visited.add(dependency);
        stack.push({ at: 0, node: dependency });
        continue;
      }
      finished.push(frame.node);
      stack.pop();
    }
  }

  const reverse = new Map(nodes.map((node) => [node, []]));
  for (const [node, dependencies] of dependenciesByNode) {
    for (const dependency of dependencies) reverse.get(dependency).push(node);
  }

  const components = [];
  const componentOf = new Map();
  for (let index = finished.length - 1; index >= 0; index -= 1) {
    const root = finished[index];
    if (componentOf.has(root)) continue;
    const componentIndex = components.length;
    const component = [];
    const stack = [root];
    componentOf.set(root, componentIndex);
    while (stack.length > 0) {
      const node = stack.pop();
      component.push(node);
      for (const owner of reverse.get(node)) {
        if (componentOf.has(owner)) continue;
        componentOf.set(owner, componentIndex);
        stack.push(owner);
      }
    }
    components.push(component);
  }

  const dependencies = components.map(() => new Set());
  const cyclic = components.map((component) => component.length > 1);
  for (const [node, nodeDependencies] of dependenciesByNode) {
    const owner = componentOf.get(node);
    for (const dependency of nodeDependencies) {
      const target = componentOf.get(dependency);
      if (target === owner) {
        if (dependency === node) cyclic[owner] = true;
        continue;
      }
      dependencies[owner].add(target);
    }
  }

  const order = [];
  const visitedComponents = new Set();
  for (let root = 0; root < components.length; root += 1) {
    if (visitedComponents.has(root)) continue;
    visitedComponents.add(root);
    const stack = [{ at: 0, component: root, values: [...dependencies[root]] }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.at < frame.values.length) {
        const target = frame.values[frame.at++];
        if (visitedComponents.has(target)) continue;
        visitedComponents.add(target);
        stack.push({
          at: 0,
          component: target,
          values: [...dependencies[target]],
        });
        continue;
      }
      order.push(frame.component);
      stack.pop();
    }
  }

  return Object.freeze({
    componentOf,
    components: Object.freeze(
      components.map((component) => Object.freeze(component))
    ),
    cyclic: Object.freeze(cyclic),
    order: Object.freeze(order),
    reverse,
  });
}

module.exports = { planStrongComponents };
