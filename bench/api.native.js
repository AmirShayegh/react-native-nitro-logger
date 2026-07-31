/**
 * The library surface the bench cases run against — Hermes flavour.
 *
 * Metro prefers `.native.js` over `.js`, which is the entire trick: the same
 * `require('../api')` in a case file resolves to `lib/commonjs` under Node
 * and to the workspace source here (via the `react-native-nitro-logger-source`
 * condition the example's Metro config sets). The engines differ; the cases
 * must not.
 */
module.exports = require('react-native-nitro-logger');
