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
  /// The handle, the artifacts flag, and every rule about which combinations
  /// are legal — see `FileSinkLifecycle`, which carries the transition table.
  ///
  /// Kept out of this file on purpose. This class cannot be built without
  /// Nitro and so cannot be in the test target, and while these rules lived
  /// here they were untested on both platforms — which is how the two adapters
  /// came to give different answers to the same question.
  private let lifecycle = FileSinkLifecycle()

  /// The native finalizer, which is the whole reason the refcount is native.
  ///
  /// An abrupt runtime teardown never runs JavaScript, so a JS `dispose()` is
  /// not a guarantee — but this deinit is. Releasing here hands the descriptor
  /// and the registry slot back even when nothing on the JS side got to run.
  deinit {
    // Zero deadline: a teardown deinit must not wait on a wedged disk.
    _ = lifecycle.beginDispose().handle?.close(deadlineMs: 0)
  }

  /// `<Library>/Logs` — and deliberately not a second spelling of it.
  ///
  /// The securing layer declines to make a directory-wide claim on this
  /// directory, because it is where an iOS app is *expected* to put logs: the
  /// host app and any other library in the process may use it too, and on a
  /// fresh container the first `open` simply wins the `mkdir`. Winning that
  /// race is not ownership. Every artifact this writer creates still gets all
  /// three protections through its own descriptor — see `LogDirectoryClaim`.
  ///
  /// That decision is made against `LogSecureFile.conventionalLogDirectory`, so
  /// this reads the same definition rather than restating it. The directory the
  /// package hands out by default has to be exactly the directory it declines
  /// to claim, and two copies of that expression is how they stop being.
  var defaultLogDirectory: String {
    LogSecureFile.conventionalLogDirectory.path
  }

  func open(path: String, rotation: RotationConfig?, lineFramed: Bool?) throws {
    // Refused rather than allowed to race a second acquisition: the loser's
    // handle would be unreachable, and unreachable means a later purge never
    // deletes its files. The lock is not held across the acquisition, which
    // does real I/O — see `FileSinkLifecycle`.
    //
    // The refusal says which refusal it is. "Already open" and "an earlier open
    // is still being cancelled" are different instructions to the caller: the
    // second is temporary, bounded by the registry's close wait, and retrying
    // is the right response to it.
    switch lifecycle.beginOpen() {
    case .granted:
      break
    case .alreadyOpen:
      throw RuntimeError.error(withMessage: "FileSink: already open")
    case .closing:
      throw RuntimeError.error(
        withMessage: "FileSink: an earlier open on this sink is still being cancelled; retry")
    case .disposed:
      throw RuntimeError.error(withMessage: "FileSink: this sink has been disposed")
    }

    // Written by `acquire` the moment it resolves, so the failure path below
    // has the canonical name without asking the filesystem a second question.
    // Still `nil` if resolution itself failed — nothing was resolved, and
    // `path` as spelled here is not a stand-in for a name the registry made.
    var resolvedPath: String?

    let acquired: LogFileHandle
    do {
      acquired = try LogWriterRegistry.shared.acquire(
        path: path,
        policy: Self.policy(from: rotation),
        // Absent means absent. Without a declared one-record-per-line contract
        // the startup scan must not trim a trailing record, because it cannot
        // tell a torn one from an intentional newline.
        lineFramed: lineFramed ?? false,
        onResolve: { resolvedPath = $0 }
      )
    } catch {
      // One exit, whatever went wrong. A failure that leaves the attempt
      // published refuses every later open for the life of the object, and
      // spreading the release across one clause per error kind is how the
      // clause added next gets forgotten.
      //
      // The resolved path goes with it: `acquire` creates the log directory
      // before it opens the file, so a throw can still leave artifacts, and
      // they are under the canonical name. `nil` — resolution never got that
      // far — means there is nothing to enumerate, which is exactly what
      // should be recorded.
      lifecycle.failOpen(artifactPath: resolvedPath)
      throw Self.openFailure(error)
    }

    // A close that arrived mid-acquisition found nothing to hand back and has
    // already returned. Installing now would leave a live writer holding a
    // descriptor that nothing can reach or release.
    if lifecycle.finishOpen(acquired) == .abandon {
      // Zero deadline: the caller has already been told this sink is closed.
      _ = acquired.close(deadlineMs: 0)
    }
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

  func maintain(deadlineMs: Double) throws -> SinkStatus {
    // Same shape as `getStatus`, deliberately: a sink nobody has opened has no
    // files to rotate and no archives to sweep, so "nothing to do" is the whole
    // answer and a zeroed status describes it exactly. A closed one is the same
    // — its writer is gone, and the artifacts it left are the registry's to
    // sweep the next time somebody opens that path.
    guard let handle = current() else {
      return SinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
    }
    return Self.status(handle.maintain(deadlineMs: deadlineMs))
  }

  func collectLogs(deadlineMs: Double, maxTotalBytes: Double) throws -> CollectOutcome {
    // No handle, no bundle — and `complete: true`, because a sink that was
    // never opened has finished collecting everything it has. A support flow
    // that treated this as an error would show a failure for an app that
    // simply has no logs yet.
    guard let handle = current() else {
      return CollectOutcome(
        path: "", byteCount: 0, sourceFileCount: 0, truncated: false, complete: true)
    }
    let outcome = handle.collectLogs(deadlineMs: deadlineMs, maxTotalBytes: maxTotalBytes)
    return CollectOutcome(
      path: outcome.path,
      byteCount: outcome.byteCount,
      sourceFileCount: outcome.sourceFileCount,
      truncated: outcome.truncated,
      complete: outcome.complete
    )
  }

  func flush(deadlineMs: Double) throws -> FlushOutcome {
    // One snapshot, so the handle and the answer to give without one cannot
    // disagree about which instant they describe.
    let (live, durableWithoutHandle) = lifecycle.snapshot()
    guard let handle = live else {
      return Self.noHandleOutcome(durable: durableWithoutHandle)
    }
    return Self.flushOutcome(handle.flush(deadlineMs: deadlineMs))
  }

  func close(deadlineMs: Double) throws -> FlushOutcome {
    // Detaching also records the close against an acquisition still in flight,
    // which is what keeps that writer from being installed into a sink the
    // caller has already closed.
    let detached = lifecycle.beginClose()
    guard let live = detached.handle else {
      return Self.noHandleOutcome(durable: detached.durableWithoutHandle)
    }
    return Self.flushOutcome(live.close(deadlineMs: deadlineMs))
  }

  func getLogFilePaths() throws -> [String] {
    // Not `current()?.logFilePaths() ?? []`. Closing releases a handle; it does
    // not delete files, and `[]` from a closed sink tells a support-upload flow
    // there is nothing to collect over logs that are still on the device. See
    // the `getLogFilePaths` row of `FileSinkLifecycle`'s table.
    let (live, path) = lifecycle.artifactSource()
    if let handle = live { return handle.logFilePaths() }
    guard let path else { return [] }
    return LogWriter.artifactPaths(at: URL(fileURLWithPath: path))
  }

  func clearLogs(deadlineMs: Double) throws -> ClearOutcome {
    // Both fields read in ONE critical section. Reading them separately lets a
    // close land in between and produce "no handle, nothing created" — the one
    // combination that is never true, and the one that lies in the direction
    // that matters.
    let (live, durableWithoutHandle) = lifecycle.snapshot()

    guard let handle = live else {
      // Nothing created: "every artifact is gone" holds vacuously. `rebound`
      // stays false regardless — there is nothing to rebind onto, and saying
      // otherwise would have the JS destination resume against a sink it never
      // opened.
      //
      // Otherwise the files are still there and this object cannot reach them.
      // The registry has the right answer for a released handle
      // (`durable: false`, pinned by `testAReleasedHandleCannotPurge`) but
      // `close` nils the handle above before that branch is reachable, so the
      // honest answer has to be produced here.
      return ClearOutcome(
        deletedCount: 0, failedPaths: [], durable: durableWithoutHandle, rebound: false)
    }
    let outcome = handle.clearLogs(deadlineMs: deadlineMs)
    return ClearOutcome(
      deletedCount: Double(outcome.deletedCount),
      failedPaths: outcome.failedPaths,
      durable: outcome.durable,
      rebound: outcome.rebound
    )
  }

  private func current() -> LogFileHandle? { lifecycle.current() }

  // MARK: - Marshalling

  /// Maps an acquisition failure to a message that can cross into JavaScript.
  ///
  /// Payload-free by construction. An `errno` description or a path is exactly
  /// the kind of string that carries a username, and this message ends up
  /// somewhere that logs it.
  private static func openFailure(_ error: Error) -> Error {
    switch error as? LogWriterError {
    case .configConflict:
      return RuntimeError.error(
        withMessage: "FileSink: another destination already opened this file with a different configuration")
    case .symlinkEscape:
      return RuntimeError.error(withMessage: "FileSink: the log path is a symbolic link")
    case .locked:
      // Distinct from every other refusal because nothing this process does
      // will fix it: another OS process is appending to this file, and the
      // answer is to pick a different path or stop the other one.
      return RuntimeError.error(
        withMessage: "FileSink: another process is writing this log file")
    case .stillClosing:
      // Distinct from the others because it is the one worth retrying: a
      // previous destination on this file has not finished shutting down, and
      // opening a second writer alongside it is exactly what must not happen.
      return RuntimeError.error(
        withMessage: "FileSink: the previous destination for this file is still closing")
    case .openFailed, .none:
      // `openFailed` carries a path or an `errno` description, so its payload
      // is dropped here rather than forwarded.
      return RuntimeError.error(withMessage: "FileSink: could not open the log file")
    }
  }

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

  /// What `flush` and `close` answer when there is no handle to ask.
  ///
  /// `durable` is the whole question, and it is not the same in both of the
  /// states that produce no handle — see the table on `FileSinkLifecycle`.
  ///
  /// - Never opened: nothing was ever accepted through this sink, so "every
  ///   accepted byte reached storage" holds with nothing to check.
  /// - Opened and since closed: the files are out of reach and this object
  ///   cannot vouch for them. `true` here would tell the JavaScript batcher to
  ///   mark loss notices confirmed that may never have reached disk — including
  ///   after a close that timed out with bytes still pending, which is exactly
  ///   when the claim is worst.
  private static func noHandleOutcome(durable: Bool) -> FlushOutcome {
    FlushOutcome(durable: durable, timedOut: false, pendingBytes: 0,
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
