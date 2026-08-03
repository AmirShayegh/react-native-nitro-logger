'use strict';

const {
  createStaticContainerExpressionTools,
} = require('./static-container-expression-analysis');
const {
  createStaticContainerKeyTools,
} = require('./static-container-key-analysis');
const {
  createStaticContainerMemberProjectionTools,
} = require('./static-container-member-analysis');
const {
  createStaticContainerPatternTools,
} = require('./static-container-pattern-analysis');
function createStaticContainerProjectionUnit({
  builtinNamespaceOf,
  context,
  expandedArrayElements,
  immutableInit,
  isWriteTarget,
  projectPatternBinding,
  projectReferenceWrite,
  propertyKeyName,
  receiverAnalysisStats,
  resolveVariable,
  singleDef,
  unwrap,
}) {
  const {
    staticCallKey,
    staticContainerKey,
    staticContainerMemberKey,
    staticMemberKey,
  } = createStaticContainerKeyTools({
    context,
    immutableInit,
    resolveVariable,
    unwrap,
  });

  /*
   * Project values out of statically visible object/array containers without
   * consulting receiver analysis. This deliberately lives inside the
   * poisoned-global walk: calling `isNamespaceMethod` (or anything that calls
   * it) from here would re-enter `poisonedGlobals` before its cache exists.
   *
   * `opaque` is kept separate from `values`. An uncertain container that has
   * no evidence of a builtin remains ordinary, while uncertainty alongside a
   * real builtin candidate is widened by the method/namespace consumers below.
   */
  const staticContainerProjection = (
    values = [],
    opaque = false,
    present = values.length > 0,
    namespaceOpaque = false
  ) => ({ namespaceOpaque, opaque, present, values });

  // Expression, member/accessor, and pattern projection are mutually
  // recursive at runtime. Publish each focused unit through this explicit
  // state object only after its factory has completed.
  const state = { member: null, pattern: null };
  const { staticContainerExpressionValues, staticContainerMemberWriteValues } =
    createStaticContainerExpressionTools({
      context,
      isWriteTarget,
      projectPatternBinding,
      projectReferenceWrite,
      receiverAnalysisStats,
      resolveVariable,
      singleDef,
      state,
      staticContainerMemberKey,
      staticContainerProjection,
      unwrap,
    });

  const member = createStaticContainerMemberProjectionTools({
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
  });
  const { staticContainerKeyValues, staticContainerMemberValues } = member;
  state.member = member;

  const pattern = createStaticContainerPatternTools({
    context,
    expandedArrayElements,
    propertyKeyName,
    staticContainerExpressionValues,
    staticContainerKey,
    staticContainerKeyValues,
    staticContainerProjection,
  });
  const {
    referenceStaticContainerPatternValues,
    staticContainerPatternValues,
  } = pattern;
  state.pattern = pattern;

  return Object.freeze({
    referenceStaticContainerPatternValues,
    staticCallKey,
    staticContainerKeyValues,
    staticContainerMemberValues,
    staticContainerPatternValues,
    staticMemberKey,
  });
}

module.exports = { createStaticContainerProjectionUnit };
