'use strict';

const {
  RECEIVER_OPTION_PROPERTIES,
  describeLogCall,
  describeScopedCall,
  describeSubsystemConfigCall,
  isOmitted,
  isStaticString,
  maybeLogger,
  subsystemArguments,
} = require('../shared');

/**
 * Subsystems are the filtering mechanism — they replace SwiftLogger's
 * file/function/line, which JS cannot capture. They belong to a small fixed
 * vocabulary the team chooses, so they must be literal.
 *
 * A computed subsystem is both a leak risk (it renders unredacted in every
 * line) and a functional bug: `Log.subsystem('network', 'debug')` can only
 * match names known at configuration time, so a dynamic name silently
 * misses every level override the app configured.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require subsystem names to be static strings from a fixed vocabulary',
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
      dynamic:
        'Subsystem names must be string literals or approved constants. A computed name renders unredacted and silently misses the level overrides configured for it.',
      unanalyzable:
        'This subsystem cannot be resolved to a literal name. Pass the name directly, or a `const` string this rule can follow.',
    },
  },

  create(context) {
    function check(node) {
      // `Log.scoped(id, undefined, md)` carries no subsystem at all, which is
      // what the runtime sees too.
      if (!node || isOmitted(context, node)) return;
      if (!isStaticString(context, node)) {
        context.report({ node, messageId: 'dynamic' });
      }
    }

    return {
      CallExpression(node) {
        const call = describeLogCall(context, node);
        if (call) {
          // A spread cannot shift the subsystem out of reach silently: the
          // Logger's level helpers take one, so the position exists.
          if (call.spreadArgs && maybeLogger(call.receiver)) {
            context.report({ node, messageId: 'unanalyzable' });
            return;
          }
          for (const result of subsystemArguments(context, call)) {
            if (result.kind === 'unanalyzable') {
              context.report({ node: result.node, messageId: 'unanalyzable' });
            } else {
              check(result.node);
            }
          }
          return;
        }

        // `Log.subsystem(name, level)` / `Log.resetSubsystem(name)`
        const config = describeSubsystemConfigCall(context, node);
        if (config) {
          if (config.spreadArgs) {
            context.report({ node, messageId: 'unanalyzable' });
          } else {
            check(config.args[0]);
          }
          return;
        }

        // `Log.scoped(correlation, subsystem, metadata)` — the subsystem
        // here renders on every message the scope emits.
        checkScopedSubsystem(node);
      },

      // `new ScopedLogger(logger, correlation, subsystem, …)` reaches the same
      // channel; `describeScopedCall` normalizes the positions so this is the
      // identical check.
      NewExpression: checkScopedSubsystem,
    };

    function checkScopedSubsystem(node) {
      const scoped = describeScopedCall(context, node);
      if (!scoped) return;
      if (scoped.spreadArgs) {
        context.report({ node, messageId: 'unanalyzable' });
      } else {
        check(scoped.args[1]);
      }
    }
  },
};
