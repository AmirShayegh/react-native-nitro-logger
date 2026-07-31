import Foundation

/// Everything `HybridFileSink` decides, in a file a test can build.
///
/// `HybridFileSink` imports Nitro, and every nitrogen value type is a
/// C++-backed typealias behind that import, so the file cannot join the test
/// target and no unit test on this platform has ever executed a line of it.
/// What sat there was not marshalling: which lifecycle call each spec op makes,
/// what it does with the answer, and what it returns when there is no handle —
/// ~390 lines of policy, unreachable. The one bug found in that layer this
/// release (`deleteSupportBundle` reading `artifactSource()` where the
/// `snapshot()` discipline was required) was caught by review rather than by a
/// test, precisely because the file could not be reached.
///
/// So the decisions live here, returning plain `Wire*` mirrors of the nitrogen
/// value types, and `HybridFileSink` becomes what its own header always claimed
/// it was: a field-for-field copy and nothing else.
///
/// ## What this does NOT close
///
/// The `Wire*`-to-nitrogen copy in `HybridFileSink`, and Nitro's own
/// marshalling under it, stay untested here — they are covered end to end only
/// by the min-rn smoke jobs. This is a real reduction of that gap, not its
/// elimination: what moves is the part that had decisions in it.

// MARK: - Wire mirrors

/// Mirrors of the nitrogen value types, field for field.
///
/// They exist so this file can name what it returns without importing Nitro.
/// `Equatable` on purpose: the paired suite compares whole values, so a field
/// added on one side and forgotten on the other fails rather than being
/// silently dropped from the comparison.

struct WireSinkStatus: Equatable {
  let queuedBytes: Double
  let lostBytes: Double
  let lostEntries: Double
  let degraded: Double
}

enum WireRejectReason: String, Equatable {
  case full
  case staleGeneration
  case closed
  case failed
}

struct WireAppendResult: Equatable {
  let accepted: Bool
  /// Present only when `accepted` is false.
  let rejectReason: WireRejectReason?
  let queuedBytes: Double
  let lostBytes: Double
  let lostEntries: Double
  let degraded: Double
}

struct WireFlushOutcome: Equatable {
  let durable: Bool
  let timedOut: Bool
  let pendingBytes: Double
  let queuedBytes: Double
  let lostBytes: Double
  let lostEntries: Double
  let degraded: Double
}

struct WireCollectOutcome: Equatable {
  let path: String
  let byteCount: Double
  let sourceFileCount: Double
  let truncated: Bool
  let complete: Bool
}

struct WireClearOutcome: Equatable {
  let deletedCount: Double
  let failedPaths: [String]
  let durable: Bool
  let rebound: Bool
}

/// A refused open, carrying the message the adapter will send to JavaScript.
///
/// The message rather than a case per reason, because the messages are the
/// cross-platform contract — `__tests__/openFailureParity` compares them
/// against `FileSinkMessages.kt` — and a mapping that produced the right case
/// and the wrong string would satisfy an enum comparison while shipping the bug
/// that test exists to catch.
struct FileSinkOpenRefusal: Error, Equatable {
  let message: String
}

// MARK: - The answers

final class FileSinkAnswers {
  /// The handle, the artifacts flag, and every rule about which combinations
  /// are legal — see `FileSinkLifecycle`, which carries the transition table.
  private let lifecycle = FileSinkLifecycle()

  /// Injected so a test can run against an isolated registry rather than the
  /// process-wide one. The adapter passes nothing and gets `.shared`, which is
  /// the only configuration that ships.
  private let registry: LogWriterRegistry

  init(registry: LogWriterRegistry = .shared) {
    self.registry = registry
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

  /// Releases the handle without waiting, for the adapter's `deinit`.
  ///
  /// An abrupt runtime teardown never runs JavaScript, so a JS `dispose()` is
  /// not a guarantee — but that deinit is. Releasing here hands the descriptor
  /// and the registry slot back even when nothing on the JS side got to run.
  func dispose() {
    // Zero deadline: a teardown deinit must not wait on a wedged disk.
    _ = lifecycle.beginDispose().handle?.close(deadlineMs: 0)
  }

  func open(path: String, policy: LogRotationPolicy, lineFramed: Bool?) throws {
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
      throw FileSinkOpenRefusal(message: FileSinkMessages.alreadyOpen)
    case .closing:
      throw FileSinkOpenRefusal(message: FileSinkMessages.closing)
    case .disposed:
      throw FileSinkOpenRefusal(message: FileSinkMessages.disposed)
    }

    // Written by `acquire` the moment it resolves, so the failure path below
    // has the canonical name without asking the filesystem a second question.
    // Still `nil` if resolution itself failed — nothing was resolved, and
    // `path` as spelled here is not a stand-in for a name the registry made.
    var resolvedPath: String?

    let acquired: LogFileHandle
    do {
      acquired = try registry.acquire(
        path: path,
        policy: policy,
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

  func appendBatch(batch: String, entryCount: Double) -> WireAppendResult {
    guard let handle = current() else {
      return WireAppendResult(accepted: false, rejectReason: .closed,
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

  func getStatus() -> WireSinkStatus {
    guard let handle = current() else {
      return WireSinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
    }
    return Self.status(handle.status())
  }

  func maintain(deadlineMs: Double) -> WireSinkStatus {
    // Same shape as `getStatus`, deliberately: a sink nobody has opened has no
    // files to rotate and no archives to sweep, so "nothing to do" is the whole
    // answer and a zeroed status describes it exactly. A closed one is the same
    // — its writer is gone, and the artifacts it left are the registry's to
    // sweep the next time somebody opens that path.
    guard let handle = current() else {
      return WireSinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
    }
    return Self.status(handle.maintain(deadlineMs: deadlineMs))
  }

  func collectLogs(deadlineMs: Double, maxTotalBytes: Double) -> WireCollectOutcome {
    // No handle, no bundle — and `complete: true`, because a sink that was
    // never opened has finished collecting everything it has. A support flow
    // that treated this as an error would show a failure for an app that
    // simply has no logs yet.
    guard let handle = current() else {
      return WireCollectOutcome(
        path: "", byteCount: 0, sourceFileCount: 0, truncated: false, complete: true)
    }
    let outcome = handle.collectLogs(deadlineMs: deadlineMs, maxTotalBytes: maxTotalBytes)
    return WireCollectOutcome(
      path: outcome.path,
      byteCount: outcome.byteCount,
      sourceFileCount: outcome.sourceFileCount,
      truncated: outcome.truncated,
      complete: outcome.complete
    )
  }

  func deleteSupportBundle(deadlineMs: Double) -> Bool {
    // `snapshot`, the `clearLogs` treatment — deliberately NOT the
    // `getLogFilePaths` one, though the two look alike and this method sat on
    // the other side of that line until a review pushed back.
    //
    // The difference is that reading a directory this object no longer owns is
    // harmless and deleting from it is not. Once the handle is gone there is no
    // generation left to check and no queue to serialize against, so a live
    // handle may own that path now and be mid-publish in it; a `.support.gz`
    // deleted from here would be *its* bundle, whose path it has already handed
    // back to a caller. The upload-finishes-after-`dispose` case is real, and
    // the answer to it is to delete before disposing, or through a fresh
    // destination on the same path — both of which produce a live handle with a
    // current generation, which is the only thing that makes this safe.
    //
    // Both fields in ONE critical section, like `clearLogs`: reading them
    // separately lets a close land in between and produce "no handle, nothing
    // created", the one combination that is never true.
    let (live, durableWithoutHandle) = lifecycle.snapshot()
    guard let handle = live else {
      // Never opened: no directory, no bundle, vacuously gone. Opened and since
      // closed: the files are out of reach and this object cannot vouch for
      // them.
      return durableWithoutHandle
    }
    return handle.deleteSupportBundle(deadlineMs: deadlineMs)
  }

  func flush(deadlineMs: Double) -> WireFlushOutcome {
    // One snapshot, so the handle and the answer to give without one cannot
    // disagree about which instant they describe.
    let (live, durableWithoutHandle) = lifecycle.snapshot()
    guard let handle = live else {
      return Self.noHandleOutcome(durable: durableWithoutHandle)
    }
    return Self.flushOutcome(handle.flush(deadlineMs: deadlineMs))
  }

  func close(deadlineMs: Double) -> WireFlushOutcome {
    // Detaching also records the close against an acquisition still in flight,
    // which is what keeps that writer from being installed into a sink the
    // caller has already closed.
    let detached = lifecycle.beginClose()
    guard let live = detached.handle else {
      return Self.noHandleOutcome(durable: detached.durableWithoutHandle)
    }
    return Self.flushOutcome(live.close(deadlineMs: deadlineMs))
  }

  func getLogFilePaths() -> [String] {
    // Not `current()?.logFilePaths() ?? []`. Closing releases a handle; it does
    // not delete files, and `[]` from a closed sink tells a support-upload flow
    // there is nothing to collect over logs that are still on the device. See
    // the `getLogFilePaths` row of `FileSinkLifecycle`'s table.
    let (live, path) = lifecycle.artifactSource()
    if let handle = live { return handle.logFilePaths() }
    guard let path else { return [] }
    return LogWriter.artifactPaths(at: URL(fileURLWithPath: path))
  }

  func clearLogs(deadlineMs: Double) -> WireClearOutcome {
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
      return WireClearOutcome(
        deletedCount: 0, failedPaths: [], durable: durableWithoutHandle, rebound: false)
    }
    let outcome = handle.clearLogs(deadlineMs: deadlineMs)
    return WireClearOutcome(
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
  static func openFailure(_ error: Error) -> FileSinkOpenRefusal {
    switch error as? LogWriterError {
    case .configConflict:
      return FileSinkOpenRefusal(message: FileSinkMessages.configConflict)
    case .symlinkEscape:
      return FileSinkOpenRefusal(message: FileSinkMessages.symlinkEscape)
    case .locked:
      // Distinct from every other refusal because nothing this process does
      // will fix it: another OS process is appending to this file, and the
      // answer is to pick a different path or stop the other one.
      return FileSinkOpenRefusal(message: FileSinkMessages.locked)
    case .stillClosing:
      // Distinct from the others because it is the one worth retrying: a
      // previous destination on this file has not finished shutting down, and
      // opening a second writer alongside it is exactly what must not happen.
      return FileSinkOpenRefusal(message: FileSinkMessages.stillClosing)
    case .openFailed, .none:
      // `openFailed` carries a path or an `errno` description, so its payload
      // is dropped here rather than forwarded.
      return FileSinkOpenRefusal(message: FileSinkMessages.openFailed)
    }
  }

  private static func status(_ status: LogSinkStatus) -> WireSinkStatus {
    WireSinkStatus(
      queuedBytes: Double(status.queuedBytes),
      lostBytes: Double(status.lostBytes),
      lostEntries: Double(status.lostEntries),
      degraded: Double(status.degraded)
    )
  }

  private static func appendResult(_ result: LogAppendResult) -> WireAppendResult {
    WireAppendResult(
      accepted: result.accepted,
      rejectReason: result.rejectReason.map(reason),
      queuedBytes: Double(result.status.queuedBytes),
      lostBytes: Double(result.status.lostBytes),
      lostEntries: Double(result.status.lostEntries),
      degraded: Double(result.status.degraded)
    )
  }

  private static func flushOutcome(_ outcome: LogFlushOutcome) -> WireFlushOutcome {
    WireFlushOutcome(
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
  private static func noHandleOutcome(durable: Bool) -> WireFlushOutcome {
    WireFlushOutcome(durable: durable, timedOut: false, pendingBytes: 0,
                     queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
  }

  private static func reason(_ reason: LogRejectReason) -> WireRejectReason {
    switch reason {
    case .full: return .full
    case .staleGeneration: return .staleGeneration
    case .closed: return .closed
    case .failed: return .failed
    }
  }
}
