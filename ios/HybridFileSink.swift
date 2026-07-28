import Foundation
import NitroModules

/// The Nitro end of the file sink: marshalling, and nothing else.
///
/// Every decision — batching, backpressure, drop accounting, loss notices —
/// lives in TypeScript, and every byte that touches the disk lives in
/// `LogWriter`. What is left here is converting `Double` to `Int`, one enum to
/// another, and holding exactly one `LogFileHandle`.
///
/// That split is the point, not an accident of it: `LogWriter` imports nothing
/// from Nitro, so rotation, recovery, the registry, and every injected fault run
/// under XCTest in about a second instead of by hand on a simulator. Anything
/// that grows logic in this file has been put in the wrong place.
final class HybridFileSink: HybridFileSinkSpec {
  private let lock = NSLock()
  private var handle: LogFileHandle?

  /// The native finalizer, which is the whole reason the refcount is native.
  ///
  /// An abrupt runtime teardown never runs JavaScript, so a JS `dispose()` is
  /// not a guarantee — but this deinit is. Releasing here hands the descriptor
  /// and the registry slot back even when nothing on the JS side got to run.
  deinit {
    lock.lock()
    let live = handle
    handle = nil
    lock.unlock()
    // Zero deadline: a teardown deinit must not wait on a wedged disk.
    _ = live?.close(deadlineMs: 0)
  }

  var defaultLogDirectory: String {
    let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    return base.appendingPathComponent("Logs").path
  }

  func open(path: String, rotation: RotationConfig?, lineFramed: Bool?) throws {
    lock.lock()
    let alreadyOpen = handle != nil
    lock.unlock()
    guard !alreadyOpen else {
      throw RuntimeError.error(withMessage: "FileSink: already open")
    }

    let acquired: LogFileHandle
    do {
      acquired = try LogWriterRegistry.shared.acquire(
        path: path,
        policy: Self.policy(from: rotation),
        // Absent means absent. Without a declared one-record-per-line contract
        // the startup scan must not trim a trailing record, because it cannot
        // tell a torn one from an intentional newline.
        lineFramed: lineFramed ?? false
      )
    } catch LogWriterError.configConflict {
      throw RuntimeError.error(
        withMessage: "FileSink: another destination already opened this file with a different configuration")
    } catch LogWriterError.symlinkEscape {
      throw RuntimeError.error(withMessage: "FileSink: the log path is a symbolic link")
    } catch LogWriterError.stillClosing {
      // Distinct from the others because it is the one worth retrying: a
      // previous destination on this file has not finished shutting down, and
      // opening a second writer alongside it is exactly what must not happen.
      throw RuntimeError.error(
        withMessage: "FileSink: the previous destination for this file is still closing")
    } catch {
      // Deliberately payload-free. An `errno` description or a path is exactly
      // the kind of string that carries a username, and this message crosses
      // into JavaScript where something will eventually log it.
      throw RuntimeError.error(withMessage: "FileSink: could not open the log file")
    }

    lock.lock()
    handle = acquired
    lock.unlock()
  }

  func appendBatch(batch: String, entryCount: Double) throws -> AppendResult {
    guard let handle = current() else {
      return AppendResult(accepted: false, rejectReason: .closed,
                          queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
    }
    // Refused rather than rounded: an unchecked cast of NaN or 1e30 traps, and
    // a count that does not survive the round trip cannot be trusted to
    // describe the batch it arrived with.
    guard entryCount.isFinite, let count = Int(exactly: entryCount) else {
      return Self.appendResult(
        LogAppendResult(accepted: false, rejectReason: .failed, status: handle.status()))
    }
    return Self.appendResult(handle.appendBatch(batch, entryCount: count))
  }

  func getStatus() throws -> SinkStatus {
    guard let handle = current() else {
      return SinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
    }
    return Self.status(handle.status())
  }

  func flush(deadlineMs: Double) throws -> FlushOutcome {
    guard let handle = current() else {
      // Nothing was ever accepted through this sink, so "every accepted byte
      // reached storage" holds vacuously. Reporting otherwise would have the
      // JavaScript side retry a flush that can never have anything to do.
      return Self.emptyOutcome()
    }
    return Self.flushOutcome(handle.flush(deadlineMs: deadlineMs))
  }

  func close(deadlineMs: Double) throws -> FlushOutcome {
    lock.lock()
    let live = handle
    handle = nil
    lock.unlock()

    guard let live else { return Self.emptyOutcome() }
    return Self.flushOutcome(live.close(deadlineMs: deadlineMs))
  }

  func getLogFilePaths() throws -> [String] {
    current()?.logFilePaths() ?? []
  }

  func clearLogs(deadlineMs: Double) throws -> ClearOutcome {
    guard let handle = current() else {
      // Nothing was ever opened, so there is nothing left behind — but there is
      // also nothing to rebind onto, and saying otherwise would have the JS
      // destination resume against a sink it never opened.
      return ClearOutcome(deletedCount: 0, failedPaths: [], durable: true, rebound: false)
    }
    let outcome = handle.clearLogs(deadlineMs: deadlineMs)
    return ClearOutcome(
      deletedCount: Double(outcome.deletedCount),
      failedPaths: outcome.failedPaths,
      durable: outcome.durable,
      rebound: outcome.rebound
    )
  }

  private func current() -> LogFileHandle? {
    lock.lock()
    defer { lock.unlock() }
    return handle
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

  private static func status(_ status: LogSinkStatus) -> SinkStatus {
    SinkStatus(
      queuedBytes: Double(status.queuedBytes),
      lostBytes: Double(status.lostBytes),
      lostEntries: Double(status.lostEntries),
      degraded: Double(status.degraded)
    )
  }

  private static func appendResult(_ result: LogAppendResult) -> AppendResult {
    AppendResult(
      accepted: result.accepted,
      rejectReason: result.rejectReason.map(reason),
      queuedBytes: Double(result.status.queuedBytes),
      lostBytes: Double(result.status.lostBytes),
      lostEntries: Double(result.status.lostEntries),
      degraded: Double(result.status.degraded)
    )
  }

  private static func flushOutcome(_ outcome: LogFlushOutcome) -> FlushOutcome {
    FlushOutcome(
      durable: outcome.durable,
      timedOut: outcome.timedOut,
      pendingBytes: Double(outcome.pendingBytes),
      queuedBytes: Double(outcome.status.queuedBytes),
      lostBytes: Double(outcome.status.lostBytes),
      lostEntries: Double(outcome.status.lostEntries),
      degraded: Double(outcome.status.degraded)
    )
  }

  private static func emptyOutcome() -> FlushOutcome {
    FlushOutcome(durable: true, timedOut: false, pendingBytes: 0,
                 queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
  }

  private static func reason(_ reason: LogRejectReason) -> RejectReason {
    switch reason {
    case .full: return .full
    case .staleGeneration: return .stalegeneration
    case .closed: return .closed
    case .failed: return .failed
    }
  }
}
