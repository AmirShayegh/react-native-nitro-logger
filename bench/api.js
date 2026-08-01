/**
 * The library surface the bench cases run against — Node flavour.
 *
 * Cases `require('../api')`, and module resolution picks the engine: Node
 * lands here and gets the BUILT library, `lib/commonjs` — the artifact that
 * ships — while Metro prefers `api.native.js` and resolves the package name
 * through the workspace instead. Both flavours export the same names, so the
 * case files never know which engine they are on.
 *
 * Individual modules rather than the index barrel, because the barrel
 * re-exports the Nitro adapters, which import `react-native` — Flow-typed
 * source Node cannot parse. Every module named here is free of that import
 * (the barrel and `unstable` are the only two that carry it), and each is
 * still the exact artifact a consumer executes.
 *
 * `bench/run.js` checks lib freshness before spawning anything; requiring a
 * stale build here would silently benchmark last week's code.
 */
const logger = require('../lib/commonjs/Logger.js');
const privacy = require('../lib/commonjs/privacy.js');
const batcher = require('../lib/commonjs/destinations/Batcher.js');
const fileDestination = require('../lib/commonjs/destinations/FileDestination.js');
const utf8 = require('../lib/commonjs/utf8.js');
const jsonLines = require('../lib/commonjs/formatters/JsonLinesFormatter.js');
const defaultFormatter = require('../lib/commonjs/formatters/DefaultFormatter.js');

module.exports = {
  Logger: logger.Logger,
  Log: logger.Log,
  pub: privacy.pub,
  priv: privacy.priv,
  Batcher: batcher.Batcher,
  FileDestination: fileDestination.FileDestination,
  utf8Length: utf8.utf8Length,
  JsonLinesFormatter: jsonLines.JsonLinesFormatter,
  DefaultFormatter: defaultFormatter.DefaultFormatter,
};
