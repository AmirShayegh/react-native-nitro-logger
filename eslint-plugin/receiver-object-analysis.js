'use strict';

/**
 * Build the receiver-object resolver used by event-call analysis.
 *
 * The resolver intentionally accepts its syntax and provenance helpers as a
 * narrow facade. That keeps the recursive Object.assign/descriptor logic out
 * of shared.js without making this module depend on shared.js and forming a
 * module cycle.
 */
function createReceiverObjectResolver({
  OPAQUE_GETTER_VALUE,
  analysisStats,
  bindingInit,
  contextWeakCache,
  identityWrappedValue,
  isBuiltinNamespaceUntampered,
  propertyKeyName,
  receiverGetterValues,
  resolveVariable,
  returnTargetWrapper,
  staticStringValue,
  unwrapFreeze,
}) {
  const receiverObjectVariableCache = new WeakMap();
  const receiverReturnTargetObjectCache = new WeakMap();
  const RECEIVER_OBJECT_IN_PROGRESS = Symbol('receiver-object-in-progress');

  function syntheticReceiverProperty(name, value, kind = 'init') {
    return {
      type: 'Property',
      computed: false,
      key: { type: 'Literal', value: name },
      kind,
      method: false,
      shorthand: false,
      value,
    };
  }

  function copiedReceiverProperty(context, property) {
    if (property.type !== 'Property' || property.computed) return null;
    const name = propertyKeyName(property);
    if (name === null) return null;
    if (property.kind === 'init') {
      return syntheticReceiverProperty(name, property.value);
    }
    if (property.kind === 'get') {
      // Object.assign invokes a source accessor and stores the value it
      // returns. Getter form is only an internal carrier for the possible
      // returns and opacity marker; it is never emitted as JavaScript.
      receiverGetterValues(context, property.value);
      return syntheticReceiverProperty(name, property.value, 'get');
    }
    if (property.kind === 'set') {
      return syntheticReceiverProperty(name, {
        type: 'Identifier',
        name: 'undefined',
      });
    }
    return null;
  }

  function receiverDescriptorProperty(context, descriptorNode, name, seen) {
    const descriptor = resolveReceiverObject(context, descriptorNode, seen);
    if (!descriptor) return { opaque: true, property: null };
    let selected = null;
    for (const property of descriptor.properties) {
      if (property.type === 'SpreadElement' || property.computed) {
        return { opaque: true, property: null };
      }
      if (propertyKeyName(property) !== name) continue;
      if (property.kind !== 'init' || (property.method && name !== 'get')) {
        return { opaque: true, property: null };
      }
      selected = property;
    }
    return { opaque: false, property: selected };
  }

  function receiverDefinedProperty(context, name, descriptorNode, seen) {
    const value = receiverDescriptorProperty(
      context,
      descriptorNode,
      'value',
      new Set(seen)
    );
    const getter = receiverDescriptorProperty(
      context,
      descriptorNode,
      'get',
      new Set(seen)
    );
    if (
      value.opaque ||
      getter.opaque ||
      (!!value.property && !!getter.property)
    ) {
      return syntheticReceiverProperty(name, OPAQUE_GETTER_VALUE);
    }
    if (value.property) {
      return syntheticReceiverProperty(name, value.property.value);
    }
    if (getter.property) {
      return syntheticReceiverProperty(name, getter.property.value, 'get');
    }
    return syntheticReceiverProperty(name, {
      type: 'Identifier',
      name: 'undefined',
    });
  }

  function returnTargetReceiverObject(context, returned, seen) {
    const cache = contextWeakCache(receiverReturnTargetObjectCache, context);
    const cached = cache.get(returned.call);
    if (cached !== undefined) {
      return cached === RECEIVER_OBJECT_IN_PROGRESS ? null : cached;
    }
    cache.set(returned.call, RECEIVER_OBJECT_IN_PROGRESS);

    const target = resolveReceiverObject(
      context,
      returned.arguments[0],
      new Set(seen)
    );
    let result = null;
    if (target && returned.method === 'assign') {
      const properties = [...target.properties];
      let exact = true;
      for (const sourceNode of returned.arguments.slice(1)) {
        const source = resolveReceiverObject(
          context,
          sourceNode,
          new Set(seen)
        );
        if (!source) {
          exact = false;
          break;
        }
        for (const property of source.properties) {
          const copied = copiedReceiverProperty(context, property);
          if (!copied) {
            exact = false;
            break;
          }
          properties.push(copied);
        }
        if (!exact) break;
      }
      if (exact) result = { type: 'ObjectExpression', properties };
    } else if (target && returned.method === 'defineProperty') {
      const name = staticStringValue(context, returned.arguments[1]);
      const property =
        name === null
          ? null
          : receiverDefinedProperty(context, name, returned.arguments[2], seen);
      if (property) {
        result = {
          type: 'ObjectExpression',
          properties: [...target.properties, property],
        };
      }
    } else if (target && returned.method === 'defineProperties') {
      const descriptors = resolveReceiverObject(
        context,
        returned.arguments[1],
        new Set(seen)
      );
      if (descriptors) {
        const properties = [...target.properties];
        let exact = true;
        for (const descriptor of descriptors.properties) {
          const name =
            descriptor.type === 'Property' &&
            !descriptor.computed &&
            descriptor.kind === 'init' &&
            !descriptor.method
              ? propertyKeyName(descriptor)
              : null;
          const property =
            name === null
              ? null
              : receiverDefinedProperty(context, name, descriptor.value, seen);
          if (!property) {
            exact = false;
            break;
          }
          properties.push(property);
        }
        if (exact) result = { type: 'ObjectExpression', properties };
      }
    } else if (target && returned.method === 'setPrototypeOf') {
      const prototype = resolveReceiverObject(
        context,
        returned.arguments[1],
        new Set(seen)
      );
      if (prototype) {
        result = {
          type: 'ObjectExpression',
          properties: [...prototype.properties, ...target.properties],
        };
      }
    }

    cache.set(returned.call, result);
    return result;
  }

  function resolveReceiverObject(context, node, seen = new Set()) {
    const cache = contextWeakCache(receiverObjectVariableCache, context);
    const path = [];
    const finish = (result) => {
      for (const variable of path) cache.set(variable, result);
      return result;
    };
    let source = node;
    for (;;) {
      const current = unwrapFreeze(context, source);
      if (!current) return finish(null);
      const returned = returnTargetWrapper(context, current);
      if (returned) {
        if (
          returned.opaque ||
          !isBuiltinNamespaceUntampered(context, 'Object')
        ) {
          return finish(null);
        }
        return finish(returnTargetReceiverObject(context, returned, seen));
      }
      const identity = identityWrappedValue(context, current);
      if (identity) {
        source = identity;
        continue;
      }
      if (current.type === 'ObjectExpression') return finish(current);
      if (current.type !== 'Identifier') return finish(null);

      const variable = resolveVariable(context, current);
      if (!variable || seen.has(variable)) return finish(null);
      const cached = cache.get(variable);
      if (cached !== undefined) {
        return finish(cached === RECEIVER_OBJECT_IN_PROGRESS ? null : cached);
      }
      const stats = analysisStats(context);
      if (stats) stats.receiverObjectResolutionComputations += 1;
      cache.set(variable, RECEIVER_OBJECT_IN_PROGRESS);
      seen.add(variable);
      path.push(variable);
      source = bindingInit(variable);
    }
  }

  return Object.freeze({ resolveReceiverObject });
}

module.exports = { createReceiverObjectResolver };
