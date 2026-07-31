import Foundation
import NitroModules

/// The Nitro end of the file sink: marshalling, and nothing else.
///
/// Every decision — batching, backpressure, drop accounting, loss notices —
/// lives in TypeScript; every byte that touches the disk lives in `LogWriter`;
/// and which lifecycle call each spec op makes, and what it answers when there
/// is no handle, lives in `FileSinkAnswers`. What is left here is converting
/// `Double` to `Int`, one enum to another, and copying `Wire*` values into the
/// nitrogen types field for field.
///
/// That split is the point, not an accident of it. This class cannot be built
/// without Nitro and so cannot be in the test target — every nitrogen value
/// type is a C++-backed typealias behind that import — so anything with a
/// decision in it that stays in this file is a decision no test on this
/// platform can reach. That is not a hypothetical cost: while the no-handle
/// rules lived here they were untested on both platforms, which is how the two
/// adapters came to give different answers to the same question, and the one
/// bug found in this layer this release was caught by review rather than by a
/// test for exactly that reason.
///
/// Anything that grows logic in this file has been put in the wrong place.
/// `__tests__/adapterThinness.test.js` enforces that with a line ceiling and
/// a ban on `lifecycle.` calls here.
final class HybridFileSink: HybridFileSinkSpec {
  private let answers = FileSinkAnswers()

  /// The native finalizer, which is the whole reason the refcount is native.
  ///
  /// An abrupt runtime teardown never runs JavaScript, so a JS `dispose()` is
  /// not a guarantee — but this deinit is.
  deinit {
    answers.releaseHandle()
  }

  var defaultLogDirectory: String {
    answers.defaultLogDirectory
  }

  func open(path: String, rotation: RotationConfig?, lineFramed: Bool?) throws {
    do {
      try answers.open(
        path: path, policy: Self.policy(from: rotation), lineFramed: lineFramed)
    } catch let refusal as FileSinkOpenRefusal {
      throw RuntimeError.error(withMessage: refusal.message)
    }
  }

  func appendBatch(batch: String, entryCount: Double) throws -> AppendResult {
    Self.appendResult(answers.appendBatch(batch: batch, entryCount: entryCount))
  }

  func getStatus() throws -> SinkStatus {
    Self.status(answers.getStatus())
  }

  func maintain(deadlineMs: Double) throws -> SinkStatus {
    Self.status(answers.maintain(deadlineMs: deadlineMs))
  }

  func collectLogs(deadlineMs: Double, maxTotalBytes: Double) throws -> CollectOutcome {
    Self.collectOutcome(
      answers.collectLogs(deadlineMs: deadlineMs, maxTotalBytes: maxTotalBytes))
  }

  func deleteSupportBundle(deadlineMs: Double) throws -> Bool {
    answers.deleteSupportBundle(deadlineMs: deadlineMs)
  }

  func flush(deadlineMs: Double) throws -> FlushOutcome {
    Self.flushOutcome(answers.flush(deadlineMs: deadlineMs))
  }

  func close(deadlineMs: Double) throws -> FlushOutcome {
    Self.flushOutcome(answers.close(deadlineMs: deadlineMs))
  }

  func getLogFilePaths() throws -> [String] {
    answers.getLogFilePaths()
  }

  func clearLogs(deadlineMs: Double) throws -> ClearOutcome {
    Self.clearOutcome(answers.clearLogs(deadlineMs: deadlineMs))
  }

  // MARK: - Marshalling

  /// Numbers arrive as `Double` because that is what JavaScript has. The
  /// clamping lives in `LogRotationPolicy.init`, which is also where the Kotlin
  /// side's equivalent has to agree with it.
  private static func policy(from config: RotationConfig?) -> LogRotationPolicy {
    guard let config else { return LogRotationPolicy() }
    return LogRotationPolicy(
      maxFileSizeBytes: config.maxFileSizeBytes,
      maxArchivedFilesCount: config.maxArchivedFilesCount,
      maxFileAgeSeconds: config.maxFileAgeSeconds,
      compressArchives: config.compressArchives,
      maxArchiveAgeSeconds: config.maxArchiveAgeSeconds,
      maxTotalLogBytes: config.maxTotalLogBytes
    )
  }

  private static func status(_ status: WireSinkStatus) -> SinkStatus {
    SinkStatus(
      queuedBytes: status.queuedBytes,
      lostBytes: status.lostBytes,
      lostEntries: status.lostEntries,
      degraded: status.degraded
    )
  }

  private static func appendResult(_ result: WireAppendResult) -> AppendResult {
    AppendResult(
      accepted: result.accepted,
      rejectReason: result.rejectReason.map(reason),
      queuedBytes: result.queuedBytes,
      lostBytes: result.lostBytes,
      lostEntries: result.lostEntries,
      degraded: result.degraded
    )
  }

  private static func flushOutcome(_ outcome: WireFlushOutcome) -> FlushOutcome {
    FlushOutcome(
      durable: outcome.durable,
      timedOut: outcome.timedOut,
      pendingBytes: outcome.pendingBytes,
      queuedBytes: outcome.queuedBytes,
      lostBytes: outcome.lostBytes,
      lostEntries: outcome.lostEntries,
      degraded: outcome.degraded
    )
  }

  private static func collectOutcome(_ outcome: WireCollectOutcome) -> CollectOutcome {
    CollectOutcome(
      path: outcome.path,
      byteCount: outcome.byteCount,
      sourceFileCount: outcome.sourceFileCount,
      truncated: outcome.truncated,
      complete: outcome.complete
    )
  }

  private static func clearOutcome(_ outcome: WireClearOutcome) -> ClearOutcome {
    ClearOutcome(
      deletedCount: outcome.deletedCount,
      failedPaths: outcome.failedPaths,
      durable: outcome.durable,
      rebound: outcome.rebound
    )
  }

  private static func reason(_ reason: WireRejectReason) -> RejectReason {
    switch reason {
    case .full: return .full
    case .staleGeneration: return .stalegeneration
    case .closed: return .closed
    case .failed: return .failed
    }
  }
}
