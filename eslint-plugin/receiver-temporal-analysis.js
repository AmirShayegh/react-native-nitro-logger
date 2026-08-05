'use strict';

function upperBound(points, offset) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function createTemporalWriteTools(dependencies) {
  const { analysisStats, isDeferred, receiverWrite } = dependencies;
  const summaryCache = new WeakMap();

  function temporalSummary(context, writes, wildcard = true) {
    const cached = summaryCache.get(writes);
    if (cached) return cached;
    const stats = analysisStats(context);
    if (stats) {
      stats[
        wildcard
          ? 'receiverWildcardSummaryComputations'
          : 'receiverNamedSummaryComputations'
      ] += 1;
    }
    const deferred = [];
    const straight = [];
    for (const write of writes) {
      (isDeferred(write.gate) ? deferred : straight).push(write);
    }
    straight.sort((left, right) => left.gate.range[0] - right.gate.range[0]);
    const offsets = Object.freeze(straight.map((write) => write.gate.range[0]));
    const points = Object.freeze(
      [...new Set(offsets)].sort((left, right) => left - right)
    );
    const summary = Object.freeze({
      deferred: Object.freeze(deferred),
      offsets,
      points,
      results: new Map(),
      straight: Object.freeze(straight),
    });
    summaryCache.set(writes, summary);
    return summary;
  }

  function summarizedTemporalWrite(context, writes, callNode, opaqueAlways) {
    const summary = temporalSummary(context, writes, opaqueAlways);
    const deferredCall = !!callNode && isDeferred(callNode);
    const offset = callNode?.range?.[0];
    const count =
      !callNode || deferredCall || !Number.isFinite(offset)
        ? summary.straight.length
        : upperBound(summary.offsets, offset);
    const key = `${deferredCall ? 'd' : 's'}:${count}`;
    if (summary.results.has(key)) return summary.results.get(key);
    const stats = analysisStats(context);
    if (stats) {
      stats[
        opaqueAlways
          ? 'receiverWildcardIntervalComputations'
          : 'receiverNamedIntervalComputations'
      ] += 1;
    }
    const possible = summary.deferred.length + count;
    const source = summary.deferred[0] ?? summary.straight[count - 1] ?? null;
    const result = !source
      ? null
      : !opaqueAlways && possible === 1
        ? source
        : receiverWrite(source.gate, [source.gate]);
    summary.results.set(key, result);
    return result;
  }

  return Object.freeze({
    changePoints: (context, writes, wildcard = true) =>
      temporalSummary(context, writes, wildcard).points,
    summarizedTemporalWrite,
  });
}

module.exports = { createTemporalWriteTools };
