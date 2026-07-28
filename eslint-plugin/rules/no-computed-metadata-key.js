'use strict';

const {
  describeLogCall,
  describeScopedCall,
  isOmitted,
  metadataArguments,
  resolveObjectLiteral,
} = require('../shared');

/**
 * The runtime's own key contract, mirrored so a catalog that lint accepts is
 * one the runtime can actually enforce. Kept in sync with
 * `METADATA_KEY_PATTERN_SOURCE`, `MAX_CATALOG_SIZE` and `DROPPED_COUNT_KEY`
 * in `src/privacy.ts` by a test that imports both.
 */
const METADATA_KEY_PATTERN_SOURCE = '^[A-Za-z0-9._-]{1,64}$';
const MAX_CATALOG_SIZE = 4096;
const DROPPED_COUNT_KEY = 'droppedMetadataCount';

/**
 * Metadata keys are structure, not data.
 *
 * The runtime drops keys that fail the shape regex or the approved-key
 * catalog, but it can only do that for keys it can see. A computed key
 * (`{ [patientId]: … }`) or a spread (`{ ...record }`) hides the key set
 * from review entirely. Worse, `patientId` is very often a value like
 * `patient123`, which satisfies the runtime's shape regex — so in the OSS
 * profile, where no catalog is configured, that key reaches the destination
 * intact. Lint is the only control on that path.
 *
 * Because of that, an *unresolvable* metadata expression matters as much as
 * a visibly computed one: `const md = { [patientId]: v }; Log.info('m', md)`
 * and `Log.info('m', buildMetadata(patient))` leak identically. Aliases are
 * followed to their object literal, and when that fails the expression is
 * reported.
 *
 * That is on by default. An opaque metadata object is precisely the case the
 * rule cannot see through, so exempting it would leave the rule enforcing
 * only the mistakes people do not make. `allowOpaqueMetadata` turns it off
 * for projects with nothing sensitive to protect, and the option is named to
 * say what it costs.
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require metadata keys to be literal, and optionally drawn from the approved catalog',
    },
    schema: [
      {
        type: 'object',
        properties: {
          loggerNames: { type: 'array', items: { type: 'string' } },
          loggerModules: { type: 'array', items: { type: 'string' } },
          singletonName: { type: 'string' },
          // The catalog mirrors the runtime's contract exactly. A key the
          // runtime would reject is worse than useless in lint: it approves
          // at build time something that is silently dropped in production.
          catalog: {
            type: 'array',
            items: {
              type: 'string',
              pattern: METADATA_KEY_PATTERN_SOURCE,
              not: { const: DROPPED_COUNT_KEY },
            },
            maxItems: MAX_CATALOG_SIZE,
            uniqueItems: true,
          },
          allowOpaqueMetadata: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      computed:
        'Metadata keys must be literal. A computed key hides the key set from review and is dropped at runtime — put the varying part in the value, wrapped in pub() or priv().',
      spread:
        'Spreading an object into metadata hides its keys. List the keys you intend to log explicitly.',
      unapproved:
        'Metadata key "{{key}}" is not in the approved catalog, so the runtime will drop it. Add it to the catalog or use an approved key.',
      unanalyzable:
        'Metadata must be an object literal at the call site so its keys can be reviewed. This expression hides them — inline the keys, or build the object as a `const` this rule can follow.',
    },
  },

  create(context) {
    const options = context.options?.[0] ?? {};
    const catalog = Array.isArray(options.catalog)
      ? new Set(options.catalog)
      : null;
    // A catalog is a promise that every key was reviewed, so it overrides an
    // explicit opt-out rather than coexisting with it.
    const requireLiteral =
      catalog !== null || options.allowOpaqueMetadata !== true;

    function reportOpaque(node) {
      if (requireLiteral && node) {
        context.report({ node, messageId: 'unanalyzable' });
      }
    }

    function checkMetadataExpression(node) {
      if (!node) return;
      const object = resolveObjectLiteral(context, node);
      if (!object) {
        reportOpaque(node);
        return;
      }

      for (const property of object.properties) {
        if (property.type === 'SpreadElement') {
          context.report({ node: property, messageId: 'spread' });
          continue;
        }
        if (property.computed) {
          context.report({ node: property.key, messageId: 'computed' });
          continue;
        }
        if (!catalog) continue;
        // A numeric key is a string key at runtime: `{ 42: v }` reaches the
        // logger as "42", which the shape regex accepts.
        const key =
          property.key.type === 'Identifier'
            ? property.key.name
            : property.key.type === 'Literal'
              ? String(property.key.value)
              : null;
        if (key !== null && !catalog.has(key)) {
          context.report({
            node: property.key,
            messageId: 'unapproved',
            data: { key },
          });
        }
      }
    }

    return {
      CallExpression(node) {
        const call = describeLogCall(context, node);
        if (call) {
          if (call.spreadArgs) {
            // `Log.info(...args)` — the metadata position is unknowable.
            reportOpaque(node);
            return;
          }
          for (const result of metadataArguments(context, call)) {
            if (result.kind === 'unanalyzable') reportOpaque(result.node);
            else checkMetadataExpression(result.node);
          }
          return;
        }

        // `Log.scoped(correlation, subsystem, metadata)` carries metadata
        // for every message the scope emits, so it gets the same treatment.
        const scoped = describeScopedCall(context, node);
        if (!scoped) return;
        if (scoped.spreadArgs) {
          // `Log.scoped(...args)` — the metadata position is unknowable, and
          // a scope's metadata rides every message it emits.
          reportOpaque(node);
          return;
        }
        // `Log.scoped(id, 'sub', undefined)` states there is no metadata,
        // which is what the runtime sees too.
        if (!isOmitted(context, scoped.args[2])) {
          checkMetadataExpression(scoped.args[2]);
        }
      },
    };
  },
};
