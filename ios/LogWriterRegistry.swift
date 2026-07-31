import Foundation

/// One writer per file, no matter how many destinations point at it.
///
/// Two `FileHandle`s appending to the same path from different queues interleave
/// mid-record, and two rotation schedules racing over the same file archive each
/// other's fresh output. The registry makes that impossible by construction:
/// everything that resolves to the same file gets the same `LogWriter`.
///
/// **The key is the realpath-resolved path.** `logs/app.log`,
/// `logs/../logs/app.log`, and a `logs` symlink into the real directory are the
/// same file and must land on the same entry — comparing the strings the caller
/// passed in would hand out two writers for one file, which is exactly the
/// collision the registry exists to stop.
public final class LogWriterRegistry {
  public static let shared = LogWriterRegistry()

  /// A condition rather than a plain lock, because acquisition sometimes has to
  /// *wait* — see `closing` below.
  private let condition = MonotonicCondition()
  private var writers: [String: LogWriter] = [:]
  /// Paths whose writer has been evicted but is still draining and closing.
  ///
  /// Eviction and close cannot be one atomic step: closing waits on the write
  /// queue, and holding the registry lock across that would stall every other
  /// file. But between the two, the map has no entry for the path — so an
  /// acquire arriving in that window would build a *second* writer while the
  /// first still has accepted batches queued, giving one file two queues and
  /// two rotation schedules. That is the exact collision this registry exists
  /// to prevent, so acquisition waits out the close instead.
  ///
  /// Counted rather than a set: it costs nothing and stops a stray double
  /// release from clearing a marker another close still needs.
  ///
  /// ## An entry here can be permanent, and that is the chosen behaviour
  ///
  /// The marker is dropped by the close that set it, from the `defer` in
  /// `LogWriter.close`'s barrier. On this platform that `defer` is structural
  /// insurance rather than a fix — nothing in that block throws — but the
  /// Kotlin twin reached the same guarantee through a `finally` that closed a
  /// real hole: an `Error` escaping there stranded the path on perfectly
  /// healthy storage.
  ///
  /// What remains is a writer that never finishes draining, because the disk
  /// it is writing to stopped answering. That path then refuses every later
  /// acquire with `stillClosing` for the life of the process, and no timer
  /// clears it. **This is deliberate.** While that writer exists it still holds
  /// the descriptor and the OS-level exclusive lock, so the alternative is not
  /// "recover" — it is "open a second writer onto a file the first has not let
  /// go of", which is the collision this map exists to prevent. A marker that
  /// is correct and unhelpful beats one that is wrong.
  ///
  /// Reclaiming it needs a second source of truth for "will this writer ever
  /// finish" — a writer-owned predicate that answers *stopped forever*, not
  /// *slow* — and `dropClaimLocked`'s doc explains why inventing one lightly is
  /// worse than the wait. A timeout is not that predicate: an acquire timing
  /// out says only that five seconds passed. Revisit if field reports show
  /// `stillClosing` outliving the storage problem that caused it.
  private var closing: [String: Int] = [:]
  private var nextHandleID: UInt64 = 1

  /// How long an acquire will wait for a previous writer on the same path to
  /// finish shutting down before giving up.
  static let closeWaitSeconds: TimeInterval = 5

  /// Test seam: runs after `resolve` and before the registry lock is taken.
  ///
  /// That gap is where the mkdir-winner/publication race lives, and nothing
  /// else can hold an acquire open inside it: the gap contains no lock to
  /// contend on and no I/O to stall. The race test parks the mkdir-winning
  /// acquire here while a second acquire publishes the writer, which is the
  /// interleaving the reuse branch's `absorbDirectoryShortfall` exists for.
  var afterResolveForTesting: (() -> Void)?

  init() {}

  /// Acquires a handle on the writer for `path`, creating it if needed.
  ///
  /// Acquisition happens entirely under the lock, so two runtimes opening the
  /// same file concurrently cannot both construct a writer and have one silently
  /// replace the other. Construction does touch the filesystem while the lock is
  /// held; it happens once per file and only on the open path, which is the
  /// cheaper trade than a second writer existing for even an instant.
  public func acquire(
    path: String,
    policy: LogRotationPolicy,
    lineFramed: Bool,
    rawWrite: LogWriter.RawWrite? = nil,
    compressor: LogWriter.Compressor? = nil,
    /// Monotonic clock for backoffs — see `LogWriter.Steady`. Kotlin's twin is
    /// `monotonic`, and forwarding it here is the only way a test can reach it:
    /// writers are only ever built through this call.
    steady: LogWriter.Steady? = nil,
    /// Wall clock for age rotation and archive retention — see `LogWriter.Clock`.
    /// Forwarded here for the same reason `steady` is: writers are only ever
    /// built through this call, so this is the only place a test can reach it.
    clock: LogWriter.Clock? = nil,
    /// Holds the open sweep on the queue — see `LogWriter.init`. Forwarded here
    /// for the same reason `steady` and `clock` are: writers are only ever built
    /// through this call.
    openSweepGate: (() -> Void)? = nil,
    /// Reports the canonical path, once, the instant resolution produces it.
    ///
    /// For the caller that has to answer "where are the artifacts" after this
    /// call has **thrown**. `resolve` creates the log directory before it opens
    /// anything, so a failure downstream of it can still leave files on disk,
    /// and they are under the canonical name rather than the caller's spelling
    /// of it.
    ///
    /// Reported from here rather than looked up again afterwards, and that is
    /// the whole point: re-resolving the caller's string after the failure
    /// would consult the filesystem a second time, and a symlink retargeted in
    /// between would answer with a directory this acquire never touched. What
    /// is handed over is the value this acquire actually used.
    ///
    /// Not called when `resolve` itself throws — nothing was resolved, so there
    /// is no canonical name to give, and the caller's spelling is not a
    /// substitute for one.
    onResolve: ((String) -> Void)? = nil
  ) throws -> LogFileHandle {
    let resolved = try LogWriterRegistry.resolve(path: path)
    onResolve?(resolved.canonicalPath)
    afterResolveForTesting?()

    condition.lock()
    defer { condition.unlock() }

    // Wait out a close still in progress on this path — but not forever. The
    // claim is now cleared by the writer's own queue rather than by whoever
    // called close, so a wedged disk means it may never clear at all. Failing
    // the open is the fail-closed answer: one writer per file is the invariant
    // worth keeping, and a caller that cannot have it should be told so rather
    // than handed a second one.
    let waitUntil = DispatchTime.now() + .milliseconds(Int(Self.closeWaitSeconds * 1000))
    while closing[resolved.canonicalPath] != nil {
      if !condition.wait(until: waitUntil) {
        throw LogWriterError.stillClosing
      }
    }

    let writer: LogWriter
    if let existing = writers[resolved.canonicalPath], !existing.isClosed {
      // BEFORE the configuration check, deliberately. This acquire may be the
      // one whose `resolve` won the `mkdir` — and with it the only protection
      // verdict the directory ever gets — while another acquire won THIS lock
      // and published the writer with nothing to report. `resolve` runs outside
      // the lock, so the evidence and the writer can arrive on different
      // threads, and the verdict is folded in wherever it lands rather than
      // only through the constructor.
      //
      // Ordering it after the guard below would lose it for good on the one
      // path where this acquire never returns: a rejected caller still made the
      // directory, and what it learned about that directory is true regardless
      // of the policy it asked for. The live writer is the only thing left to
      // tell, and `configConflict` would otherwise take the finding with it.
      existing.absorbDirectoryShortfall(resolved.shortfall)

      // A second destination on the same file must agree about how that file is
      // written. Silently honouring the first caller's rotation policy would
      // give the second one a file that behaves nothing like what it asked for,
      // and silently honouring the last would change it under the first.
      guard existing.policy == policy, existing.lineFramed == lineFramed else {
        throw LogWriterError.configConflict
      }
      writer = existing
    } else {
      writer = try LogWriter(
        fileURL: resolved.url,
        canonicalPath: resolved.canonicalPath,
        policy: policy,
        lineFramed: lineFramed,
        rawWrite: rawWrite,
        compressor: compressor,
        steady: steady,
        clock: clock,
        openSweepGate: openSweepGate,
        directoryShortfall: resolved.shortfall
      )
      writers[resolved.canonicalPath] = writer
    }

    writer.retain()
    let id = nextHandleID
    nextHandleID &+= 1
    return LogFileHandle(id: id, writer: writer, registry: self)
  }

  /// Drops one handle's claim, closing and evicting the writer at zero.
  ///
  /// Called from `LogFileHandle.deinit` as well as from an explicit dispose, so
  /// a runtime torn down without running JavaScript finalizers still gives the
  /// file descriptor back.
  func release(_ writer: LogWriter, handleID: UInt64, deadlineMs: Double) {
    let path = writer.canonicalPath

    condition.lock()
    let remaining = writer.releaseOne()
    let shouldClose = remaining <= 0
    if shouldClose {
      if writers[path] === writer { writers.removeValue(forKey: path) }
      // Claim the path for the duration of the close. An acquire arriving now
      // waits rather than building a rival writer over a file this one is
      // still draining.
      closing[path, default: 0] += 1
    }
    condition.unlock()

    guard shouldClose else { return }

    // The claim is dropped by the writer's own queue, in `onTerminated`, not
    // when this call stops waiting. A close that hits its deadline leaves work
    // still executing on that queue; releasing the path then would let a
    // replacement writer open the same file underneath it.
    _ = writer.close(handleID: handleID, deadlineMs: deadlineMs) { [weak self] in
      self?.finishClosing(path)
    }
  }

  private func finishClosing(_ path: String) {
    condition.lock()
    if let outstanding = closing[path], outstanding > 1 {
      closing[path] = outstanding - 1
    } else {
      closing.removeValue(forKey: path)
    }
    condition.broadcast()
    condition.unlock()
  }

  struct Resolved {
    let url: URL
    let canonicalPath: String
    /// What creating the directory fell short of.
    ///
    /// Carried rather than dropped because this call is the one that creates
    /// the directory, and `createDirectory` evaluates the backup exclusion and
    /// the protection class **only** on the branch where its own `mkdir` won.
    /// Every later caller finds the directory already there and is answered by
    /// `inspect`, which reports the mode alone. If this value is discarded, a
    /// directory whose backup exclusion silently failed is indistinguishable
    /// from one where it held — for the life of the process.
    let shortfall: LogSecureFile.Shortfall
  }

  /// Turns a caller-supplied path into the canonical file it names.
  ///
  /// The parent directory is created before resolution, because `realpath`
  /// answers only for things that exist — resolving first would fall back to
  /// the literal string on a fresh install and hand out a key that stops
  /// matching the moment the directory appears.
  static func resolve(path: String) throws -> Resolved {
    guard !path.isEmpty else { throw LogWriterError.openFailed("empty path") }
    let url = URL(fileURLWithPath: path).standardizedFileURL
    let directory = url.deletingLastPathComponent()
    let name = url.lastPathComponent
    guard !name.isEmpty, name != "." , name != ".." else {
      throw LogWriterError.openFailed("path does not name a file")
    }

    let shortfall = try LogSecureFile.createDirectory(at: directory)

    guard let canonicalDirectory = realpath(directory.path, nil) else {
      throw LogWriterError.openFailed("could not resolve the log directory")
    }
    defer { free(canonicalDirectory) }
    let directoryPath = String(cString: canonicalDirectory)

    // The log file itself must not be a symlink. Following one would write the
    // app's log wherever the link points — a path the caller never named and
    // the purge would never clean — and would let two different registry keys
    // resolve to the same inode.
    let candidate = URL(fileURLWithPath: directoryPath).appendingPathComponent(name)
    var info = stat()
    if lstat(candidate.path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFLNK {
      throw LogWriterError.symlinkEscape
    }

    return Resolved(url: candidate, canonicalPath: candidate.path, shortfall: shortfall)
  }

  // MARK: - Test support

  /// A registry with no shared state, so tests do not leak writers into each
  /// other through the singleton.
  static func isolated() -> LogWriterRegistry { LogWriterRegistry() }

  var liveWriterCountForTesting: Int {
    condition.lock()
    defer { condition.unlock() }
    return writers.count
  }

  var closingCountForTesting: Int {
    condition.lock()
    defer { condition.unlock() }
    return closing.count
  }
}

/// One JavaScript destination's claim on a writer.
///
/// Owns the identity that loss is attributed to and the generation that fences
/// it after a purge. The Nitro hybrid object holds exactly one of these, so the
/// native finalizer running is enough to release the claim — no JavaScript has
/// to execute for the descriptor to come back.
public final class LogFileHandle {
  let id: UInt64
  private let writer: LogWriter
  private weak var registry: LogWriterRegistry?
  /// A three-state lifecycle rather than a `released` flag.
  ///
  /// The middle state is the one that matters: `close` flushes before it lets
  /// go, and with only a boolean the handle stayed fully usable throughout that
  /// flush — new appends and even a purge could start while shutdown was
  /// already under way. Entering `closing` first shuts the door before any of
  /// the waiting begins.
  private enum State { case active, closing, released }

  /// A condition rather than a plain lock, because a purge must be waited *out*
  /// rather than waited *behind*.
  ///
  /// A purge can legitimately run for its full deadline — tens of seconds on a
  /// slow volume. Holding this lock for that whole span would make every other
  /// entry point inherit that wait, and `close`, which has a deadline of its
  /// own to keep, would blow straight through it. So the purge marks itself
  /// with `purging` and drops the lock; anyone who genuinely cannot proceed
  /// alongside it waits on the condition under their own bound.
  private let condition = MonotonicCondition()
  private var generation: UInt64
  private var state: State = .active
  /// Set for the duration of `clearLogs`, so `close` can tell "a deletion is in
  /// flight" from "the handle is idle" without holding the lock across it.
  private var purging = false
  /// One collect at a time on THIS handle, mirroring `purging`.
  ///
  /// The writer's `collectLock` already refuses a second collect on the same
  /// writer, so this is not what makes the operation safe — it is what makes the
  /// refusal cheap and local. A second collect on one handle is answered here
  /// without touching the writer, without a flush, and without spending any of
  /// its deadline discovering it lost.
  private var collecting = false

  init(id: UInt64, writer: LogWriter, registry: LogWriterRegistry) {
    self.id = id
    self.writer = writer
    self.registry = registry
    self.generation = writer.currentGeneration
  }

  deinit {
    // Zero deadline: a deinit may be running during runtime teardown, where
    // blocking on a wedged disk is a hang the user sees as a frozen app. The
    // descriptor is closed either way.
    releaseNow(deadlineMs: 0)
  }

  public var filePath: String { writer.fileURL.path }

  /// The generation to write under, or `nil` once this handle is released.
  ///
  /// Releasing drops this handle's claim, but the writer itself lives on while
  /// any other handle holds it — so nothing about the writer stops a released
  /// handle from still working. Every operation checks here instead. The one
  /// that matters most is `clearLogs`: without this, a destination that was
  /// disposed minutes ago could delete the files that live destinations are
  /// writing to.
  private func liveGeneration() -> UInt64? {
    condition.lock()
    defer { condition.unlock() }
    return state == .active ? generation : nil
  }

  /// Reserves and enqueues a batch, **with the handle lock held across the
  /// call**.
  ///
  /// Reading the generation and then releasing the lock before appending leaves
  /// a window where `close` shuts the door, flushes, and returns `durable` — and
  /// only then does the append it never saw reach the writer and get accepted.
  /// Those records are outside the barrier that just promised everything was on
  /// disk. Holding the lock closes the window at no cost: `writer.append` only
  /// reserves bytes and enqueues, never touches the disk, and never reaches back
  /// for this lock.
  public func appendBatch(_ batch: String, entryCount: Int) -> LogAppendResult {
    condition.lock()
    defer { condition.unlock() }

    guard state == .active else {
      return LogAppendResult(
        accepted: false,
        rejectReason: .closed,
        status: LogSinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
      )
    }
    return writer.append(
      handleID: id, handleGeneration: generation, batch: batch, entryCount: entryCount
    )
  }

  public func status() -> LogSinkStatus {
    guard liveGeneration() != nil else {
      return LogSinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
    }
    return writer.status(handleID: id)
  }

  /// Housekeeping on demand — see `LogWriter.maintain`.
  ///
  /// Gated on the handle still being live for the same reason every other entry
  /// point here is: a released handle must not move files a writer another
  /// handle now owns.
  public func maintain(deadlineMs: Double) -> LogSinkStatus {
    guard liveGeneration() != nil else {
      return LogSinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
    }
    return writer.maintain(handleID: id, deadlineMs: deadlineMs)
  }

  /// Packs the logs into one gzip bundle — see `LogWriter.collectLogs`.
  ///
  /// Gated on liveness like every other entry point. A released handle
  /// collecting would read files a live handle is still rotating, and would
  /// write its bundle into that handle's directory.
  ///
  /// **`close` deliberately does not wait this out**, unlike `purging`. Closing
  /// waits out a purge because tearing the writer down mid-deletion leaves the
  /// fresh file missing. A collect only reads logs and writes its own scratch,
  /// and being abandoned is already a first-class, tested outcome — so a third
  /// wait on `close`'s budget would buy nothing and cost teardown latency.
  public func collectLogs(deadlineMs: Double, maxTotalBytes: Double) -> LogCollectOutcome {
    condition.lock()
    guard state == .active, !collecting else {
      condition.unlock()
      return .nothing
    }
    collecting = true
    condition.unlock()

    defer {
      condition.lock()
      collecting = false
      // Broadcast even though nothing waits on this today: `condition` is the
      // one place a waiter for any of this handle's state would sleep, and a
      // flag cleared without a wake is the shape that strands the first one
      // somebody adds.
      condition.broadcast()
      condition.unlock()
    }
    return writer.collectLogs(
      handleID: id, deadlineMs: deadlineMs, maxTotalBytes: maxTotalBytes)
  }

  public func flush(deadlineMs: Double) -> LogFlushOutcome {
    guard liveGeneration() != nil else {
      // Not `durable: true`. A released handle did not flush anything, and
      // saying otherwise invites a caller to treat its records as safe.
      return LogFlushOutcome(
        durable: false, timedOut: false, pendingBytes: 0,
        status: LogSinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
      )
    }
    return writer.flush(handleID: id, deadlineMs: deadlineMs)
  }

  public func logFilePaths() -> [String] {
    guard liveGeneration() != nil else { return [] }
    return writer.logFilePaths()
  }

  /// Deletes the support bundle — see `LogWriter.deleteSupportBundle`.
  ///
  /// Gated on liveness like every other entry point, and `false` when the gate
  /// refuses. But liveness is only half of it: `liveGeneration()` says this
  /// handle is active, not that it is current, so the generation travels down
  /// to the writer and is checked against the current one on the queue — the
  /// same two-part gate `appendBatch` applies, and for a sharper reason. A
  /// stale append adds a record to somebody else's file; a stale delete removes
  /// somebody else's bundle.
  public func deleteSupportBundle(deadlineMs: Double) -> Bool {
    guard let handleGeneration = liveGeneration() else { return false }
    return writer.deleteSupportBundle(
      handleGeneration: handleGeneration, deadlineMs: deadlineMs)
  }

  /// Deletes every artifact, then rebinds this handle **only if the purge was
  /// complete**.
  ///
  /// Rebinding on a partial deletion is the failure the ordering exists to
  /// prevent: writes would resume into a directory where deletion is still
  /// pending or has failed, and the records that landed there would be the ones
  /// the purge was supposed to guarantee were gone. Staying fenced costs new
  /// logs until an explicit retry; rebinding early costs the guarantee.
  ///
  /// The purge marks itself and drops the lock rather than holding it for the
  /// whole deletion. It is bounded by its own deadline, but that bound can be
  /// tens of seconds, and every other entry point — `close` above all, which
  /// has a deadline it has promised to keep — would otherwise inherit it. The
  /// generation fence, not this lock, is what keeps concurrent appends off a
  /// directory being deleted: the writer bumps it before the first `unlink`, so
  /// anything still holding the old one is refused as stale.
  public func clearLogs(deadlineMs: Double) -> LogClearOutcome {
    condition.lock()
    // A handle on its way out must not be able to delete files that live
    // destinations are writing to; and a second concurrent purge on this handle
    // would race the rebind below with nothing to arbitrate the two.
    guard state == .active, !purging else {
      condition.unlock()
      // Name the file. `failedPaths` means "artifacts this call did not remove
      // and which, as far as it can tell, are still there" — and on a refusal
      // nothing was deleted, so the log file certainly is. The writer's own
      // refusals already answer this way (`LogFileWriter.clearLogs` on purge-lock
      // contention and on a blown deadline), so an empty array here made the two
      // levels of the same class disagree about the same fact; Android named the
      // path at both. Bridge-observable: a `ClearOutcome.failedPaths` that was
      // empty now carries one path on this branch.
      return LogClearOutcome(
        deletedCount: 0, failedPaths: [writer.fileURL.path], durable: false)
    }
    purging = true
    condition.unlock()

    let result = writer.clearLogs(deadlineMs: deadlineMs)

    condition.lock()
    defer { condition.unlock() }
    purging = false
    // Broadcast unconditionally: a `close` may be waiting this purge out under
    // its own deadline, and it has to learn the deletion finished whether or
    // not the deletion succeeded.
    condition.broadcast()

    // Rebind only onto a writer that came back with a usable descriptor, and
    // only if this handle is still open. Deletion succeeding and the writer
    // being usable again are separate facts; adopting the new generation
    // without the second means accepting records into a writer that has nowhere
    // to put them, and adopting it after a `close` slipped in reopens a door
    // that was deliberately shut.
    //
    // Bind to the generation THIS purge established — never to whatever is
    // current by now. Another purge may have moved the fence on since, and
    // adopting its generation would authorise writes against a deletion still
    // in flight. Binding to a superseded generation is safe: the next append is
    // simply refused as stale, which is what a fenced handle should get.
    var outcome = result.outcome
    if state == .active, outcome.durable, outcome.rebound {
      generation = result.generation
    } else {
      // `rebound` is a fact about THIS handle, not about the writer, and the
      // two come apart exactly when a `close` gives up waiting for this purge:
      // the writer really did get a fresh descriptor, and this handle really is
      // never going to adopt it. Passing the writer's answer up would tell the
      // caller to resume a destination that has already been shut.
      outcome.rebound = false
    }
    return outcome
  }

  /// Shuts the handle and gives the writer back, inside **one** budget.
  ///
  /// Closing is three waits — out an in-flight purge, through the flush, then
  /// through the writer's own teardown — and a caller that asked for 200 ms
  /// meant 200 ms for the lot. Handing each step the full figure turns a
  /// deadline into a multiple of itself, which on the JS side is a dispose that
  /// blocks the runtime for three times as long as it promised.
  public func close(deadlineMs: Double) -> LogFlushOutcome {
    let expiry = DispatchTime.now() + .milliseconds(LogWriter.clampDeadline(deadlineMs))

    // Shut the door before doing any waiting: everything below can take the
    // whole budget, and nothing new should be able to start during it.
    condition.lock()
    guard state == .active else {
      condition.unlock()
      return LogFlushOutcome(
        durable: false, timedOut: false, pendingBytes: 0,
        status: LogSinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0)
      )
    }
    state = .closing

    // Let an in-flight deletion finish before tearing the writer down. Waiting
    // is worth something: a purge interrupted by the close barrier still
    // deletes, it just cannot reopen, so the fresh file is missing until the
    // next acquire. Waiting past the budget is worth nothing.
    while purging {
      if !condition.wait(until: expiry) { break }
    }
    condition.unlock()

    let outcome = writer.flush(handleID: id, deadlineMs: Self.remaining(until: expiry))
    releaseNow(deadlineMs: Self.remaining(until: expiry))
    return outcome
  }

  /// Milliseconds left, floored at zero — which the writer reads as "do not
  /// wait", not as "wait forever".
  private static func remaining(until expiry: DispatchTime) -> Double {
    let now = DispatchTime.now()
    guard expiry > now else { return 0 }
    return Double(expiry.uptimeNanoseconds - now.uptimeNanoseconds) / 1_000_000
  }

  private func releaseNow(deadlineMs: Double) {
    condition.lock()
    if state == .released {
      condition.unlock()
      return
    }
    state = .released
    condition.broadcast()
    condition.unlock()
    registry?.release(writer, handleID: id, deadlineMs: deadlineMs)
  }

  var writerForTesting: LogWriter { writer }
  var generationForTesting: UInt64 {
    condition.lock()
    defer { condition.unlock() }
    return generation
  }
}

// MARK: - Monotonic waiting

/// A condition variable whose timeout is measured with a clock nothing can move.
///
/// `NSCondition.wait(until:)` takes a `Date`, and `Date` is CLOCK_REALTIME. An
/// NTP correction or a user changing the device clock mid-wait changes how long
/// that wait lasts, and backwards is the dangerous direction: the wait does not
/// end until realtime catches up, so a 200 ms close budget becomes as long as
/// the step. That is a dispose blocking the JavaScript thread for a minute
/// because the clock moved. Forwards is quieter and still wrong — the wait ends
/// at once and a deadline silently becomes no wait at all.
///
/// **Slicing a realtime wait into short legs does not fix this.** Each leg is
/// still a realtime target, so a backward step stretches whichever leg it lands
/// in by the whole step; slicing bounds the forward case and leaves the one that
/// matters. The timeout has to not be expressed in realtime at all, which is
/// what `pthread_cond_timedwait_relative_np` is for: Darwin's relative-timeout
/// wait, unaffected by changes to the calendar clock. `DispatchTime` is the
/// deadline type that matches it, and is already what `LogWriter` uses for every
/// elapsed-time question it asks.
///
/// Darwin-only, which this target is: the package builds for iOS and macOS, and
/// the Android side reaches the same place through its own monotonic clock.
final class MonotonicCondition {
  private let mutex = UnsafeMutablePointer<pthread_mutex_t>.allocate(capacity: 1)
  private let cond = UnsafeMutablePointer<pthread_cond_t>.allocate(capacity: 1)

  init() {
    pthread_mutex_init(mutex, nil)
    pthread_cond_init(cond, nil)
  }

  deinit {
    pthread_mutex_destroy(mutex)
    pthread_cond_destroy(cond)
    mutex.deallocate()
    cond.deallocate()
  }

  func lock() { pthread_mutex_lock(mutex) }
  func unlock() { pthread_mutex_unlock(mutex) }
  func broadcast() { pthread_cond_broadcast(cond) }

  /// Waits until broadcast or until `deadline`. `false` means the deadline won.
  ///
  /// A spurious wakeup returns `true`, exactly as `NSCondition` does — every
  /// caller re-tests its predicate in a loop. The remaining time is re-derived
  /// from the monotonic clock on each pass, so repeated wakeups cannot stretch
  /// the total wait past the deadline.
  func wait(until deadline: DispatchTime) -> Bool {
    let now = DispatchTime.now()
    guard deadline > now else { return false }
    let remaining = deadline.uptimeNanoseconds - now.uptimeNanoseconds
    var timeout = timespec(
      tv_sec: Int(remaining / 1_000_000_000),
      tv_nsec: Int(remaining % 1_000_000_000)
    )
    return pthread_cond_timedwait_relative_np(cond, mutex, &timeout) == 0
  }
}
