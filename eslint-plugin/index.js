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

const RECOMMENDED_RULES = {
  'nitro-logger/no-dynamic-message': 'error',
  'nitro-logger/no-computed-metadata-key': 'error',
};

const STRICT_RULES = {
  ...RECOMMENDED_RULES,
  'nitro-logger/no-derived-correlation': 'error',
  'nitro-logger/literal-subsystem': 'error',
};

const PARSER = '@typescript-eslint/parser';

/**
 * The parser versions CI exercises — NOT a requirement imposed on consumers.
 *
 * The manifest declares this peer as `*`, deliberately. These configs ask
 * nothing of the parser beyond the interface ESLint itself calls; the parser
 * is handed straight to ESLint and never introspected. The parser's own peer
 * range is what governs which TypeScript it works with, and it already states
 * that itself.
 *
 * Declaring a narrower range here would be an active hazard rather than
 * documentation. `peerDependenciesMeta.optional` means the package may be
 * ABSENT — it does not mean the range goes unchecked when it is present, so a
 * floor turns into an `ERESOLVE` install failure for a consumer whose parser
 * already works. A `>=8.60.0` floor would reject parser 8.20 paired with
 * TypeScript 5.7, which lints this package's rules perfectly well, over a
 * version preference the code cannot justify. A floor also needs raising for
 * every future parser major, and forgetting is a broken install rather than a
 * missed improvement.
 *
 * The realistic floor is set by ESLint, not by us: these configs already
 * require `eslint >=9`, and parser 7.x declares `eslint ^8.56.0`, so it cannot
 * appear in a tree that satisfies this package at all. That is worth stating
 * because `@react-native/eslint-config@0.78` pins parser `^7.1.1` — an RN app
 * on that config is on ESLint 8 and reaches none of this until it upgrades
 * both.
 *
 * What CI proves is that both ends of the range below work end to end, each
 * against a TypeScript its parser accepts — `scripts/check-eslint-consumer.sh`
 * derives its cases from this string. The pairing matters: parser 8.0.0
 * declares no TypeScript peer at all, and left to resolve TypeScript 6 on its
 * own it dies with `Cannot read properties of undefined (reading
 * 'BarBarToken')`, reading an internal that moved.
 */
const VERIFIED_PARSER_RANGE = '>=8.0.0 <9.0.0';

/**
 * The TypeScript parser, resolved on use rather than on import.
 *
 * A JavaScript-only consumer never installs this parser, and requiring it at
 * module scope would make `import nitroLogger from '.../eslint-plugin'` throw
 * for them — turning an optional peer into a hard one. Resolving inside the
 * accessor means the cost lands only on the config that needs it.
 *
 * Only a failure to find the parser ITSELF is translated. A parser that is
 * installed but whose own dependency tree is broken must surface its real
 * error: reporting that as "not installed" would send someone to reinstall a
 * package that is already there.
 */
function loadParser() {
  try {
    return require(PARSER);
  } catch (error) {
    const missingParser =
      error.code === 'MODULE_NOT_FOUND' &&
      typeof error.message === 'string' &&
      error.message.includes(`'${PARSER}'`);

    if (!missingParser) throw error;

    throw new Error(
      `react-native-nitro-logger/eslint-plugin: the TypeScript configs need ` +
        `${PARSER}, which is not installed.\n` +
        `  npm install --save-dev ${PARSER}\n` +
        `This package constrains no version; pick one compatible with your ` +
        `ESLint and TypeScript, which the parser's own peer range states.\n` +
        `Or use \`configs.strict\` / \`configs.recommended\`, which lint ` +
        `JavaScript only and need no parser.`
    );
  }
}

/**
 * A TypeScript-capable variant of `rules`.
 *
 * This exists because the JavaScript-only configs below silently lint nothing
 * in a React Native app. A flat config with no `files` key applies only to
 * ESLint's default set — `**\/*.js`, `.mjs`, `.cjs` — so `.ts` and `.tsx` are
 * never pulled in, and `eslint .` reports "File ignored because no matching
 * configuration was supplied" and exits 0. Every rule here guards a field the
 * runtime cannot redact, so an inert config is worse than an absent one: the
 * README told you that you were covered.
 *
 * The file set covers JavaScript too, so a TypeScript app needs ONE entry
 * rather than two. Consumers pick one config, not both.
 *
 * The parser sits behind a getter on this object, which must never be spread —
 * `{ ...config.languageOptions }` evaluates it and moves the failure back to
 * import time, which is exactly what the laziness is for.
 */
function typescriptVariant(rules) {
  return {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    plugins: { 'nitro-logger': plugin },
    languageOptions: {
      get parser() {
        return loadParser();
      },
    },
    rules,
  };
}

plugin.configs = {
  // JavaScript only. See `typescriptVariant` for why that has to be said out
  // loud rather than assumed.
  recommended: {
    plugins: { 'nitro-logger': plugin },
    rules: RECOMMENDED_RULES,
  },
  strict: {
    plugins: { 'nitro-logger': plugin },
    rules: STRICT_RULES,
  },

  recommendedTypeScript: typescriptVariant(RECOMMENDED_RULES),
  strictTypeScript: typescriptVariant(STRICT_RULES),
};

module.exports = plugin;
module.exports.VERIFIED_PARSER_RANGE = VERIFIED_PARSER_RANGE;
