import Foundation

// MARK: - Configuration

/// Rotation and retention for one log file.
///
/// Every field is clamped on the way in. These numbers arrive from JavaScript,
/// where `NaN`, `Infinity`, and `-1` are all ordinary values, and an unchecked
/// cast of any of them into a Swift integer traps — taking the app down from
/// inside the logger.
public struct LogRotationPolicy: Sendable, Equatable {
  /// Soft threshold. Overshoot is bounded by one batch, because the size is
  /// checked after a write rather than before.
  public var maxFileSizeBytes: UInt64
  /// Archives kept by count. Zero keeps none.
  public var maxArchivedFilesCount: Int
  /// Rotate the current file once this old regardless of size. Measured from
  /// the file's creation date, so it survives a restart.
  public var maxFileAgeSeconds: TimeInterval?
  public var compressArchives: Bool
  /// Delete archives older than this even when under the count cap.
  public var maxArchiveAgeSeconds: TimeInterval?
  /// Bound on the current file and all archives together.
  public var maxTotalLogBytes: UInt64?

  public init(
    maxFileSizeBytes: Double = 10_485_760,
    maxArchivedFilesCount: Double = 5,
    maxFileAgeSeconds: Double? = nil,
    compressArchives: Bool = false,
    maxArchiveAgeSeconds: Double? = nil,
    maxTotalLogBytes: Double? = nil
  ) {
    self.maxFileSizeBytes = LogRotationPolicy.bytes(maxFileSizeBytes, fallback: 10_485_760)
    self.maxArchivedFilesCount = LogRotationPolicy.count(maxArchivedFilesCount)
    self.maxFileAgeSeconds = LogRotationPolicy.seconds(maxFileAgeSeconds)
    self.compressArchives = compressArchives
    self.maxArchiveAgeSeconds = LogRotationPolicy.seconds(maxArchiveAgeSeconds)
    self.maxTotalLogBytes = LogRotationPolicy.optionalBytes(maxTotalLogBytes)
  }

  /// Effectively "no limit" while still fitting in the integer types below.
  private static let byteCeiling: UInt64 = 1_000_000_000_000_000
  private static let countCeiling = 10_000

  /// `Infinity` clamps UP, to the ceiling. It reads as "never rotate", and
  /// folding it into the default — or into zero — would turn a request for no
  /// rotation into constant rotation, or into deleting every archive. Only
  /// `NaN` and non-positive values fall back, because those carry no intent to
  /// honour.
  private static func bytes(_ value: Double, fallback: UInt64) -> UInt64 {
    if value.isNaN || value < 1 { return fallback }
    if value.isInfinite { return byteCeiling }
    return UInt64(min(value, Double(byteCeiling)))
  }

  private static func count(_ value: Double) -> Int {
    if value.isNaN || value < 0 { return 0 }
    if value.isInfinite { return countCeiling }
    return Int(min(value, Double(countCeiling)))
  }

  /// Optional limits read `Infinity` as absence: "no age cap" and "no cap at
  /// all" are the same instruction, and `nil` is how this type spells it.
  private static func seconds(_ value: Double?) -> TimeInterval? {
    guard let value, value.isFinite, value > 0 else { return nil }
    return min(value, 1e9)
  }

  private static func optionalBytes(_ value: Double?) -> UInt64? {
    guard let value, value.isFinite, value >= 1 else { return nil }
    return UInt64(min(value, Double(byteCeiling)))
  }
}

/// Payload-free record of what has stopped working.
///
/// A bitmask rather than messages on purpose: these cross into JavaScript and
/// eventually into a log file, and a path or an `errno` description is exactly
/// the kind of thing that carries a username in it.
public struct LogDegradation: OptionSet, Sendable {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }

  public static let rotation = LogDegradation(rawValue: 1 << 0)
  public static let gzip = LogDegradation(rawValue: 1 << 1)
  public static let prune = LogDegradation(rawValue: 1 << 2)
  public static let sidecar = LogDegradation(rawValue: 1 << 3)
  public static let protection = LogDegradation(rawValue: 1 << 4)
}

// MARK: - Results

public struct LogSinkStatus: Sendable {
  public var queuedBytes: Int
  public var lostBytes: Int
  public var lostEntries: Int
  public var degraded: Int
}

public enum LogRejectReason: String, Sendable {
  case full
  case staleGeneration
  case closed
  case failed
}

public struct LogAppendResult: Sendable {
  public var accepted: Bool
  public var rejectReason: LogRejectReason?
  public var status: LogSinkStatus
}

public struct LogFlushOutcome: Sendable {
  public var durable: Bool
  public var timedOut: Bool
  public var pendingBytes: Int
  public var status: LogSinkStatus
}

public struct LogClearOutcome: Sendable {
  public var deletedCount: Int
  public var failedPaths: [String]
  /// Every artifact is gone. This is the compliance question.
  public var durable: Bool
  /// The writer has a usable file again. Separate from `durable` because a
  /// complete deletion can still be followed by a failed reopen, and a caller
  /// that resumes on `durable` alone writes into a writer with nowhere to put
  /// anything.
  public var rebound: Bool = false
}

public enum LogWriterError: Error, Equatable {
  case openFailed(String)
  case configConflict
  case symlinkEscape
  /// A previous writer for this path has not finished shutting down. Retrying
  /// is reasonable; opening a second writer alongside it is not.
  case stillClosing
}

// MARK: - Writer

/// The thing that actually writes, one per canonical path.
///
/// Handles for the same file share it — see `LogWriterRegistry`. Batching,
/// drop policy, and loss notices all live in JavaScript; this side appends
/// pre-batched text, rotates, compresses, prunes, and keeps counters. It is
/// deliberately the dumb end.
///
/// **Two synchronisation domains, and the split is the whole design.**
/// `stateLock` guards counters and the handle swap and is never held across
/// I/O; the serial `queue` owns every byte that touches the disk. That is what
/// makes `status()` answerable while the writer thread is stalled on a disk
/// that has stopped responding — which the JavaScript side depends on, because
/// its backpressure loop polls exactly then.
///
/// **Accepted bytes stay reserved until the write terminally completes.** The
/// cap is on bytes in flight, not bytes enqueued, so a burst cannot queue a
/// gigabyte behind a slow disk by virtue of each individual batch fitting.
public final class LogWriter {
  /// Hard cap on payload bytes in flight. Documented as a payload bound: the
  /// process still holds `Data` copies and queue blocks on top of it.
  static let hardCapBytes = 1_048_576
  /// Reads used to find the last record boundary during a startup trim.
  private static let tailScanWindow = 1 << 20
  /// Consecutive `EINTR`/`EAGAIN` retries before a write is called failed.
  private static let maxWriteRetries = 16
  /// Successful writes between descriptor-liveness checks.
  private static let healthCheckStride = 8
  /// How long a failed rotation waits before being attempted again.
  private static let rotationBackoff: TimeInterval = 5
  /// How long a failed reopen waits.
  private static let reopenBackoff: TimeInterval = 1
  /// Longest any deadline-bounded call will wait. Well short of the watchdog
  /// window a synchronous crash-path flush has to live inside.
  private static let MAX_DEADLINE_MS = 30_000

  /// The raw write, injectable so short writes and hard failures can be tested
  /// without a real disk that misbehaves on demand. Production passes `nil`.
  public typealias RawWrite = (Int32, UnsafeRawPointer, Int) -> Int

  /// Archive compression, injectable for the same reason: the interesting case
  /// is the one where it fails, and a real gzip failure needs a full disk.
  public typealias Compressor = (URL, URL) -> Bool

  public let fileURL: URL
  public let canonicalPath: String
  let policy: LogRotationPolicy
  let lineFramed: Bool

  private let queue: DispatchQueue
  private let queueKey = DispatchSpecificKey<Bool>()
  private let rawWrite: RawWrite
  private let compressor: Compressor

  // MARK: State behind `stateLock` — cheap, never held across I/O

  private let stateLock = NSLock()
  /// Held for the whole of `clearLogs`, so purges cannot interleave.
  private let purgeLock = NSLock()
  private var reservedBytes = 0
  private var generation: UInt64 = 1
  private var closed = false
  private var degraded = LogDegradation()
  private var loss: [UInt64: (entries: Int, bytes: Int)] = [:]
  private var lastSyncSucceeded = true
  /// Handles currently holding this writer. The registry evicts at zero.
  private(set) var refCount = 0

  // MARK: State confined to `queue`

  private var handle: FileHandle?
  private var descriptor: Int32 = -1
  private var currentFileSize: UInt64 = 0
  private var currentFileStart = Date()
  private var lastReopenAttempt = Date.distantPast
  private var rotationBlockedUntil = Date.distantPast
  private var writesSinceHealthCheck = 0
  /// Set by the close barrier, on this queue. Everything enqueued before the
  /// barrier still writes; everything after it is refused.
  private var terminated = false
  /// Rotations that got past the backoff guard. Test support for asserting the
  /// backoff actually backs off.
  private var rotationAttempts = 0

  init(
    fileURL: URL,
    canonicalPath: String,
    policy: LogRotationPolicy,
    lineFramed: Bool,
    rawWrite: RawWrite? = nil,
    compressor: Compressor? = nil
  ) throws {
    self.fileURL = fileURL
    self.canonicalPath = canonicalPath
    self.policy = policy
    self.lineFramed = lineFramed
    self.rawWrite = rawWrite ?? { fd, buffer, count in write(fd, buffer, count) }
    self.compressor = compressor ?? { source, destination in
      #if canImport(Compression)
      return Gzip.compressFile(at: source, to: destination)
      #else
      return false
      #endif
    }
    self.queue = DispatchQueue(label: "com.nitrologger.filewriter")
    queue.setSpecific(key: queueKey, value: true)

    let shortfall = try LogSecureFile.createDirectory(at: fileURL.deletingLastPathComponent())
    if !shortfall.isEmpty { degraded.insert(.protection) }
    guard let opened = Self.openForAppending(at: fileURL) else {
      throw LogWriterError.openFailed("could not open the log file")
    }
    if !opened.shortfall.isEmpty { degraded.insert(.protection) }
    handle = opened.handle
    descriptor = opened.descriptor
    currentFileSize = Self.size(of: opened.descriptor)
    currentFileStart = Self.creationDate(of: fileURL)

    trimTornTailIfFramed()
    sweepRetention()
  }

  deinit {
    let live = handle
    handle = nil
    try? live?.synchronize()
    try? live?.close()
  }

  // MARK: - Reference counting (registry-owned, called under the registry lock)

  func retain() { refCount += 1 }
  func releaseOne() -> Int {
    refCount -= 1
    return refCount
  }

  // MARK: - Opening

  /// Opens for appending, creating if needed. Every open funnels through here.
  ///
  /// `O_APPEND` makes each write land atomically at the current end of file
  /// whatever else wrote in between. Without it a second descriptor on the
  /// same file — a replaced destination draining late, a stale handle after a
  /// rotation — writes from its own stale offset and silently overwrites. It
  /// also means a straggler that missed a rotation appends to the archive
  /// rather than corrupting the fresh file.
  ///
  /// **`O_NOFOLLOW` and `O_CREAT` in one call is the point.** Checking the path
  /// with `lstat` and opening it afterwards leaves a window: something can
  /// replace the file with a symlink in between, and the writer then follows it
  /// out of the directory the registry believes it owns — writing the app's log
  /// somewhere no purge will ever clean. One syscall closes the window, and the
  /// `fstat` afterwards rejects anything that is not a regular file, so a FIFO
  /// left in place cannot wedge the writer on open either.
  ///
  /// The mode is applied through the descriptor rather than the path for the
  /// same reason — `fchmod` acts on the file already held.
  ///
  /// **`O_NONBLOCK` is not optional here.** `O_NOFOLLOW` refuses a symlink but
  /// says nothing about a FIFO, and opening a FIFO for writing blocks until
  /// someone opens the read end — forever, in practice, taking the app's whole
  /// startup with it, since this runs during `init`. Opening non-blocking makes
  /// the call return so the `fstat` below can reject anything that is not a
  /// regular file. The flag is cleared afterwards because it has no useful
  /// meaning for the regular file that survives the check.
  private static func openForAppending(
    at url: URL
  ) -> (handle: FileHandle, descriptor: Int32, shortfall: LogSecureFile.Shortfall)? {
    // `O_RDWR`, not `O_WRONLY`: the startup tail scan reads through this exact
    // descriptor so that the offsets it computes and the `ftruncate` it applies
    // are guaranteed to concern the same inode. `pread` on a write-only
    // descriptor fails with `EBADF`, which would silently skip crash recovery.
    let fd = Darwin.open(
      url.path,
      O_RDWR | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC,
      mode_t(LogSecureFile.fileMode)
    )
    guard fd >= 0 else { return nil }

    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
      Darwin.close(fd)
      return nil
    }

    let flags = fcntl(fd, F_GETFL)
    if flags >= 0 { _ = fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) }

    let shortfall = LogSecureFile.secure(descriptor: fd, at: url)

    // The descriptor must still be reachable under the name it was opened by.
    // Everything downstream addresses this file by path — rotation renames it,
    // retention counts it, purge deletes it — so a descriptor whose name has
    // been taken over or unlinked is one writing into a file no part of this
    // package can ever find again. That is worth refusing on its own, entirely
    // apart from whether the protections stuck: `secure(descriptor:)` answers
    // that question through the descriptor now, and cannot be fooled by a name.
    guard LogSecureFile.namesSameFile(url, as: info) else {
      Darwin.close(fd)
      return nil
    }
    return (FileHandle(fileDescriptor: fd, closeOnDealloc: true), fd, shortfall)
  }

  private static func size(of descriptor: Int32) -> UInt64 {
    var info = stat()
    guard descriptor >= 0, fstat(descriptor, &info) == 0 else { return 0 }
    return UInt64(max(0, info.st_size))
  }

  private static func creationDate(of url: URL) -> Date {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.creationDate] as? Date) ?? Date()
  }

  /// Cuts a torn trailing record left by a crash — but only when the producer
  /// has declared that records are newline-framed.
  ///
  /// Without that declaration the trailing bytes are indistinguishable from a
  /// record that simply contains newlines, and trimming would eat good data to
  /// tidy up after a crash that may not have happened. Absent the guarantee the
  /// file is left exactly as it was found.
  /// Reads through `descriptor` — the very one it will truncate.
  ///
  /// Opening the path again for reading would mean deriving offsets from
  /// whatever the name points at now and applying them to the file the writer
  /// holds. A rename in between and `ftruncate` cuts the log at an offset
  /// computed from something else entirely. `pread` also needs no seeking, so
  /// it cannot disturb the append position.
  private func trimTornTailIfFramed() {
    guard lineFramed, descriptor >= 0, currentFileSize > 0 else { return }

    var tail = [UInt8](repeating: 0, count: 1)
    guard pread(descriptor, &tail, 1, off_t(currentFileSize - 1)) == 1 else { return }
    if tail[0] == 0x0A { return } // already on a record boundary

    // Scan backwards a window at a time rather than giving up after one.
    // A single fixed window is wrong in both directions: a record larger than
    // the window hides its own preceding boundary, and a file whose only
    // content is one incomplete record has no boundary at all.
    let window = UInt64(Self.tailScanWindow)
    var end = currentFileSize
    var keep: UInt64?
    var buffer = [UInt8](repeating: 0, count: Self.tailScanWindow)

    while end > 0 {
      let start = end > window ? end - window : 0
      let wanted = Int(end - start)
      let read = pread(descriptor, &buffer, wanted, off_t(start))
      guard read == wanted else { return }
      if let offset = buffer[0..<wanted].lastIndex(of: 0x0A) {
        keep = start + UInt64(offset) + 1
        break
      }
      end = start
    }

    // No newline in the whole file. Under a *declared* framing contract that is
    // not ambiguous — every record ends in one, so a file without any contains
    // no complete record and all of it is torn. (Without the declaration this
    // routine never runs, which is where the ambiguity actually lives.)
    let target = keep ?? 0
    guard target < currentFileSize else { return }
    guard ftruncate(descriptor, off_t(target)) == 0 else { return }
    currentFileSize = target
  }

  // MARK: - Appending

  /// Accept or refuse a batch, then write it on the queue.
  ///
  /// The decision is made entirely under `stateLock` and before anything is
  /// enqueued, so the cap holds no matter how many threads are calling: two
  /// batches that each fit but do not fit together cannot both be accepted.
  func append(
    handleID: UInt64,
    handleGeneration: UInt64,
    batch: String,
    entryCount: Int
  ) -> LogAppendResult {
    let data = Data(batch.utf8)
    let bytes = data.count

    stateLock.lock()
    if closed {
      return rejectUnlocking(.closed, handleID)
    }
    if handleGeneration != generation {
      return rejectUnlocking(.staleGeneration, handleID)
    }
    // Validated on both sides of the bridge. An entry count that disagrees
    // with the payload makes every loss number downstream a guess.
    if entryCount < 0 || entryCount > 1_000_000 {
      return rejectUnlocking(.failed, handleID)
    }
    if (bytes == 0) != (entryCount == 0) {
      return rejectUnlocking(.failed, handleID)
    }
    if bytes == 0 {
      // Nothing to do, and nothing to complain about.
      let status = statusLocked(handleID)
      stateLock.unlock()
      return LogAppendResult(accepted: true, rejectReason: nil, status: status)
    }
    if reservedBytes + bytes > Self.hardCapBytes {
      return rejectUnlocking(.full, handleID)
    }
    reservedBytes += bytes
    let status = statusLocked(handleID)
    stateLock.unlock()

    queue.async { [self] in
      performWrite(data, handleID: handleID, entryCount: entryCount, generation: handleGeneration)
    }
    return LogAppendResult(accepted: true, rejectReason: nil, status: status)
  }

  private func rejectUnlocking(_ reason: LogRejectReason, _ handleID: UInt64) -> LogAppendResult {
    let status = statusLocked(handleID)
    stateLock.unlock()
    return LogAppendResult(accepted: false, rejectReason: reason, status: status)
  }

  private func performWrite(_ data: Data, handleID: UInt64, entryCount: Int, generation: UInt64) {
    defer { release(bytes: data.count) }

    if terminated {
      // Past the close barrier. Anything reaching here was accepted, missed
      // the flush, and has no descriptor left to go to — reopening one would
      // resurrect a writer the caller has finished with. It is counted lost
      // rather than dropped silently, which matches the `durable: false` and
      // non-zero `pendingBytes` that close already reported.
      //
      // The flag is set BY the close barrier, on this queue, rather than by
      // `close` up front: the serial queue then guarantees that every batch
      // enqueued before the barrier still writes normally. Checking `closed`
      // here instead would discard exactly the records a close is supposed to
      // flush out.
      record(loss: entryCount, bytes: data.count, for: handleID)
      return
    }

    stateLock.lock()
    let stale = generation != self.generation
    stateLock.unlock()
    if stale {
      // A purge landed between acceptance and here. These bytes belong to a
      // file that was deliberately deleted, so they are dropped WITHOUT being
      // counted as loss: writing them into the fresh file would resurrect
      // pre-purge data, and reporting them would describe a gap the user asked
      // for. The JavaScript side baselines its own cursors across a purge for
      // the same reason.
      return
    }

    guard writableHandle() != nil else {
      record(loss: entryCount, bytes: data.count, for: handleID)
      return
    }

    // The true end of file, not a tracked counter: it is what a partial write
    // has to be rolled back to, and being wrong about it means truncating
    // somebody else's bytes.
    let offsetBefore = Self.size(of: descriptor)
    do {
      try writeAll(data)
      currentFileSize = offsetBefore + UInt64(data.count)
      healthCheckPeriodically()
      rotateIfNeeded()
    } catch {
      // Roll back to the record boundary the batch started at. A half-written
      // batch is a half-written record, and a half-written record makes the
      // rest of the file unparseable from that point on — the loss would
      // spread from one batch to everything after it.
      if ftruncate(descriptor, off_t(offsetBefore)) == 0 {
        currentFileSize = offsetBefore
      }
      record(loss: entryCount, bytes: data.count, for: handleID)
      invalidateHandleIfUnlinked()
    }
  }

  /// Writes every byte or throws.
  ///
  /// `write(2)` is allowed to write less than it was asked for, and treating a
  /// short write as success is how a log file ends up with a record missing its
  /// second half. `EINTR` and `EAGAIN` are retried a bounded number of times;
  /// anything else is terminal.
  private func writeAll(_ data: Data) throws {
    var written = 0
    var retries = 0
    try data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      while written < data.count {
        let n = rawWrite(descriptor, base + written, data.count - written)
        if n > 0 {
          written += n
          retries = 0
          continue
        }
        if n < 0 && (errno == EINTR || errno == EAGAIN) {
          retries += 1
          if retries > Self.maxWriteRetries {
            throw LogWriterError.openFailed("write kept being interrupted")
          }
          continue
        }
        throw LogWriterError.openFailed("write failed")
      }
    }
  }

  // MARK: - Handle liveness (queue only)

  private func writableHandle() -> FileHandle? {
    if let handle { return handle }
    guard Date().timeIntervalSince(lastReopenAttempt) >= Self.reopenBackoff else { return nil }
    attemptReopen()
    return handle
  }

  @discardableResult
  private func attemptReopen() -> Bool {
    lastReopenAttempt = Date()
    closeCurrentHandle()

    if let shortfall = try? LogSecureFile.createDirectory(at: fileURL.deletingLastPathComponent()) {
      if !shortfall.isEmpty { note(.protection) }
    } else {
      return false
    }
    guard let opened = Self.openForAppending(at: fileURL) else {
      // Reset the rotation triggers even though nothing opened. Leaving the
      // size above the threshold makes every later write re-enter rotation,
      // which archives the file again and again until pruning has eaten every
      // real archive.
      currentFileSize = 0
      currentFileStart = Date()
      writesSinceHealthCheck = 0
      return false
    }
    if !opened.shortfall.isEmpty { note(.protection) }
    handle = opened.handle
    descriptor = opened.descriptor
    currentFileSize = Self.size(of: opened.descriptor)
    currentFileStart = Self.creationDate(of: fileURL)
    writesSinceHealthCheck = 0
    return true
  }

  private func closeCurrentHandle() {
    if let stale = handle { try? stale.close() }
    handle = nil
    descriptor = -1
  }

  /// Confirms the descriptor still points at a file anyone can read.
  ///
  /// Writes to an unlinked inode succeed forever and land nowhere. No error is
  /// raised, so without this an externally deleted log file means silent loss
  /// for the rest of the process's life. `st_nlink == 0` catches the plain
  /// delete and the delete-then-recreate that a path-existence check misses.
  private func healthCheckPeriodically() {
    writesSinceHealthCheck += 1
    guard writesSinceHealthCheck >= Self.healthCheckStride else { return }
    writesSinceHealthCheck = 0
    invalidateHandleIfUnlinked()
  }

  private func invalidateHandleIfUnlinked() {
    guard descriptor >= 0 else { return }
    var info = stat()
    if fstat(descriptor, &info) == 0 && info.st_nlink > 0 { return }
    attemptReopen()
  }

  // MARK: - Status, flush, close

  func status(handleID: UInt64) -> LogSinkStatus {
    stateLock.lock()
    defer { stateLock.unlock() }
    return statusLocked(handleID)
  }

  private func statusLocked(_ handleID: UInt64) -> LogSinkStatus {
    let totals = loss[handleID] ?? (entries: 0, bytes: 0)
    return LogSinkStatus(
      queuedBytes: reservedBytes,
      lostBytes: totals.bytes,
      lostEntries: totals.entries,
      degraded: degraded.rawValue
    )
  }

  /// Drains and fsyncs, bounded by wall clock.
  ///
  /// The barrier is enqueued behind whatever the queue is already doing, so a
  /// writer wedged mid-write times out here rather than blocking the caller
  /// forever — which on the crash path is the difference between a partial log
  /// and a watchdog kill.
  func flush(handleID: UInt64, deadlineMs: Double) -> LogFlushOutcome {
    flush(handleID: handleID, deadline: .now() + .milliseconds(Self.clampDeadline(deadlineMs)))
  }

  /// The absolute-deadline form, so a caller that has to do more than one
  /// bounded wait can spend a single budget across all of them.
  private func flush(handleID: UInt64, deadline: DispatchTime) -> LogFlushOutcome {
    var timedOut = false

    if DispatchQueue.getSpecific(key: queueKey) == true {
      // Already on the write queue. Enqueueing and waiting here would be a
      // deadlock against ourselves — the barrier could never run until we
      // returned. Run it inline instead; ordering is preserved either way,
      // because nothing enqueued after us has started.
      syncNow()
    } else {
      let group = DispatchGroup()
      group.enter()
      queue.async { [self] in
        syncNow()
        group.leave()
      }
      timedOut = group.wait(timeout: deadline) == .timedOut
    }

    stateLock.lock()
    let status = statusLocked(handleID)
    let pending = reservedBytes
    let synced = lastSyncSucceeded
    stateLock.unlock()

    return LogFlushOutcome(
      durable: !timedOut && pending == 0 && synced,
      timedOut: timedOut,
      pendingBytes: pending,
      status: status
    )
  }

  /// Queue-confined. Records whether the data actually reached storage, which
  /// is the difference between `durable` and "we asked".
  private func syncNow() {
    guard let handle else {
      stateLock.lock(); lastSyncSucceeded = false; stateLock.unlock()
      return
    }
    let ok = (try? handle.synchronize()) != nil
    stateLock.lock(); lastSyncSucceeded = ok; stateLock.unlock()
  }

  /// Flushes, then closes the descriptor — both inside ONE budget.
  ///
  /// The deadline is computed once, at entry. Giving the flush the full budget
  /// and then the close barrier the full budget again means a stalled writer
  /// blocks for twice what the caller asked for, which at the 30-second ceiling
  /// is a minute of a synchronous teardown doing nothing.
  /// `onTerminated` runs on the write queue once the descriptor is really shut,
  /// **regardless of whether this call waited that long**.
  ///
  /// The two are deliberately decoupled. The caller's deadline bounds how long
  /// it blocks; the callback reports when the writer actually stopped. The
  /// registry needs the second, not the first — releasing a path because a
  /// close *gave up waiting* would let a replacement writer open the same file
  /// while this one still has a write executing.
  func close(
    handleID: UInt64,
    deadlineMs: Double,
    onTerminated: (() -> Void)? = nil
  ) -> LogFlushOutcome {
    let deadline = DispatchTime.now() + .milliseconds(Self.clampDeadline(deadlineMs))

    stateLock.lock()
    closed = true
    stateLock.unlock()

    let outcome = flush(handleID: handleID, deadline: deadline)

    let group = DispatchGroup()
    group.enter()
    queue.async { [self] in
      terminated = true
      closeCurrentHandle()
      onTerminated?()
      group.leave()
    }
    // Whatever the flush left of the budget, and nothing more. A deadline
    // already in the past makes this return at once rather than wait afresh.
    _ = group.wait(timeout: deadline)
    return outcome
  }

  /// `Infinity` means "wait as long as you are allowed to", which is the
  /// ceiling — not zero. `NaN` and non-positive values mean no waiting, which
  /// is also what a caller passing `0` deliberately asks for.
  static func clampDeadline(_ value: Double) -> Int {
    if value.isNaN || value <= 0 { return 0 }
    if value.isInfinite { return MAX_DEADLINE_MS }
    return Int(min(value, Double(MAX_DEADLINE_MS)))
  }

  private func release(bytes: Int) {
    stateLock.lock()
    reservedBytes = max(0, reservedBytes - bytes)
    stateLock.unlock()
  }

  private func record(loss entries: Int, bytes: Int, for handleID: UInt64) {
    guard entries > 0 || bytes > 0 else { return }
    stateLock.lock()
    var totals = loss[handleID] ?? (entries: 0, bytes: 0)
    totals.entries += entries
    totals.bytes += bytes
    loss[handleID] = totals
    stateLock.unlock()
  }

  private func note(_ flag: LogDegradation) {
    stateLock.lock()
    degraded.insert(flag)
    stateLock.unlock()
  }

  // MARK: - Rotation (queue only)

  private func rotateIfNeeded() {
    guard let live = handle else { return }
    guard Date() >= rotationBlockedUntil else { return }
    let tooBig = currentFileSize >= policy.maxFileSizeBytes
    let tooOld = policy.maxFileAgeSeconds.map {
      Date().timeIntervalSince(currentFileStart) >= $0
    } ?? false
    guard tooBig || tooOld else { return }
    rotationAttempts += 1

    try? live.synchronize()
    closeCurrentHandle()

    let archiveURL = fileURL
      .deletingLastPathComponent()
      .appendingPathComponent("\(fileURL.lastPathComponent).\(Self.rotationStamp())")

    do {
      try FileManager.default.moveItem(at: fileURL, to: archiveURL)
    } catch {
      // Back off. A rotation that fails on every write — a read-only volume,
      // a directory someone removed — would otherwise retry on every single
      // batch, turning a degraded log into a busy one.
      note(.rotation)
      rotationBlockedUntil = Date().addingTimeInterval(Self.rotationBackoff)
      attemptReopen()
      return
    }
    if !LogSecureFile.secure(archiveURL).isEmpty { note(.protection) }

    if policy.compressArchives {
      compress(archiveURL)
    }
    sweepRetention()
    attemptReopen()
  }

  /// Replaces `url` with a gzipped copy, keeping the original if anything goes
  /// wrong: a bigger archive beats a lost one.
  ///
  /// Compression writes to a `.part` staging name and renames on success, so
  /// an interruption leaves something the purge recognises rather than a
  /// plausible-looking `.gz` that no tool can open.
  private func compress(_ url: URL) {
    let finalURL = URL(fileURLWithPath: url.path + ".gz")
    let stagingURL = URL(fileURLWithPath: finalURL.path + ".part")
    try? FileManager.default.removeItem(at: stagingURL)

    guard compressor(url, stagingURL) else {
      try? FileManager.default.removeItem(at: stagingURL)
      note(.gzip)
      return
    }
    if !LogSecureFile.secure(stagingURL).isEmpty { note(.protection) }
    do {
      try FileManager.default.moveItem(at: stagingURL, to: finalURL)
    } catch {
      try? FileManager.default.removeItem(at: stagingURL)
      note(.gzip)
      return
    }
    if !LogSecureFile.secure(finalURL).isEmpty { note(.protection) }
    do {
      try FileManager.default.removeItem(at: url)
    } catch {
      // The plaintext original survived alongside the compressed copy. Remove
      // the compressed one instead of leaving two: a plaintext log the caller
      // believes was compressed away is a file nobody remembers to delete.
      try? FileManager.default.removeItem(at: finalURL)
      note(.gzip)
    }
  }

  /// `<base>.YYYYMMDDTHHMMSSZ_<8 hex>`.
  ///
  /// Spelled out rather than left to `ISO8601DateFormatter` so the produced
  /// name and `isArchiveName` cannot drift apart across OS versions — a purge
  /// that stops recognising its own archives is a silent compliance failure.
  /// The random suffix disambiguates rotations inside the same second, which
  /// the one-second stamp cannot.
  private static let stampFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
    return formatter
  }()

  private static func rotationStamp() -> String {
    let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8).lowercased()
    return "\(stampFormatter.string(from: Date()))_\(suffix)"
  }

  // MARK: - Retention (queue only)

  /// Applies all three retention limits. Runs at open and after each rotation.
  ///
  /// No background timer: an idle process writes nothing, so there is nothing
  /// to sweep, and a timer that fires in the background is a wakeup the app
  /// pays for. An active process rotates, and rotation sweeps.
  private func sweepRetention() {
    let directory = fileURL.deletingLastPathComponent()
    let baseName = fileURL.lastPathComponent
    var archives = Self.archives(in: directory, baseName: baseName)
    let fm = FileManager.default
    var failed = false

    func remove(_ entry: Artifact) {
      do { try fm.removeItem(at: entry.url) } catch { failed = true }
    }

    // Orphaned compressions first. A `.part` is a gzip that was interrupted —
    // by a crash, or by a process that died mid-rotation — and nothing will
    // ever finish it. Compression runs on this same queue, so a staging file
    // seen from here is never one being written.
    for name in ((try? fm.contentsOfDirectory(atPath: directory.path)) ?? [])
    where Self.isStagingName(name, baseName: baseName) {
      do { try fm.removeItem(at: directory.appendingPathComponent(name)) } catch { failed = true }
    }

    // Oldest first for age, then count, then total size — each pass works on
    // what the previous one left.
    if let maxAge = policy.maxArchiveAgeSeconds {
      let cutoff = Date().addingTimeInterval(-maxAge)
      let expired = archives.filter { $0.modified < cutoff }
      expired.forEach(remove)
      archives.removeAll { entry in expired.contains { $0.url == entry.url } }
    }

    if archives.count > policy.maxArchivedFilesCount {
      let excess = Array(archives[policy.maxArchivedFilesCount...])
      excess.forEach(remove)
      archives.removeAll { entry in excess.contains { $0.url == entry.url } }
    }

    if let cap = policy.maxTotalLogBytes {
      var total = currentFileSize + archives.reduce(0) { $0 + $1.size }
      // Newest-first order, so dropping from the end sheds the oldest.
      while total > cap, let oldest = archives.popLast() {
        remove(oldest)
        total = total > oldest.size ? total - oldest.size : 0
      }
    }

    if failed { note(.prune) }
  }

  struct Artifact {
    let url: URL
    let modified: Date
    let size: UInt64
  }

  /// Archives for `baseName`, newest first.
  ///
  /// Ordered by modification date rather than by name. The name's timestamp
  /// has one-second resolution, so a burst of rotations inside the same second
  /// all share it and only the random suffix differs — sorting by name would
  /// keep an arbitrary subset and delete newer archives than it kept. Names
  /// break exact date ties so the order is still deterministic.
  static func archives(in directory: URL, baseName: String) -> [Artifact] {
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
    guard let contents = try? FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: keys
    ) else { return [] }

    return contents
      .filter { isArchiveName($0.lastPathComponent, baseName: baseName) }
      .map { url -> Artifact in
        let values = try? url.resourceValues(forKeys: Set(keys))
        return Artifact(
          url: url,
          modified: values?.contentModificationDate ?? .distantPast,
          size: UInt64(values?.fileSize ?? 0)
        )
      }
      .sorted { a, b in
        if a.modified != b.modified { return a.modified > b.modified }
        return a.url.lastPathComponent > b.url.lastPathComponent
      }
  }

  /// A finished archive: `<base>.<stamp>` or `<base>.<stamp>.gz`.
  ///
  /// Deliberately excludes `.part`. A staging file is a compression that was
  /// interrupted — counting it as an archive would let it occupy a retention
  /// slot that a real archive should have, and would hand a truncated gzip to
  /// anyone calling `getLogFilePaths()` to collect logs for support.
  static func isArchiveName(_ name: String, baseName: String) -> Bool {
    matches(name, baseName: baseName, pattern: #"^\d{8}T\d{6}Z_[a-f0-9]{8}(\.gz)?$"#)
  }

  /// A gzip staging file, `<base>.<stamp>.gz.part`.
  static func isStagingName(_ name: String, baseName: String) -> Bool {
    matches(name, baseName: baseName, pattern: #"^\d{8}T\d{6}Z_[a-f0-9]{8}\.gz\.part$"#)
  }

  /// Everything this writer can ever put on disk under its directory: the
  /// active file, the sidecar, every archive, every gzip staging file.
  ///
  /// This predicate IS the naming scheme, and `clearLogs` is the reason it is
  /// written down in one place. A purge that recognises fewer names than
  /// rotation can produce leaves survivors — and an interrupted compression
  /// leaving a plaintext orphan that outlives a compliance purge is exactly the
  /// failure this is here to prevent.
  static func isArtifactName(_ name: String, baseName: String) -> Bool {
    if name == baseName { return true }
    if name == baseName + ".meta" { return true }
    return isArchiveName(name, baseName: baseName) || isStagingName(name, baseName: baseName)
  }

  private static func matches(_ name: String, baseName: String, pattern: String) -> Bool {
    let prefix = baseName + "."
    guard name.hasPrefix(prefix) else { return false }
    let suffix = String(name.dropFirst(prefix.count))
    return suffix.range(of: pattern, options: .regularExpression) != nil
  }

  func logFilePaths() -> [String] {
    let directory = fileURL.deletingLastPathComponent()
    var paths = [fileURL.path]
    paths.append(contentsOf: Self.archives(in: directory, baseName: fileURL.lastPathComponent).map(\.url.path))
    return paths
  }

  // MARK: - Purge

  /// Deletes every artifact and fences every handle.
  ///
  /// The generation bumps FIRST and unconditionally. Anything still in flight
  /// is dropped when it reaches the queue, and any handle that has not rebound
  /// is refused — so a deletion still running cannot race a fresh write, and a
  /// partial deletion leaves everyone fenced rather than half of them writing
  /// into files that are about to disappear.
  ///
  /// Only a complete deletion reopens the file. The caller rebinds on
  /// `durable && rebound`, and on anything else stays fenced until it retries.
  func clearLogs(deadlineMs: Double) -> (outcome: LogClearOutcome, generation: UInt64) {
    // The budget starts HERE, before waiting for anything. Computing it after
    // acquiring the lock would let a caller asking for 100 ms sit behind
    // another purge's full 30 seconds and still believe it was given 100.
    let budget = Self.clampDeadline(deadlineMs)
    let deadline = DispatchTime.now() + .milliseconds(budget)

    // One purge at a time per writer. Two overlapping purges each bump the
    // generation, and the first to finish would otherwise report success for a
    // fence the second has already moved — handing its caller permission to
    // write while a deletion is still in flight.
    guard purgeLock.lock(before: Date().addingTimeInterval(Double(budget) / 1000)) else {
      stateLock.lock()
      let current = generation
      stateLock.unlock()
      return (
        LogClearOutcome(deletedCount: 0, failedPaths: [fileURL.path], durable: false),
        current
      )
    }
    defer { purgeLock.unlock() }

    stateLock.lock()
    generation &+= 1
    let fenced = generation
    loss.removeAll()
    degraded = LogDegradation()
    stateLock.unlock()

    var outcome = LogClearOutcome(deletedCount: 0, failedPaths: [], durable: false)
    let group = DispatchGroup()
    group.enter()
    queue.async { [self] in
      defer { group.leave() }
      closeCurrentHandle()

      let fm = FileManager.default
      let directory = fileURL.deletingLastPathComponent()
      let baseName = fileURL.lastPathComponent

      // An unreadable directory is NOT an empty one. Swallowing the error and
      // sweeping an empty list would report a durable purge while every
      // artifact sat untouched behind a permissions or I/O failure — the worst
      // possible lie for this particular call to tell.
      let names: [String]
      var directoryAbsent = false
      do {
        names = try fm.contentsOfDirectory(atPath: directory.path)
      } catch {
        // `fileExists` returning false is not proof of absence — it answers
        // false for a permissions failure, an I/O error, and a dozen other
        // lookups that never got far enough to tell. Only `ENOENT` actually
        // means "there is nothing here"; treating anything else as empty is
        // how a purge reports success over artifacts it never even saw.
        var info = stat()
        if lstat(directory.path, &info) != 0 && errno == ENOENT {
          names = []
          directoryAbsent = true
        } else {
          outcome = LogClearOutcome(
            deletedCount: 0, failedPaths: [directory.path], durable: false)
          return
        }
      }

      var deleted = 0
      var failures: [String] = []
      for name in names where Self.isArtifactName(name, baseName: baseName) {
        let target = directory.appendingPathComponent(name)
        do {
          try fm.removeItem(at: target)
          deleted += 1
        } catch {
          // The path is this package's own artifact name, not user content.
          failures.append(target.path)
        }
      }

      guard failures.isEmpty else {
        outcome = LogClearOutcome(
          deletedCount: deleted, failedPaths: failures, durable: false)
        return
      }

      // `unlink` returning success only means the change is in the directory's
      // in-memory state. Until the directory itself is synced, a crash or a
      // power loss can bring every one of those names back — and this call
      // exists precisely to promise they are gone.
      //
      // Skipped when the directory was already absent: there is nothing to
      // open and nothing whose removal needs committing, and failing to sync a
      // directory that does not exist would report a survivor that cannot be
      // there.
      if !directoryAbsent, !Self.syncDirectory(directory) {
        outcome = LogClearOutcome(
          deletedCount: deleted, failedPaths: [directory.path], durable: false)
        return
      }

      // Reopen only on a clean, durable sweep, and only into the generation
      // this purge established.
      stateLock.lock()
      let current = generation
      stateLock.unlock()
      guard current == fenced else {
        outcome = LogClearOutcome(
          deletedCount: deleted, failedPaths: [], durable: false)
        return
      }

      currentFileSize = 0
      currentFileStart = Date()
      // Deletion succeeded whether or not a fresh file could be opened, and
      // `durable` describes the deletion — that is what a compliance caller
      // asked about. Whether the writer is usable again is a separate fact,
      // reported separately, because a handle that rebinds onto a writer with
      // no descriptor would accept records and then lose them.
      //
      // A purge that lands after the close barrier still deletes — that is the
      // whole point of the call — but it must not reopen. The barrier already
      // released this writer's descriptor, and opening a fresh one behind it
      // would leak the descriptor for the lifetime of the process and leave an
      // empty file where a purge had just promised none.
      outcome = LogClearOutcome(
        deletedCount: deleted, failedPaths: [], durable: true,
        rebound: terminated ? false : attemptReopen())
    }

    if group.wait(timeout: deadline) == .timedOut {
      return (
        LogClearOutcome(deletedCount: 0, failedPaths: [fileURL.path], durable: false),
        fenced
      )
    }
    return (outcome, fenced)
  }

  /// Forces the directory's own metadata to storage, so the removals that just
  /// returned survive a crash.
  private static func syncDirectory(_ url: URL) -> Bool {
    let fd = Darwin.open(url.path, O_RDONLY | O_CLOEXEC)
    guard fd >= 0 else { return false }
    defer { Darwin.close(fd) }
    return fsync(fd) == 0
  }

  /// The generation a handle must rebind to after a durable purge.
  var currentGeneration: UInt64 {
    stateLock.lock()
    defer { stateLock.unlock() }
    return generation
  }

  var isClosed: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return closed
  }

  // MARK: - Test support

  /// Closes the descriptor so the next write fails, standing in for a revoked
  /// file or a disk that stopped answering.
  func closeHandleForTesting() {
    queue.sync { closeCurrentHandle() }
  }

  /// Blocks the write queue until the returned closure is called, so callers
  /// can observe what `status()` does while the writer is stalled.
  func stallForTesting() -> () -> Void {
    let gate = DispatchSemaphore(value: 0)
    queue.async { gate.wait() }
    return { gate.signal() }
  }

  var trackedFileSizeForTesting: UInt64 {
    queue.sync { currentFileSize }
  }

  var hasLiveHandleForTesting: Bool {
    queue.sync { handle != nil }
  }

  var rotationAttemptsForTesting: Int {
    queue.sync { rotationAttempts }
  }

  /// Blocks until everything already enqueued has run, so a test can assert on
  /// the file without racing the writer.
  func settleForTesting() {
    queue.sync {}
  }
}
