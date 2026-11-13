'use strict';

function createReceiverBuiltinWriteTools(dependencies) {
  const {
    aliasTools,
    analysisStats,
    expandedObjectProperties,
    isNamespaceMethod,
    propertyKeyName,
    resolveReceiverObject,
    staticStringValue,
  } = dependencies;
  const { receiverGetterValues } = aliasTools;

  function descriptorProperty(object, name) {
    if (!object) return null;
    let selected = null;
    for (const property of object.properties) {
      if (property.type === 'SpreadElement' || property.computed) return null;
      if (propertyKeyName(property) === name) selected = property;
    }
    return selected;
  }

  function descriptorValues(context, descriptor, opaqueNode) {
    const object = resolveReceiverObject(context, descriptor);
    const value = descriptorProperty(object, 'value');
    if (value?.kind === 'init' && !value.method) return [value.value];
    const getter = descriptorProperty(object, 'get');
    return getter?.kind === 'init'
      ? receiverGetterValues(context, getter.value)
      : [opaqueNode];
  }

  function descriptorReceiverWrite(context, call, key, descriptor) {
    return {
      call,
      name: staticStringValue(context, key),
      values: descriptorValues(context, descriptor, call),
    };
  }

  function objectReceiverWrites(context, call, object, descriptors = false) {
    const source = resolveReceiverObject(context, object);
    if (!source) return [{ call, name: null, values: [call] }];
    const writes = [];
    for (const property of expandedObjectProperties(source, context)) {
      if (property.type === 'SpreadElement' || property.computed) {
        writes.push({ call, name: null, values: [call] });
        continue;
      }
      const name = propertyKeyName(property);
      if (name === null) {
        writes.push({ call, name: null, values: [call] });
        continue;
      }
      if (!descriptors) {
        writes.push({
          call,
          name,
          values: [
            property.kind === 'init' && !property.method
              ? property.value
              : call,
          ],
        });
        continue;
      }
      writes.push({
        call,
        name,
        values: descriptorValues(context, property.value, call),
      });
    }
    return writes;
  }

  function builtinReceiverPropertyWrites(context, expression) {
    const call = expression.parent;
    if (call?.type !== 'CallExpression') return [];
    if (
      isNamespaceMethod(context, call, 'Reflect', 'set') &&
      (call.arguments[0] === expression || call.arguments[3] === expression)
    ) {
      return [
        {
          call,
          name: staticStringValue(context, call.arguments[1]),
          values: [call.arguments[2] ?? call],
        },
      ];
    }
    if (call.arguments[0] !== expression) return [];
    if (
      isNamespaceMethod(context, call, 'Object', 'defineProperty') ||
      isNamespaceMethod(context, call, 'Reflect', 'defineProperty')
    ) {
      return [
        descriptorReceiverWrite(
          context,
          call,
          call.arguments[1],
          call.arguments[2]
        ),
      ];
    }
    if (isNamespaceMethod(context, call, 'Object', 'defineProperties')) {
      return objectReceiverWrites(context, call, call.arguments[1], true);
    }
    if (
      isNamespaceMethod(context, call, 'Object', 'setPrototypeOf') ||
      isNamespaceMethod(context, call, 'Reflect', 'setPrototypeOf')
    ) {
      return objectReceiverWrites(context, call, call.arguments[1]);
    }
    return [];
  }

  function objectAssignReceiverPropertyWrites(
    context,
    call,
    replacementPropertyValues
  ) {
    const writes = [];
    let opaque = false;
    for (const sourceNode of call.arguments.slice(1)) {
      const stats = analysisStats(context);
      if (stats) stats.objectAssignSourceIndexVisits += 1;
      const source = resolveReceiverObject(context, sourceNode);
      if (!source) {
        opaque = true;
        continue;
      }
      const expanded = expandedObjectProperties(source, context);
      if (
        expanded.some(
          (property) => property.type === 'SpreadElement' || property.computed
        )
      ) {
        opaque = true;
        continue;
      }
      const properties = new Map();
      for (const property of expanded) {
        const name = propertyKeyName(property);
        if (name !== null) properties.set(name, property);
      }
      for (const [name, property] of properties) {
        writes.push({
          baseValues:
            property.kind === 'get'
              ? receiverGetterValues(context, property.value)
              : [property.value],
          complexValues: replacementPropertyValues(context, sourceNode, name),
          name,
        });
      }
    }
    return { opaque, writes };
  }

  return Object.freeze({
    builtinReceiverPropertyWrites,
    objectAssignReceiverPropertyWrites,
  });
}

module.exports = { createReceiverBuiltinWriteTools };
