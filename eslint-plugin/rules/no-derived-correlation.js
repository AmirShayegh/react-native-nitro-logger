'use strict';

const {
  OPTIONS_METHODS,
  RECEIVER_OPTION_PROPERTIES,
  correlationArguments,
  describeLogCall,
  describeScopedCall,
  isOmitted,
  isTrustedLogger,
  resolveVariable,
  singleDef,
  staticPropertyName,
  unwrap,
} = require('../shared');

/**
 * Correlation IDs are public by contract — they appear in every line of a
 * scope — so they must be opaque and freshly random.
 *
 * The tempting shortcut is to reuse an identifier you already have: a
 * patient ID, an MRN, a booking reference. That turns every log line in the
 * scope into a re-identification key, and hashing does not fix it — a hash
 * of a small identifier space is trivially reversible. This rule requires
 * the ID to come from the logger's own `newCorrelationId()`.
 *
 * Provenance is checked, not spelling. A local
 * `function newCorrelationId() { return patient.mrn }` produces exactly the
 * leak the rule exists to prevent, so the generator has to be traceable to an
 * import of the package that actually ships it.
 */

/**
 * Is this a call to the logger's `newCorrelationId`, and only that?
 *
 * Provenance must be exact here, not merely plausible. Everywhere else an
 * ambiguous receiver widens what gets *checked*, which is safe; here it would
 * widen what gets *trusted*, so `function f(logger) { Log.scoped(
 * logger.newCorrelationId()) }` would launder any object's method into an
 * approved ID generator. Only a receiver proven to be the Logger counts.
 */
function isCorrelationIdCall(context, node) {
  const call = unwrap(node);
  if (!call || call.type !== 'CallExpression') return false;
  const callee = unwrap(call.callee);
  if (!callee) return false;

  // `Log.newCorrelationId()` — receiver must BE the Logger, not resemble it.
  if (callee.type === 'MemberExpression') {
    return (
      staticPropertyName(context, callee) === 'newCorrelationId' &&
      isTrustedLogger(context, callee.object)
    );
  }

  if (callee.type !== 'Identifier' || callee.name !== 'newCorrelationId') {
    return false;
  }

  // A bare call is trustworthy only when destructured off the Logger. The
  // package exposes no standalone `newCorrelationId`, so accepting an import
  // of that name would trust `import { newCorrelationId } from
  // './phi-helpers'` — a function that can return anything at all.
  const def = singleDef(resolveVariable(context, callee));
  if (!def || def.type !== 'Variable') return false;
  if (def.node.id.type !== 'ObjectPattern') return false;
  // Which property it was destructured FROM is the whole point:
  // `const { patientId: newCorrelationId } = Log` renames PHI into the
  // approved spelling.
  const property = def.node.id.properties.find((p) => {
    if (p.type !== 'Property') return false;
    const target =
      p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
    return target === def.name;
  });
  if (
    !property ||
    property.computed ||
    property.key.type !== 'Identifier' ||
    property.key.name !== 'newCorrelationId'
  ) {
    return false;
  }
  return isTrustedLogger(context, def.node.init);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require correlation IDs to come from newCorrelationId() rather than existing identifiers',
    },
    schema: [
      {
        type: 'object',
        properties: {
          ...RECEIVER_OPTION_PROPERTIES,
        },
        additionalProperties: false,
      },
    ],
    messages: {
      derived:
        'Correlation IDs must come from newCorrelationId(). Deriving one from a record, patient, or session identifier makes every line in the scope a re-identification key — and hashing a small identifier space does not anonymize it.',
      unanalyzable:
        'This correlation ID cannot be traced to newCorrelationId(). Pass the call directly, or a `const` initialized from it.',
    },
  },

  create(context) {
    function check(node) {
      if (!node) return;
      // `Log.scoped(undefined)` auto-generates, exactly like `Log.scoped()`.
      if (isOmitted(context, node)) return;
      if (isCorrelationIdCall(context, node)) return;

      // Follow a single-definition const to its initializer, so the common
      // `const id = Log.newCorrelationId()` stays legal.
      const current = unwrap(node);
      if (current && current.type === 'Identifier') {
        const variable = resolveVariable(context, current);
        const def = singleDef(variable);
        if (
          def &&
          def.type === 'Variable' &&
          def.parent?.kind === 'const' &&
          isCorrelationIdCall(context, def.node.init)
        ) {
          return;
        }
      }

      context.report({ node, messageId: 'derived' });
    }

    // `new ScopedLogger(logger, correlation, …)` puts a correlation ID in the
    // same channel `Log.scoped()` does. `describeScopedCall` normalizes the
    // argument positions, so the check below is the same one.
    function checkScopedConstruction(node) {
      const scoped = describeScopedCall(context, node);
      if (!scoped) return;
      if (scoped.spreadArgs) {
        context.report({ node, messageId: 'unanalyzable' });
        return;
      }
      if (scoped.args.length > 0) check(scoped.args[0]);
    }

    return {
      NewExpression: checkScopedConstruction,

      CallExpression(node) {
        const scoped = describeScopedCall(context, node);
        if (scoped) {
          if (scoped.spreadArgs) {
            // `Log.scoped(...args)` — the correlation position is unknowable,
            // and whatever lands there tags every line of the scope.
            context.report({ node, messageId: 'unanalyzable' });
            return;
          }
          // `scoped()` with no argument auto-generates — that is the
          // encouraged form and needs no check.
          if (scoped.args.length > 0) check(scoped.args[0]);
          return;
        }

        const call = describeLogCall(context, node);
        if (!call) return;
        if (
          call.spreadArgs &&
          (OPTIONS_METHODS.has(call.method) || call.opaqueMethod)
        ) {
          // `Log.log(...['m', { correlation: patientId }])` — the options
          // object, and the correlation inside it, are out of reach.
          //
          // The set, not a literal `'log'`. `logMessage` takes the same
          // options object and was spelled out of this check, so
          // `Log.logMessage(...args)` reported nothing at all: the one method
          // whose second argument is *always* the options shape was the one
          // the guard did not cover.
          context.report({ node, messageId: 'unanalyzable' });
          return;
        }
        for (const result of correlationArguments(context, call)) {
          if (result.kind === 'unanalyzable') {
            context.report({ node: result.node, messageId: 'unanalyzable' });
          } else {
            check(result.node);
          }
        }
      },
    };
  },
};
