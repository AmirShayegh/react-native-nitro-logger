'use strict';

const noDynamicMessage = require('./rules/no-dynamic-message');
const noComputedMetadataKey = require('./rules/no-computed-metadata-key');
const noDerivedCorrelation = require('./rules/no-derived-correlation');
const literalSubsystem = require('./rules/literal-subsystem');

/**
 * Build-time half of the privacy contract.
 *
 * The runtime redacts metadata *values*. It cannot redact the fields around
 * them: by the time a message string, subsystem, correlation ID, or metadata
 * key reaches the logger, any interpolation already happened and the
 * original data is gone. Those fields are public by contract, and these
 * rules are what makes the contract true.
 *
 * Two configs:
 * - `recommended` — the OSS profile. Catches the leaks that are almost
 *   always mistakes: interpolated messages, and metadata whose key set
 *   cannot be read at the call site.
 * - `strict` — the profile for apps under a `privacyDefault('private')`
 *   regime (PHI, PII). Adds correlation-ID provenance and literal
 *   subsystems, and accepts a `catalog` so lint enforces the same approved
 *   key list the runtime does.
 *
 * Both fail closed on metadata: an object the rules cannot open is reported,
 * because that is exactly the case where they cannot tell a reviewed key
 * from a patient identifier. Projects with nothing sensitive to protect can
 * set `allowOpaqueMetadata` on `no-computed-metadata-key`.
 */
const plugin = {
  meta: {
    name: 'react-native-nitro-logger',
  },
  rules: {
    'no-dynamic-message': noDynamicMessage,
    'no-computed-metadata-key': noComputedMetadataKey,
    'no-derived-correlation': noDerivedCorrelation,
    'literal-subsystem': literalSubsystem,
  },
};

plugin.configs = {
  recommended: {
    plugins: { 'nitro-logger': plugin },
    rules: {
      'nitro-logger/no-dynamic-message': 'error',
      'nitro-logger/no-computed-metadata-key': 'error',
    },
  },
  strict: {
    plugins: { 'nitro-logger': plugin },
    rules: {
      'nitro-logger/no-dynamic-message': 'error',
      'nitro-logger/no-computed-metadata-key': 'error',
      'nitro-logger/no-derived-correlation': 'error',
      'nitro-logger/literal-subsystem': 'error',
    },
  },
};

module.exports = plugin;
