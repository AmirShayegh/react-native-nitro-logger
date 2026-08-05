'use strict';

const {
  defineEvents,
  int,
  namedString,
  oneOf,
} = require('../../lib/commonjs/analytics.js');

const artifact = defineEvents({
  unicode_probe: {
    bounded: int({
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
    }),
    named: namedString('sample-registry', 'registered'),
    value: oneOf('plain', '🚀', 'e\u0301', '\ufffd'),
  },
});

process.stdout.write(artifact.grammarJSON);
