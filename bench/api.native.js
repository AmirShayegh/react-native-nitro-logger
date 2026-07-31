/**
 * The library surface the bench cases run against — Hermes flavour.
 *
 * Metro prefers `.native.js` over `.js`, which is the entire trick: the same
 * `require('../api')` in a case file resolves to `lib/commonjs` under Node
 * and to the workspace source here (via the `react-native-nitro-logger-source`
 * condition the example's Metro config sets). The engines differ; the cases
 * must not.
 *
 * Every name `api.js` assembles is a ROOT export of the package —
 * `Batcher` and `utf8Length` included (`src/index.tsx`). `api.js` avoids
 * the barrel only because Node cannot parse the react-native Flow source
 * the barrel's Nitro re-exports import; Metro can, so the barrel is the
 * right surface here. A case whose import were missing would throw in its
 * `setup()` and the run would never print its DONE marker.
 */
module.exports = require('react-native-nitro-logger');
