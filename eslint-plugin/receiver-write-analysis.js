'use strict';

const {
  createReceiverBindingReplacementTools,
} = require('./receiver-binding-replacement-analysis');
const {
  createReceiverBuiltinWriteTools,
} = require('./receiver-builtin-write-analysis');
const {
  createReceiverWriteIndexTools,
} = require('./receiver-write-index-analysis');
const {
  createReceiverWriteTemporalQueries,
} = require('./receiver-write-temporal-queries');

function createReceiverWriteTools(dependencies) {
  const builtinTools = createReceiverBuiltinWriteTools(dependencies);
  let bindingTools;
  const indexTools = createReceiverWriteIndexTools({
    ...dependencies,
    bindingReplacementReferences(context, variable) {
      return bindingTools.bindingReplacementReferences(context, variable);
    },
    builtinTools,
  });
  bindingTools = createReceiverBindingReplacementTools({
    ...dependencies,
    indexTools,
  });
  return createReceiverWriteTemporalQueries({
    ...dependencies,
    bindingTools,
    indexTools,
  });
}

module.exports = { createReceiverWriteTools };
