'use strict';

const {
  createBuiltinPoisonScanUnit,
  createPoisonNamespaceUnit,
  scanBuiltinPoisoning,
} = require('./builtin-poison-analysis');
const {
  createBuiltinBindingMethodForwarderUnit,
} = require('./builtin-forwarder-analysis');

/** Compose the focused poison, method, forwarder, and cache analyses. */
function createBuiltinCallableProvenanceTools(dependencies) {
  const { createStaticContainerAndNamespaceUnit } = dependencies;

  function createBuiltinCallableProvenance(context) {
    const staticContainer = createStaticContainerAndNamespaceUnit(context);
    const poison = createPoisonNamespaceUnit(dependencies, {
      context,
      possibleBuiltinNamespaceValues:
        staticContainer.possibleBuiltinNamespaceValues,
    });
    const callable = createBuiltinBindingMethodForwarderUnit(dependencies, {
      context,
      namespacePatternMethods: staticContainer.namespacePatternMethods,
      poisoned: poison.poisoned,
      possibleBuiltinNamespaceValues:
        staticContainer.possibleBuiltinNamespaceValues,
      referenceNamespacePatternMethods:
        staticContainer.referenceNamespacePatternMethods,
      referenceStaticContainerPatternValues:
        staticContainer.referenceStaticContainerPatternValues,
      staticContainerMemberValues: staticContainer.staticContainerMemberValues,
      staticContainerPatternValues:
        staticContainer.staticContainerPatternValues,
      staticMemberKey: staticContainer.staticMemberKey,
    });
    const poisonScan = createBuiltinPoisonScanUnit(dependencies, {
      context,
      dynamicCodeCall: callable.dynamicCodeCall,
      poisonNamespaceOf: poison.poisonNamespaceOf,
      poisoned: poison.poisoned,
      possibleBuiltinNamespaceValues:
        staticContainer.possibleBuiltinNamespaceValues,
      reflectiveCall: callable.reflectiveCall,
      staticCallKey: staticContainer.staticCallKey,
      staticMemberKey: staticContainer.staticMemberKey,
    });

    return Object.freeze({
      poisonScan,
      publishAfterPoisonScan() {
        callable.resetPoisonSensitiveCaches();
        return Object.freeze({
          indirectBindResult: callable.indirectBindResult,
          poisoned: poison.poisoned,
          reflectiveCall: callable.reflectiveCall,
          resolveReturnTargetCall: (call) =>
            callable.resolveReturnTargetCall(call, true),
        });
      },
    });
  }

  return Object.freeze({
    createBuiltinCallableProvenance,
    scanBuiltinPoisoning,
  });
}

module.exports = { createBuiltinCallableProvenanceTools };
