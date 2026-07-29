'use strict';

const {
  RECEIVER_OPTION_PROPERTIES,
  describeLogCall,
  isStaticMessage,
} = require('../shared');

/**
 * The message is public by contract: the runtime cannot redact it, because
 * it cannot tell a template's constant parts from its interpolated ones. So
 * it has to be static at build time.
 *
 * `Log.info(\`patient ${id} admitted\`)` is the single most likely way PHI
 * reaches a log file, and no amount of runtime validation catches it — by
 * the time the logger sees the string, the interpolation already happened.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require log messages to be static strings, so interpolated data cannot reach a log line',
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
        'Log messages must be a string literal or an approved constant. Interpolated or computed text cannot be redacted at runtime — put the varying part in metadata, where the privacy layer can see it.',
      unanalyzable:
        'This call passes its arguments indirectly — a spread, an .apply(), or a partially applied .bind() — so the message position cannot be checked. Call the logging method directly.',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const call = describeLogCall(context, node);
        if (!call) return;

        if (call.spreadArgs) {
          context.report({ node, messageId: 'unanalyzable' });
          return;
        }
        // A call with no arguments is someone else's error to report.
        if (call.args.length === 0) return;

        const message = call.args[0];
        if (!isStaticMessage(context, message)) {
          context.report({ node: message, messageId: 'dynamic' });
        }
      },
    };
  },
};
