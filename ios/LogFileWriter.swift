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
    self.maxArchivedFilesCount = LogRotationPolicy.count(maxArchivedFilesCount, fallback: 5)
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

  /// Same rule as `bytes`, and for a sharper reason: this limit is what pruning
  /// deletes down to.
  ///
  /// A literal zero is a real instruction — "keep no archives" — so it is
  /// honoured. `NaN` and negatives are not instructions at all, and folding them
  /// into zero would make one malformed number from JavaScript delete every
  /// rotated file on the next sweep. They fall back to the default instead:
  /// retaining five archives nobody asked for is recoverable, and deleting the
  /// lot is not.
  private static func count(_ value: Double, fallback: Int) -> Int {
    if value.isNaN || value < 0 { return fallback }
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

  /// This writer holds no exclusive claim on its file, because the filesystem
  /// would not give one.
  ///
  /// Not a failure to write — the log keeps working — but a failure of the
  /// promise that one process at a time owns this file, and the caller is the
  /// only one who can decide whether that matters. Proceeding unlocked is the
  /// deliberate choice: refusing to log because a filesystem does not support
  /// locking would be a worse answer than logging without the guarantee.
  public static let exclusivity = LogDegradation(rawValue: 1 << 5)
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

/// What `collectLogs` produced. See the `CollectOutcome` spec doc.
public struct LogCollectOutcome: Sendable, Equatable {
  /// Absolute path of the bundle, or `""` when none was produced.
  public var path: String
  public var byteCount: Double
  public var sourceFileCount: Double
  /// Some log files were left out — the ceiling, or one that would not compress.
  public var truncated: Bool
  /// The bundle was written and renamed into place.
  public var complete: Bool

  /// No bundle, nothing left out, nothing finished.
  ///
  /// The answer for a writer that has been terminated, a collect whose deadline
  /// expired, and a collect refused because another one holds the writer or the
  /// handle. `truncated: false` is deliberate: nothing was dropped from a bundle
  /// that does not exist, and saying otherwise would have a caller apologising
  /// to a user for a partial upload that never happened.
  ///
  /// A refusal is deliberately indistinguishable from a timeout here. Both mean
  /// "no bundle, try again", both leave any earlier bundle untouched, and
  /// splitting them would put a reason code in the caller's hands that it has no
  /// different action to take on.
  public static let nothing = LogCollectOutcome(
    path: "", byteCount: 0, sourceFileCount: 0, truncated: false, complete: false)
}

public enum LogWriterError: Error, Equatable {
  case openFailed(String)
  case configConflict
  case symlinkEscape
  /// A previous writer for this path has not finished shutting down. Retrying
  /// is reasonable; opening a second writer alongside it is not.
  case stillClosing
  /// Another OS process holds this log file. Its own case, because it is the
  /// one failure here that no amount of retrying inside this process can fix.
  case locked
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
  ///
  /// Milliseconds on the monotonic clock, not `Date`. A backoff asks "has
  /// enough time passed since the last failure", which an NTP correction or a
  /// user changing the date must never re-answer: a backward step of an hour
  /// would wedge rotation — and reopening, below — for an hour. File AGE still
  /// uses `Date`, and has to, because it is measured against a creation time
  /// recorded on a previous run. Android already splits these two clocks; this
  /// is the same split, and the Kotlin comment claiming iOS had it is now true.
  private static let rotationBackoffMs: Int64 = 5_000
  /// How long a failed reopen waits. Monotonic, for the reason above.
  private static let reopenBackoffMs: Int64 = 1_000
  /// Longest any deadline-bounded call will wait. Well short of the watchdog
  /// window a synchronous crash-path flush has to live inside.
  ///
  /// Internal rather than private so the clamp can be asserted against it
  /// instead of against a number copied into the test, which is how a ceiling
  /// and its pin drift apart. Kotlin's twin is public for the same reason.
  static let MAX_DEADLINE_MS = 30_000
  /// How long `logFilePaths()` will wait for the queue before answering with the
  /// active path alone. Short: it takes no deadline of its own, and collecting
  /// support logs is not worth blocking the JS thread over.
  private static let pathsDeadlineMs = 2_000

  /// The raw write, injectable so short writes and hard failures can be tested
  /// without a real disk that misbehaves on demand. Production passes `nil`.
  public typealias RawWrite = (Int32, UnsafeRawPointer, Int) -> Int

  /// Archive compression, injectable for the same reason: the interesting case
  /// is the one where it fails, and a real gzip failure needs a full disk.
  public typealias Compressor = (URL, URL) -> Bool

  /// Monotonic milliseconds, injectable so a backoff can be waited out in a
  /// test without waiting.
  ///
  /// Separate from the wall clock on purpose, and the separation is the thing
  /// under test rather than a convenience: backoffs ask "has enough time passed
  /// since the last failure", which an NTP correction or a user changing the
  /// date must never re-answer. Without a seam here, replacing the monotonic
  /// source with `Date()` left every Swift test green — Android had this
  /// injection and the twin test, and iOS had neither.
  public typealias Steady = () -> Int64

  /// The wall clock, injectable — the twin of Android's `clock`.
  ///
  /// Distinct from [Steady] and used for the opposite kind of question. Age
  /// rotation and archive retention ask "how old is this file", which is a claim
  /// about calendar time that has to survive a restart, so it is measured
  /// against the same clock that stamped the file rather than against a
  /// monotonic counter that resets with the process.
  ///
  /// It is injectable for the reason [Steady] is: without it, an age is only
  /// testable by sleeping, and a test that sleeps 200 ms against a 50 ms
  /// threshold is a test whose result depends on how loaded the machine is.
  /// Under `swift test --parallel` that stopped being hypothetical — more than
  /// the threshold could elapse between creating the file and writing to it, so
  /// the write itself rotated and the assertions moved by one.
  public typealias Clock = () -> Date

  public let fileURL: URL
  public let canonicalPath: String
  let policy: LogRotationPolicy
  let lineFramed: Bool

  private let queue: DispatchQueue
  private let queueKey = DispatchSpecificKey<Bool>()
  private let rawWrite: RawWrite
  private let compressor: Compressor
  private let steady: Steady
  private let clock: Clock
  /// See the parameter of the same name on `init`. Nil in production.
  private let openSweepGate: (() -> Void)?

  // MARK: State behind `stateLock` — cheap, never held across I/O

  private let stateLock = NSLock()
  /// Held for the whole of `clearLogs`, so purges cannot interleave.
  /// A binary semaphore rather than `NSLock`: the timed acquire in `clearLogs`
  /// needs a monotonic deadline, and `lock(before:)` only speaks `Date`.
  private let purgeLock = DispatchSemaphore(value: 1)
  /// One collect at a time per writer.
  ///
  /// **Not for the reason `purgeLock` exists, and the difference is worth being
  /// exact about.** Two builds cannot corrupt each other's staging file: builds
  /// run as tasks on the serial `queue`, so they are already ordered end to end.
  /// This lock does not add that.
  ///
  /// What it adds is that a second collect does not *enqueue* while a first is
  /// running. Without it, N concurrent callers put N full copies of the log on
  /// the queue, each one holding up every flush behind it, and each caller then
  /// spends its whole deadline waiting for work it never began — and reports a
  /// timeout, having caused one. Refusing is both cheaper and truer.
  ///
  /// **It does not make the bundle path stable for a caller.** There is one
  /// well-known bundle name, so a later collect replaces an earlier one's file
  /// whether or not they overlapped, and a caller holding a path from a
  /// completed collect can always find different bytes there by the time it
  /// uploads. That is inherent to the name, not to concurrency.
  ///
  /// A semaphore rather than `NSLock` for the reason `purgeLock` is one: the
  /// acquire is timed against the caller's monotonic budget, and
  /// `lock(before:)` only speaks `Date`.
  private let collectLock = DispatchSemaphore(value: 1)
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
  /// The exclusion this writer holds on its file, or -1 if it never got one.
  ///
  /// Taken in `init` and given back by the close barrier or `deinit`; releasing
  /// is idempotent, because a writer that fails to open has both to run.
  private var lockDescriptor: Int32 = -1
  private var currentFileSize: UInt64 = 0
  /// A placeholder only. `init` overwrites it with the file's real creation
  /// date before anything reads it; the injected `clock` does not exist yet at
  /// property-initialiser time, which is why this one literal stays.
  private var currentFileStart = Date()
  /// Monotonic ms of the last reopen attempt; nil until one has been made, so
  /// the very first attempt is never held back by an uninitialised timestamp.
  private var lastReopenAttempt: Int64?
  /// Monotonic ms before which rotation will not be retried.
  private var rotationBlockedUntil: Int64 = 0
  private var writesSinceHealthCheck = 0
  /// Set by the close barrier, on this queue. Everything enqueued before the
  /// barrier still writes; everything after it is refused.
  private var terminated = false
  /// Rotations that got past the backoff guard. Test support for asserting the
  /// backoff actually backs off.
  private var rotationAttempts = 0

  /// - Parameter directoryShortfall: what the caller's own `createDirectory`
  ///   already found. Not an optimisation — it is the only way this writer can
  ///   learn about a *protection* shortfall on its directory.
  ///
  ///   `createDirectory` reports the backup exclusion and the protection class
  ///   only on the branch where its own `mkdir` succeeded; a directory it found
  ///   already there is inspected, and `inspect` deliberately reports the mode
  ///   and nothing else. The registry resolves the path before constructing
  ///   this writer, and resolving has to create the directory first because
  ///   `realpath` only answers for things that exist — so the registry always
  ///   wins the `mkdir`, and the call below always lands on `EEXIST`. Discarding
  ///   what the registry saw therefore does not lose a duplicate opinion; it
  ///   loses the only one that was ever formed.
  init(
    fileURL: URL,
    canonicalPath: String,
    policy: LogRotationPolicy,
    lineFramed: Bool,
    rawWrite: RawWrite? = nil,
    compressor: Compressor? = nil,
    steady: Steady? = nil,
    clock: Clock? = nil,
    /// Runs on the queue immediately before the open sweep, so a test can hold
    /// the sweep there and observe the writer as it is *before* retention has
    /// run.
    ///
    /// Injected rather than assigned afterwards because the sweep is submitted
    /// during `init` — by the time a caller has a writer to set a property on,
    /// the sweep may already have run.
    openSweepGate: (() -> Void)? = nil,
    directoryShortfall: LogSecureFile.Shortfall = []
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
    self.steady = steady ?? Self.steadyMillis
    self.clock = clock ?? { Date() }
    self.openSweepGate = openSweepGate
    self.queue = DispatchQueue(label: "com.nitrologger.filewriter")
    queue.setSpecific(key: queueKey, value: true)

    // Union, not replacement. The local call still has to run — this writer may
    // be built against a directory nobody resolved, and it re-checks the mode —
    // but on the registry path it can only ever report what `inspect` reports.
    let shortfall = try LogSecureFile.createDirectory(at: fileURL.deletingLastPathComponent())
      .union(directoryShortfall)
    if !shortfall.isEmpty { degraded.insert(.protection) }

    // Before anything is opened or trimmed, because the trim truncates: a
    // second process reaching that with the first one's file would cut bytes
    // out from under it.
    switch Self.takeExclusiveLock(for: fileURL) {
    case .acquired(let fd, let secured):
      lockDescriptor = fd
      if !secured { degraded.insert(.protection) }
    case .taken:
      throw LogWriterError.locked
    case .impossible:
      degraded.insert(.exclusivity)
    }

    // Explicit, not left to `deinit`. Whether a class whose `init` throws gets
    // one is a subtlety of the language, and a descriptor held for the life of
    // the process — locking a file no writer exists for — is far too costly a
    // thing to rest on it.
    var opening = true
    defer { if opening { releaseExclusiveLock() } }

    guard let opened = Self.openForAppending(at: fileURL) else {
      throw LogWriterError.openFailed("could not open the log file")
    }
    if !opened.shortfall.isEmpty { degraded.insert(.protection) }
    handle = opened.handle
    descriptor = opened.descriptor
    currentFileSize = Self.size(of: opened.descriptor)
    currentFileStart = fileStart(created: opened.created)

    trimTornTailIfFramed()
    // Submitted, not run here — the twin of Android's change, and made
    // identically so the next person editing one finds the other.
    //
    // The queue is serial, so the sweep still runs before the first append's
    // write. That is the only ordering it needs: it moves archives, and nothing
    // can append to an archive it has not finished moving if the append is
    // behind it in the same queue.
    //
    // It was never a deadlock risk here the way it was on Android — same
    // thread, no cross-thread wait — but it is the same unbounded directory I/O
    // performed **while the registry lock is held**, so opening one file with a
    // large backlog to prune stalled every other file's acquire and release.
    //
    // The trim above stays synchronous. It must finish before any byte is
    // appended, it is what the exclusive lock is taken to protect, and it is
    // bounded by the file's size rather than by the directory's history.
    // `.utility` for the same reason the append path is: nobody is waiting for
    // this. It is the other half of the change that moved it off the acquiring
    // thread — having decided the caller does not wait for the sweep, letting
    // it compete with the UI at the caller's priority would be odd.
    queue.async(qos: .utility) { [self] in
      openSweepGate?()
      sweepRetention()
    }
    opening = false
  }

  deinit {
    let live = handle
    handle = nil
    try? live?.synchronize()
    try? live?.close()
    // Also the failed-`init` path: a lock taken before the append open failed
    // has nothing else left to give it back.
    releaseExclusiveLock()
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
  /// The `O_EXCL` probe below does not reopen that window. It is a second
  /// `open`, not a check-then-open: each call decides the file it gets from its
  /// own flags, and `O_CREAT | O_EXCL` refuses an existing name *including a
  /// symlink*. Whichever call returns the descriptor, it was protected on the
  /// way in and the checks after it run on that descriptor.
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
  ) -> (handle: FileHandle, descriptor: Int32, shortfall: LogSecureFile.Shortfall, created: Bool)? {
    // `O_RDWR`, not `O_WRONLY`: the startup tail scan reads through this exact
    // descriptor so that the offsets it computes and the `ftruncate` it applies
    // are guaranteed to concern the same inode. `pread` on a write-only
    // descriptor fails with `EBADF`, which would silently skip crash recovery.
    let appendFlags = O_RDWR | O_APPEND | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC

    // `O_EXCL` first, only to learn whether this call is the one that made the
    // file. `open(2)` will not otherwise say, and the answer picks the clock
    // that stamps the file's age — see `fileStart(created:)`, where getting it
    // wrong makes every write after a rotation rotate again.
    var created = true
    var fd = Darwin.open(
      url.path, appendFlags | O_CREAT | O_EXCL, mode_t(LogSecureFile.fileMode))
    if fd < 0 {
      // Deliberately not conditioned on `EEXIST`. Whatever refused the
      // exclusive open, the ordinary one is the call that decides, and it
      // reports its own failure below. `O_CREAT` stays on it so a file
      // unlinked between the two calls is still created rather than failing
      // `ENOENT`; that race reports `created: false` for a file it did make,
      // which costs one age measured against a creation date of a moment ago.
      created = false
      fd = Darwin.open(url.path, appendFlags | O_CREAT, mode_t(LogSecureFile.fileMode))
    }
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
    return (FileHandle(fileDescriptor: fd, closeOnDealloc: true), fd, shortfall, created)
  }

  /// The instant this file's age is measured from.
  ///
  /// A file this open just created is stamped from `clock()`; one that was
  /// already there is stamped from the filesystem. They are two different
  /// timebases and the distinction is the whole point.
  ///
  /// A file created a moment ago is zero seconds old *by the writer's clock*,
  /// whatever the filesystem says — so taking its real creation date while the
  /// writer measures against an injected clock standing anywhere else makes the
  /// fresh file instantly over-age. Rotation is where that bites: it renames
  /// the file away and reopens a new one, so a wrong stamp here means the next
  /// write rotates again, and the one after that, for as long as writing
  /// continues.
  ///
  /// The filesystem date is right for the other case and only that one. An
  /// existing file's age has to survive the process that created it, which is
  /// why this is calendar time rather than the monotonic `steady` — and there
  /// the two bases legitimately meet, because a real file carries a real date.
  private func fileStart(created: Bool) -> Date {
    created ? clock() : Self.creationDate(of: fileURL, fallback: clock())
  }

  private static func size(of descriptor: Int32) -> UInt64 {
    var info = stat()
    guard descriptor >= 0, fstat(descriptor, &info) == 0 else { return 0 }
    return UInt64(max(0, info.st_size))
  }

  /// The filesystem's creation date, or `fallback` when it will not say.
  ///
  /// `fallback` is passed rather than defaulted to `Date()` because this is the
  /// value age rotation measures against: taking the real clock here while the
  /// writer runs on an injected one would make a fresh file look arbitrarily old
  /// or arbitrarily young to the very check that reads it.
  private static func creationDate(of url: URL, fallback: Date) -> Date {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.creationDate] as? Date) ?? fallback
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

    // `.utility`, and the *submission* carries it rather than the queue.
    //
    // This is the one place the priority is lowered, because this is the work
    // nobody is waiting for: `appendBatch` has already returned by the time the
    // block runs, and rotation and compression happen inside it. Dropping it
    // below the UI is the whole point — a log write must never be why a frame
    // is late.
    //
    // The queue itself deliberately has NO assigned QoS, and that is not an
    // oversight. A `DispatchQueue` created with a QoS treats it as a ceiling
    // and silently discards the QoS of anything submitted with `async(qos:)`;
    // only a `DispatchWorkItem` carrying `.enforceQoS` gets past it. So giving
    // the queue `.utility` would have quietly demoted the six deadline-bound
    // barriers — `flush`, `close`, `maintain`, `collectLogs`, `clearLogs`,
    // `logFilePaths` — to utility as well, which is the exact opposite of what
    // is wanted for calls the JavaScript thread is blocked on. Leaving the
    // queue unassigned lets those barriers keep inheriting their caller's QoS,
    // which is a better answer than any constant picked here.
    //
    // What this does NOT buy: a barrier still queues behind whatever appends
    // are already in front of it, and those now run at utility. Dispatch is
    // documented to raise queued work when something higher-priority arrives
    // behind it, but that override is not observable through
    // `qos_class_self()`, so it is not something this comment will claim.
    // Utility rather than background is partly why: the gap is a scheduling
    // preference, not a starvation cliff.
    queue.async(qos: .utility) { [self] in
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

    // Tracked, not measured. This used to `fstat` on every append — about a
    // fifth of the per-batch syscall time, and the only per-append syscall
    // that can be removed at all — on the grounds that a rollback must know
    // the true end of file. That grounds is sound and the conclusion was not:
    // the happy path never rolls back, and the failure path can measure the
    // truth at the moment it actually needs it, which is strictly better than
    // a value read before the write.
    let offsetBefore = currentFileSize
    var written = 0
    do {
      try writeAll(data, written: &written)
      currentFileSize = offsetBefore + UInt64(data.count)
      healthCheckPeriodically()
      rotateIfNeeded()
    } catch {
      // Roll back to the record boundary the batch started at. A half-written
      // batch is a half-written record, and a half-written record makes the
      // rest of the file unparseable from that point on — the loss would
      // spread from one batch to everything after it.
      //
      // Measured HERE, because this is the one place where being wrong
      // truncates bytes that are not ours. `trueEnd - written` is where this
      // batch began no matter how far the tracked counter has drifted, and it
      // is more exact than the old `offsetBefore`: that was read before the
      // write and could not account for anything that landed underneath it.
      // Never truncate blindly to the tracked value.
      let trueEnd = Self.size(of: descriptor)
      let target = trueEnd >= UInt64(written) ? trueEnd - UInt64(written) : 0
      if ftruncate(descriptor, off_t(target)) == 0 {
        currentFileSize = target
      } else {
        // The rollback itself failed, so the file is whatever it is. Anchor
        // to that rather than to a counter now known to be a guess.
        currentFileSize = trueEnd
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
  /// - Parameter written: bytes that reached the file, reported even when this
  ///   throws. That is the whole reason it is an `inout` and not a return
  ///   value: the caller's rollback subtracts it from the true end of file,
  ///   and a throw is exactly when it needs to know.
  private func writeAll(_ data: Data, written: inout Int) throws {
    var done = 0
    var retries = 0
    defer { written = done }
    try data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      while done < data.count {
        let n = rawWrite(descriptor, base + done, data.count - done)
        if n > 0 {
          done += n
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

  /// The live descriptor, reopening if the backoff allows.
  ///
  /// `ignoringBackoff` is for the explicit-durability paths — `flush` and
  /// `close`. A caller there is asking for what is buffered to be on storage
  /// NOW, and a degraded writer sitting inside its reopen backoff would
  /// otherwise report failure and hand back nothing, with no second chance
  /// coming. That is exactly the `applicationWillTerminate` case, where the
  /// records being given up on are the ones explaining the shutdown.
  ///
  /// Ported back from SwiftLogger, whose `FileDestination` has carried this
  /// parameter since the crash-path work; the port dropped it.
  private func writableHandle(ignoringBackoff: Bool = false) -> FileHandle? {
    if let handle { return handle }

    // Past the close barrier there is nothing to reopen INTO. `close()`
    // released the descriptor and the caller is done with this writer, so
    // opening a fresh one would leak it for the lifetime of the process and
    // resurrect a writer that was deliberately shut.
    //
    // The guard lives here rather than at each call site because this is the
    // only place a descriptor is created on demand. `performWrite` and the
    // purge path already refuse after termination; `syncNow` did not, and it
    // reaches this with `ignoringBackoff: true`, so a `flush()` arriving after
    // `close()` returned would quietly reopen. Callers read `nil` as "no
    // descriptor", which is the truth: a terminated writer cannot sync.
    if terminated { return nil }

    if !ignoringBackoff, let last = lastReopenAttempt,
       steady() - last < Self.reopenBackoffMs {
      return nil
    }
    attemptReopen()
    return handle
  }

  /// Monotonic milliseconds since boot. The production `steady`.
  ///
  /// `DispatchTime` rather than `Date` for every elapsed-time question asked
  /// within one process lifetime — backoffs, deadlines, the purge lock. It
  /// cannot be moved by the user or by NTP, which is the whole point: a clock
  /// that jumps backwards turns a one-second backoff into an outage.
  ///
  /// The deliberate exceptions are the questions that span restarts: file age
  /// and archive-retention cutoffs are measured against filesystem timestamps,
  /// which have to be calendar time because an uptime clock restarts at zero.
  ///
  /// Reached through the `steady` property rather than called directly, so a
  /// test can substitute for it. Calling `Self.steadyMillis()` at a backoff
  /// site would compile and pass every existing test while silently ignoring
  /// the injection — which is how this went untested in the first place.
  private static func steadyMillis() -> Int64 {
    Int64(DispatchTime.now().uptimeNanoseconds / 1_000_000)
  }

  @discardableResult
  private func attemptReopen() -> Bool {
    lastReopenAttempt = steady()
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
      currentFileStart = clock()
      writesSinceHealthCheck = 0
      return false
    }
    if !opened.shortfall.isEmpty { note(.protection) }
    handle = opened.handle
    descriptor = opened.descriptor
    currentFileSize = Self.size(of: opened.descriptor)
    currentFileStart = fileStart(created: opened.created)
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
    if fstat(descriptor, &info) == 0 && info.st_nlink > 0 {
      // Re-anchor while the answer is already in hand. This runs every
      // `healthCheckStride` writes, which is what bounds how far the tracked
      // `currentFileSize` can drift from the file it claims to describe —
      // eight batches, not the life of the handle. The `flock` is what makes
      // drift unlikely in the first place; this is what makes it survivable
      // when the lock could not be taken and the sink said so.
      //
      // Not pinned by any test, and recorded rather than left to look
      // guarded: deleting this line leaves all 253 Swift tests passing.
      // Rollback correctness under drift IS pinned — see
      // `testARollbackRemovesThisBatchAndNotWhatSomebodyElseAppended` — but
      // what this bounds is how late SIZE ROTATION runs when a foreign
      // appender is growing the file, and no test drives eight batches
      // alongside one.
      currentFileSize = UInt64(max(0, info.st_size))
      return
    }
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

  /// Runs the housekeeping the write path would otherwise have to trigger.
  ///
  /// Rotation and retention only ever run from a write — `rotateIfNeeded` from
  /// `performWrite`, `sweepRetention` from open and from rotation — so a sink
  /// nobody is logging to keeps whatever it had when the last record landed: an
  /// age rotation that never fires, an expired archive that is never deleted, a
  /// total-bytes cap that goes on being exceeded. `flush` is not a substitute;
  /// it drains the queue and touches neither.
  ///
  /// On the writer's own queue, like everything else that moves files, so it
  /// cannot interleave with a rotation a write is already performing.
  ///
  /// The status is read after the wait, not after the sweep — those are the
  /// same instant only when the sweep finished inside `deadlineMs`. A caller
  /// that passes `0`, or whose budget expires behind a wedged write, gets a
  /// status describing what the sweep found *so far*. The sweep itself still
  /// runs, on the queue, and a status read after it completes carries the rest
  /// — not necessarily the very next one, since nothing stops a caller reading
  /// again while it is still going.
  func maintain(handleID: UInt64, deadlineMs: Double) -> LogSinkStatus {
    let deadline = DispatchTime.now() + .milliseconds(Self.clampDeadline(deadlineMs))
    let group = DispatchGroup()
    group.enter()
    queue.async { [self] in
      // Rotation would stop at its own `handle == nil` check, but the sweep
      // would not: it works off a directory listing and needs no stream, so a
      // writer whose close has already run would go on expiring archives at
      // whichever writer now holds this path, under a policy that one never
      // agreed to.
      if !terminated {
        rotateIfNeeded()
        sweepRetention()
      }
      group.leave()
    }
    _ = group.wait(timeout: deadline)
    return status(handleID: handleID)
  }

  /// Packs the logs into one gzip bundle for a support upload.
  ///
  /// gzip is a multi-member format, so the bundle is the members concatenated:
  /// an existing `.gz` archive is copied in byte for byte and a plaintext one
  /// — the active file, or an archive whose compression was turned off or
  /// failed — is compressed through the same compressor rotation uses. That is
  /// the whole trick, and it is why this can be done without decompressing
  /// anything or holding a log in memory.
  ///
  /// Written OLDEST first, because that is the order somebody reading the
  /// gunzipped result wants; chosen NEWEST first, because that is the half of
  /// the log worth keeping when the ceiling cuts it.
  ///
  /// The whole thing runs on the queue. Rotation, compression and retention
  /// all move these files and all run here, so a bundle built from the
  /// caller's thread could copy in an archive that is being renamed out from
  /// under it.
  func collectLogs(handleID: UInt64, deadlineMs: Double, maxTotalBytes: Double) -> LogCollectOutcome {
    // One absolute instant, computed before any waiting, and every wait below
    // is against it rather than against a fresh budget of its own: the gate,
    // the flush, and the build. A caller that asked for 100 ms means 100 ms for
    // the lot — handing each step the full figure turns the deadline into a
    // multiple of itself.
    let expiry = DispatchTime.now() + .milliseconds(Self.clampDeadline(deadlineMs))

    // One collect at a time per writer — see `collectLock`. Refused, not
    // queued: a second collect that waited its turn would spend the caller's
    // whole deadline before starting and then report a timeout for work it
    // never began, which is a worse answer than "not now".
    //
    // Taken before the flush so the whole call is one exclusive region, and
    // before anything is submitted to the queue, so this refusal leaves nothing
    // enqueued to publish later.
    guard collectLock.wait(timeout: expiry) == .success else { return .nothing }
    // Registered here rather than after the `group.wait` below, so it runs
    // *after* `handoff.giveUp()` on the timeout path: the return value is
    // evaluated before the deferred blocks. That order is the point — a build
    // abandoned under the handoff's own lock can never publish, so the next
    // collect through this gate cannot find one racing it.
    defer { collectLock.signal() }

    // Everything buffered goes in. A support bundle missing the last few
    // seconds is missing exactly the part somebody is asking about.
    _ = flush(handleID: handleID, deadline: expiry)

    let handoff = CollectHandoff()
    var outcome = LogCollectOutcome.nothing
    let group = DispatchGroup()
    group.enter()
    queue.async { [self] in
      if !terminated {
        outcome = buildBundle(handoff: handoff, maxTotalBytes: maxTotalBytes)
      }
      group.leave()
    }
    // The block cannot be cancelled mid-copy, but it CAN be stopped from
    // publishing. Without that it would go on to rename a finished bundle into
    // place seconds after this call reported there was none — a second copy of
    // the whole log, on a device whose app was told nothing was collected,
    // outside the retention budget it configured, and skipped by the orphan
    // sweep because a FINISHED bundle is deliberately kept.
    guard group.wait(timeout: expiry) == .success else { return handoff.giveUp() }
    return outcome
  }

  /// One collect's handoff between the thread waiting on it and the build
  /// running it.
  ///
  /// Per collect, and shared by exactly those two: a writer-wide flag would let
  /// one caller's timeout abandon another caller's build, and a writer-wide
  /// "committed" would let one build's success answer another's question. The
  /// object is the pairing.
  final class CollectHandoff: @unchecked Sendable {
    private let lock = NSLock()
    private var abandoned = false
    private var claimed = false
    private var result = LogCollectOutcome.nothing

    /// The waiter's half of the publish barrier.
    ///
    /// Either the build has already renamed a bundle into place — in which case
    /// the caller is told about the bundle that exists, however late — or it has
    /// not, and this stops it from ever doing so. There is no third answer and
    /// no timeout: whoever holds the lock decides, and the only thing the loser
    /// waits for is one rename.
    func giveUp() -> LogCollectOutcome {
      lock.lock()
      defer { lock.unlock() }
      if claimed { return result }
      abandoned = true
      return .nothing
    }

    /// The build's half. `publish` runs under the lock and reports whether the
    /// rename succeeded; the outcome it produced is remembered for a waiter
    /// that has already stopped listening.
    func commit(_ outcome: LogCollectOutcome, publish: () -> Bool) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      if abandoned { return false }
      guard publish() else { return false }
      result = outcome
      claimed = true
      return true
    }
  }

  /// One log file on its way into a bundle, and whether it is already a gzip
  /// member.
  ///
  /// Carried rather than inferred from the filename. The active file is always
  /// plaintext even when the app named it `app.gz`, and copying it in verbatim
  /// on the strength of its extension would produce a `.support.gz` that no
  /// tool can open. Only rotation decides whether an archive was compressed,
  /// so only rotation's own naming answers this.
  private struct Source {
    let url: URL
    let alreadyCompressed: Bool
  }

  /// Queue only. See `collectLogs`.
  private func buildBundle(handoff: CollectHandoff, maxTotalBytes: Double) -> LogCollectOutcome {
    let fm = FileManager.default
    let directory = fileURL.deletingLastPathComponent()
    let baseName = fileURL.lastPathComponent
    let finalURL = directory.appendingPathComponent(Self.supportName(baseName))
    let stagingURL = directory.appendingPathComponent(Self.supportStagingName(baseName))

    // Staging only, and deliberately not `finalURL`.
    //
    // Staging is this call's own scratch: a `.part` from a collect that died
    // mid-write is not something to append to, and clearing it is what stops
    // abandoned builds accumulating. Deleting it can destroy nothing a caller
    // holds, because no call ever returns a `.part` path.
    //
    // The published bundle used to be deleted here too, and that was the
    // defect. Every failure below — abandoned by timeout, nothing selected, a
    // member that would not copy, a rename that failed — then left the caller
    // of an *earlier* successful collect holding a path to a file that no
    // longer existed, and no call ever reported destroying it. It is replaced
    // by the `rename` at the end instead, which needs no pre-delete at all.
    try? fm.removeItem(at: stagingURL)

    // Newest first: the active file, then archives. `archives` already
    // excludes `.part` and — because the bundle is not an archive name — the
    // bundle this call is about to write.
    var sources: [Source] = []
    if fm.fileExists(atPath: fileURL.path) {
      sources.append(Source(url: fileURL, alreadyCompressed: false))
    }
    for archive in Self.archives(in: directory, baseName: baseName) {
      sources.append(
        Source(url: archive.url, alreadyCompressed: archive.url.lastPathComponent.hasSuffix(".gz")))
    }

    // Measured on the source bytes. A ceiling that could only be checked after
    // compressing would not bound the work, and the caller's question — how
    // much of my log is leaving this device — is about the log, not about how
    // well it compressed.
    var budget = Self.byteCap(maxTotalBytes)
    var chosen: [Source] = []
    var truncated = false
    for source in sources {
      guard let bytes = Self.fileSize(at: source.url) else {
        // Unmeasurable, so it cannot be charged against the ceiling. Taking it
        // for free is the wrong direction on a number that says how much may
        // leave the device.
        truncated = true
        continue
      }
      // Nothing to contribute. Skipped rather than packed as an empty member,
      // which is what makes a ceiling of zero produce no bundle even when the
      // active file has just been opened and is still empty.
      if bytes == 0 { continue }
      if bytes > budget {
        truncated = true
        continue
      }
      budget -= bytes
      chosen.append(source)
    }
    // Nothing to pack is a finished collect, not a failed one. `truncated`
    // carries the difference between a device with no logs and a ceiling too
    // small to fit any of the ones it has.
    guard !chosen.isEmpty else {
      return LogCollectOutcome(
        path: "", byteCount: 0, sourceFileCount: 0, truncated: truncated, complete: true)
    }

    // Not `.nothing` on any path below: selection already ran, and if the
    // ceiling cut files out that is still true of a bundle that could not be
    // written.
    var failed: LogCollectOutcome {
      LogCollectOutcome(
        path: "", byteCount: 0, sourceFileCount: 0, truncated: truncated, complete: false)
    }

    guard fm.createFile(atPath: stagingURL.path, contents: nil),
          let sink = try? FileHandle(forWritingTo: stagingURL) else {
      try? fm.removeItem(at: stagingURL)
      note(.gzip)
      return failed
    }
    if !LogSecureFile.secure(stagingURL).isEmpty { note(.protection) }

    var written = 0
    var writeFailed = false
    // Oldest first, so `gunzip` yields the log in the order it happened.
    for source in chosen.reversed() {
      // Where this member starts, so a copy that dies halfway can be undone
      // rather than left in the stream. Half a gzip member followed by a whole
      // one is not a gzip file, and publishing that as a truncated bundle
      // would hand somebody a file no tool will open.
      //
      // NOT covered by a test, and deliberately kept anyway. Reaching it needs
      // a read or a write that fails PART WAY through a 256 KB chunk — a
      // failing flash chip, a volume that filled between two writes — and
      // there is no seam in this file that can stage one. The member failures
      // the suite can stage (a compressor that refuses, a source that will not
      // open) all fail before a byte is written, where this is a no-op.
      guard let mark = try? sink.offset() else {
        // Without a starting offset there is nowhere to roll back TO, and
        // rolling back to zero would throw away the members already written
        // while `written` still counts them. Nothing is published from here.
        writeFailed = true
        break
      }
      if appendMember(source, to: sink, scratch: directory) {
        written += 1
        continue
      }
      truncated = true
      do {
        try sink.truncate(atOffset: mark)
        try sink.seek(toOffset: mark)
      } catch {
        // The rollback itself failed, so what is on disk is unknown. Nothing
        // is published from here.
        writeFailed = true
        break
      }
    }
    do {
      try sink.synchronize()
      try sink.close()
    } catch {
      writeFailed = true
    }

    guard written > 0, !writeFailed else {
      try? fm.removeItem(at: stagingURL)
      if writeFailed { note(.gzip) }
      return failed
    }

    // Measured here rather than after the rename. A size the platform will not
    // answer for is a bundle nothing can be said about, and saying `complete`
    // with a byte count of zero over a file that is really there would send a
    // support flow looking for a fault in the upload.
    guard let bytes = Self.fileSize(at: stagingURL) else {
      try? fm.removeItem(at: stagingURL)
      note(.gzip)
      return failed
    }

    // **What serialises this against a purge is the queue, not a lock.** The
    // rename below, and `clearLogs`'s whole sweep, are each a single task on
    // this serial queue, so their mutating phases cannot interleave — one runs
    // to completion before the other starts.
    //
    // Stated precisely, because the guarantee is narrower than "purge and
    // collect are mutually exclusive": a purge CAN linearize between this
    // collect's flush and the submission of this build, and then it deletes
    // artifacts this build was about to read. What it cannot do is preempt a
    // build already running. A purge submitted behind a slow compressor waits
    // for it — returning non-durable if its own deadline expires first, then
    // executing when the queue frees.
    //
    // A shared gate would close the first gap and cost more than it is worth:
    // purge would additionally have to wait through collect's *flush*, which
    // touches none of the files it deletes.
    //
    // The publish barrier, with the rename inside it. Holding the lock across
    // the rename is what makes "did this publish?" a question with one answer:
    // a waiter that takes the lock either finds nothing renamed — and marks the
    // collect abandoned, so nothing ever will be — or finds the finished
    // outcome waiting for it. Neither side needs a timeout, and the only thing
    // the loser waits for is one rename.
    let published = LogCollectOutcome(
      path: finalURL.path,
      byteCount: Double(bytes),
      sourceFileCount: Double(written),
      truncated: truncated,
      complete: true
    )
    var renameFailed = false
    let committed = handoff.commit(published) {
      // POSIX `rename(2)`, not `FileManager.moveItem`. `moveItem` refuses an
      // existing destination, which is what forced the pre-delete this
      // replaces; `rename` replaces one atomically, so a reader of the bundle
      // path sees either the old bundle or the new one and never neither.
      //
      // It is also the failure behaviour that matters here: `rename` does not
      // touch its destination unless it succeeds. A failed publish therefore
      // leaves the earlier bundle exactly where it was, which is the window
      // closed rather than narrowed.
      guard rename(stagingURL.path, finalURL.path) == 0 else {
        renameFailed = true
        return false
      }
      return true
    }
    guard committed else {
      try? fm.removeItem(at: stagingURL)
      if renameFailed { note(.gzip) }
      return failed
    }
    // Outside the barrier, because a mode that could not be applied is a
    // degradation bit rather than a reason to withhold a bundle that exists.
    if !LogSecureFile.secure(finalURL).isEmpty { note(.protection) }
    return published
  }

  /// Appends one source as a gzip member. Queue only.
  ///
  /// An archive rotation already compressed is a member and is copied
  /// verbatim. Anything else is compressed to a scratch file first and then
  /// copied, rather than compressed straight into the sink: that reuses the
  /// compressor rotation uses — the same one a test injects — instead of
  /// growing a second compression path that nothing else exercises.
  private func appendMember(_ source: Source, to sink: FileHandle, scratch: URL) -> Bool {
    let fm = FileManager.default
    if source.alreadyCompressed {
      return copy(source.url, into: sink)
    }

    let temporary = scratch.appendingPathComponent(
      Self.supportMemberName(fileURL.lastPathComponent))
    try? fm.removeItem(at: temporary)
    defer { try? fm.removeItem(at: temporary) }
    guard compressor(source.url, temporary) else {
      note(.gzip)
      return false
    }
    // A compressed copy of a log file, so it gets the same protections every
    // other artifact does for as long as it exists — which is what rotation
    // does with the identical file.
    if !LogSecureFile.secure(temporary).isEmpty { note(.protection) }
    return copy(temporary, into: sink)
  }

  /// Streams `source` into `sink` in bounded chunks.
  ///
  /// Chunked rather than `Data(contentsOf:)` because the caller's ceiling is
  /// on what leaves the device, not on what this is allowed to allocate: a
  /// 200 MB archive read whole is a memory spike on the thread of an app that
  /// was only trying to file a bug report.
  ///
  /// A read that throws is a failure, NOT an end of file. `try?` would collapse
  /// the two and report a member cut off halfway as a member written whole.
  /// A false return may leave bytes in `sink`; the caller rolls them back.
  private func copy(_ source: URL, into sink: FileHandle) -> Bool {
    guard let input = try? FileHandle(forReadingFrom: source) else {
      note(.gzip)
      return false
    }
    defer { try? input.close() }
    while true {
      let chunk: Data?
      do {
        chunk = try input.read(upToCount: Self.copyChunkBytes)
      } catch {
        note(.gzip)
        return false
      }
      guard let chunk, !chunk.isEmpty else { return true }
      do {
        try sink.write(contentsOf: chunk)
      } catch {
        note(.gzip)
        return false
      }
    }
  }

  private static let copyChunkBytes = 256 * 1024

  /// Size in bytes, or nil for anything that cannot be measured.
  ///
  /// Nil rather than zero, because they are opposite facts here: an empty file
  /// contributes nothing and is skipped, while one that cannot be stat'd is a
  /// file whose absence makes the bundle incomplete. Reading the second as
  /// zero would let it into the bundle without being charged against the
  /// caller's ceiling.
  private static func fileSize(at url: URL) -> UInt64? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else {
      return nil
    }
    return attributes[.size] as? UInt64
  }

  /// A byte ceiling from JavaScript, where every number is a Double.
  ///
  /// Anything that is not a finite positive number becomes ZERO — nothing
  /// fits, no bundle, `truncated: true`. The other direction was tempting
  /// ("a broken ceiling means no ceiling") and is wrong: this number is the
  /// caller's decision about how much of a log may leave the device, and a
  /// `NaN` arriving from some arithmetic upstream must not be read as consent
  /// to send all of it. The TypeScript side refuses these before they get
  /// here; this is what happens if something else calls the sink directly.
  private static func byteCap(_ value: Double) -> UInt64 {
    guard value.isFinite, value > 0 else { return 0 }
    return value >= Double(UInt64.max) ? UInt64.max : UInt64(value)
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
  ///
  /// The reopen ignores the backoff. This runs only for `flush` and the close
  /// barrier, where the caller is asking for durability now and there is no
  /// later attempt to fall back on — refusing to try because a failed reopen
  /// happened half a second ago would give up on the buffer at exactly the
  /// moment it matters most.
  private func syncNow() {
    guard let handle = writableHandle(ignoringBackoff: true) else {
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
      // `defer`, so the ordering is structural rather than incidental. Nothing
      // in this block throws today, so this is not a behaviour change — it is
      // the guarantee the Kotlin twin needs a `finally` to get, written the same
      // way here so the next edit to either cannot quietly break one of them.
      //
      // The order is the stream-then-claim rule: the claim must outlast every
      // byte this writer will ever put on disk, or a replacement process can
      // start appending while the last batch is still landing.
      defer {
        releaseExclusiveLock()
        onTerminated?()
        group.leave()
      }
      terminated = true
      closeCurrentHandle()
    }
    // Whatever the flush left of the budget, and nothing more. A deadline
    // already in the past makes this return at once rather than wait afresh.
    _ = group.wait(timeout: deadline)
    return outcome
  }

  // MARK: - One process at a time

  /// What asking for the exclusion got.
  enum LockOutcome {
    /// Held, on this descriptor. `secured` is false if the mode did not stick.
    case acquired(Int32, secured: Bool)
    /// Another process is appending to this file right now.
    case taken
    /// The filesystem will not do this. Log anyway, and say so.
    case impossible
  }

  /// Takes the process-exclusive claim on a log file, or explains why not.
  ///
  /// A lock on a file of its own rather than on the active log: rotation renames
  /// the active file out from under itself, and `flock` follows the inode, so
  /// the exclusion would quietly move to an archive at the first rotation and
  /// leave the live file unguarded.
  ///
  /// Three outcomes, and each is a decision. Acquired is the ordinary one.
  /// Taken means another process is appending to this file right now, and two
  /// processes interleaving mid-record is the collision this whole library is
  /// built to prevent — so the caller throws. Impossible carries on unlocked and
  /// raises `exclusivity`, because refusing to log at all would be the worse
  /// answer and the caller can read the bit and decide for itself.
  ///
  /// `O_NOFOLLOW` for the same reason the log file gets it: a symlink where the
  /// lock file goes would put the exclusion on a file in a directory nobody
  /// chose. `O_CLOEXEC` because a lock inherited by a spawned process outlives
  /// the writer that took it.
  static func takeExclusiveLock(for fileURL: URL) -> LockOutcome {
    let url = fileURL
      .deletingLastPathComponent()
      .appendingPathComponent(lockName(fileURL.lastPathComponent))

    // `O_NOFOLLOW` makes a symlink here fail rather than redirect: following one
    // would put the lock — and the `fchmod` below — on a file nobody chose, and
    // could quietly make two unrelated paths exclude each other. The failure is
    // `.impossible`, so the target is left untouched and logging continues
    // without the guarantee; Android reaches the same answer by checking.
    let fd = Darwin.open(url.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { return .impossible }

    // `LOCK_NB`, never a blocking wait. A logger that hangs at construction
    // because another process has the file is worse than one that says so.
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
      let conflict = errno == EWOULDBLOCK
      Darwin.close(fd)
      // Anything else — a filesystem that does not implement `flock`, which is
      // what `EOPNOTSUPP` means on a network mount — is not another process.
      return conflict ? .taken : .impossible
    }

    // Owner-only like every other file this writer creates. It carries no log
    // bytes, but it is created in the log directory under a name derived from
    // the caller's, and there is no reason for it to be the one file in there
    // that anyone can read. Through the descriptor, so a name swapped after the
    // open cannot redirect it.
    let secured = fchmod(fd, S_IRUSR | S_IWUSR) == 0
    return .acquired(fd, secured: secured)
  }

  /// Gives the claim back. Idempotent; the kernel would do it at exit anyway.
  private func releaseExclusiveLock() {
    let fd = lockDescriptor
    lockDescriptor = -1
    guard fd >= 0 else { return }
    flock(fd, LOCK_UN)
    Darwin.close(fd)
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

  /// Folds a directory shortfall observed by a *later* acquire into this
  /// writer.
  ///
  /// Exists because `resolve()` runs outside the registry lock. Two first
  /// acquires racing on a fresh directory split the evidence: one wins the
  /// `mkdir` — and with it the only protection verdict the directory ever
  /// gets — while the other can win the registry lock and publish the writer.
  /// The verdict then arrives at a writer that already exists, and the reuse
  /// branch has to fold it in; dropping it there would reopen the exact
  /// reporting gap the `directoryShortfall` init parameter closes for the
  /// single-acquirer path.
  func absorbDirectoryShortfall(_ shortfall: LogSecureFile.Shortfall) {
    if !shortfall.isEmpty { note(.protection) }
  }

  private func note(_ flag: LogDegradation) {
    stateLock.lock()
    degraded.insert(flag)
    stateLock.unlock()
  }

  // MARK: - Rotation (queue only)

  private func rotateIfNeeded() {
    guard let live = handle else { return }
    guard steady() >= rotationBlockedUntil else { return }
    let tooBig = currentFileSize >= policy.maxFileSizeBytes
    let tooOld = policy.maxFileAgeSeconds.map {
      clock().timeIntervalSince(currentFileStart) >= $0
    } ?? false
    guard tooBig || tooOld else { return }
    rotationAttempts += 1

    try? live.synchronize()
    closeCurrentHandle()

    let archiveURL = fileURL
      .deletingLastPathComponent()
      .appendingPathComponent("\(fileURL.lastPathComponent).\(Self.rotationStamp(at: clock()))")

    do {
      try FileManager.default.moveItem(at: fileURL, to: archiveURL)
    } catch {
      // Back off. A rotation that fails on every write — a read-only volume,
      // a directory someone removed — would otherwise retry on every single
      // batch, turning a degraded log into a busy one.
      note(.rotation)
      rotationBlockedUntil = steady() + Self.rotationBackoffMs
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

  /// `at` rather than reading the clock here: this is `static`, and the
  /// instant an archive is named after should be the same one the writer is
  /// measuring ages against.
  private static func rotationStamp(at instant: Date) -> String {
    let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8).lowercased()
    return "\(stampFormatter.string(from: instant))_\(suffix)"
  }

  // MARK: - Retention (queue only)

  /// Applies all three retention limits. Runs at open, after each rotation,
  /// and from `maintain`.
  ///
  /// Still no timer of its own: one that fires in the background is a wakeup
  /// the app pays for and a retention policy the JS side is not consulted on.
  /// An active process rotates, and rotation sweeps; a quiet one is swept by
  /// `maintain`, on whatever schedule the app decides — which is what
  /// `scheduleMaintenance` is, in TypeScript, where the app can see it.
  private func sweepRetention() {
    let directory = fileURL.deletingLastPathComponent()
    let baseName = fileURL.lastPathComponent
    let fm = FileManager.default
    var failed = false

    // ONE walk, partitioned, where this used to be two — `archives(in:)` and
    // a second `contentsOfDirectory` for the orphans. The partition is safe
    // because the two sides are disjoint by grammar: `isArchiveName`
    // deliberately excludes `.part`, and the support names share no stamp.
    // Every name goes to exactly one side or to neither.
    let listing = (try? fm.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: Self.archiveResourceKeys
    )) ?? []

    // Orphaned compressions first. A `.part` is a gzip that was interrupted —
    // by a crash, or by a process that died mid-rotation — and nothing will
    // ever finish it. Compression runs on this same queue, so a staging file
    // seen from here is never one being written.
    //
    // The support bundle's staging file is swept for the same reason and by
    // the same pass. The finished bundle is not: it is something a caller
    // asked for and may not have uploaded yet, and deleting it here would make
    // `collectLogs` a race against the next rotation.
    for url in listing {
      let name = url.lastPathComponent
      guard Self.isStagingName(name, baseName: baseName)
        || name == Self.supportStagingName(baseName)
        || name == Self.supportMemberName(baseName) else { continue }
      do { try fm.removeItem(at: url) } catch { failed = true }
    }

    var archives = Self.archives(from: listing, baseName: baseName)

    func remove(_ entry: Artifact) {
      do { try fm.removeItem(at: entry.url) } catch { failed = true }
    }

    // Oldest first for age, then count, then total size — each pass works on
    // what the previous one left.
    //
    // Each pass removes by the property that SELECTED, not by membership in
    // the list of what was selected. The old shape filtered and then asked
    // `removeAll { expired.contains … }` — O(n²), 360 µs at two hundred
    // archives and widening quadratically, on the queue every append waits
    // behind. `expired` is exactly `{ modified < cutoff }` and `excess` is
    // exactly the tail past the cap on a list already sorted newest-first,
    // so the predicate and the prefix ARE the sets, with nothing to search.
    if let maxAge = policy.maxArchiveAgeSeconds {
      let cutoff = clock().addingTimeInterval(-maxAge)
      for entry in archives where entry.modified < cutoff { remove(entry) }
      archives.removeAll { $0.modified < cutoff }
    }

    if archives.count > policy.maxArchivedFilesCount {
      for entry in archives[policy.maxArchivedFilesCount...] { remove(entry) }
      archives.removeLast(archives.count - policy.maxArchivedFilesCount)
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
  static let archiveResourceKeys: [URLResourceKey] = [
    .contentModificationDateKey, .fileSizeKey,
  ]

  static func archives(in directory: URL, baseName: String) -> [Artifact] {
    guard let contents = try? FileManager.default.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: archiveResourceKeys
    ) else { return [] }
    return archives(from: contents, baseName: baseName)
  }

  /// The Artifact-building half of `archives(in:)`, over a listing the caller
  /// already holds — `sweepRetention` walks the directory once and partitions
  /// it, rather than walking again for the archives. The listing must have
  /// been fetched with {@link archiveResourceKeys} or `resourceValues` pays a
  /// syscall per archive here.
  static func archives(from contents: [URL], baseName: String) -> [Artifact] {
    return contents
      .filter { isArchiveName($0.lastPathComponent, baseName: baseName) }
      .map { url -> Artifact in
        let values = try? url.resourceValues(forKeys: Set(archiveResourceKeys))
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
    guard let suffix = stampSuffix(name, baseName: baseName),
          let tail = tailAfterStamp(suffix) else { return false }
    return tail.isEmpty || tail.elementsEqual(".gz".utf8)
  }

  /// A gzip staging file, `<base>.<stamp>.gz.part`.
  static func isStagingName(_ name: String, baseName: String) -> Bool {
    guard let suffix = stampSuffix(name, baseName: baseName),
          let tail = tailAfterStamp(suffix) else { return false }
    return tail.elementsEqual(".gz.part".utf8)
  }

  /// The exclusion file for `baseName`, and **deliberately not an artifact.**
  ///
  /// It holds zero log bytes — it exists only to be locked — so a purge that
  /// leaves it behind has still deleted every byte of log data, and `durable`
  /// keeps the compliance meaning it has everywhere else. Deleting it would be
  /// worse than useless: `flock` lives on the inode, so unlinking the name while
  /// a writer holds it lets the next process create a fresh file, lock that
  /// instead, and write alongside the first — defeating the exclusion in exactly
  /// the case it exists for.
  ///
  /// It is not deleted on close either. A close and another process's open race,
  /// and whoever wins that race must not have the file pulled out from under it.
  /// An empty file is a cheap thing to leave behind.
  static func lockName(_ baseName: String) -> String { baseName + ".lock" }

  /// The support bundle for `baseName`, `<base>.support.gz`.
  ///
  /// One fixed name inside the writer's own directory, so a collect can never
  /// be talked into writing somewhere else, and so there is at most one bundle
  /// at a time — a support flow that left one behind per invocation would grow
  /// a second copy of the log next to the first.
  ///
  /// Not an archive: it holds no records rotation produced, retention must not
  /// count it toward a cap or prune it in place of a real archive, and
  /// `getLogFilePaths()` must not hand it to a collector as if it were a log
  /// file. It IS an artifact, so a purge deletes it.
  static func supportName(_ baseName: String) -> String { baseName + ".support.gz" }

  /// Where a bundle is written before it is renamed into place.
  static func supportStagingName(_ baseName: String) -> String {
    supportName(baseName) + ".part"
  }

  /// The scratch file a plaintext source is compressed to on its way into a
  /// bundle.
  ///
  /// Named rather than left anonymous because it holds a compressed copy of a
  /// log file: a process that died mid-collect must not leave one behind that
  /// neither the retention sweep nor a purge knows about.
  static func supportMemberName(_ baseName: String) -> String {
    supportStagingName(baseName) + ".member"
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
    // The support bundle and its staging file. A compliance purge that left a
    // gzipped copy of the whole log next to the files it deleted would not be
    // a purge, and `durable` would be saying something false.
    if name == supportName(baseName) { return true }
    if name == supportStagingName(baseName) { return true }
    if name == supportMemberName(baseName) { return true }
    return isArchiveName(name, baseName: baseName) || isStagingName(name, baseName: baseName)
  }

  /// What follows the rotation stamp, if `suffix` begins with one.
  ///
  /// The stamp grammar — eight digits, `T`, six digits, `Z`, `_`, eight
  /// lowercase hex — is written down HERE and nowhere else; the predicates
  /// above say only which tail they expect after it. That single-place
  /// property used to belong to a regex, and it survives the regex.
  ///
  /// Hand-rolled because `range(of:options:.regularExpression)` compiles the
  /// pattern per call: 1643 ns against 17.7 ns for this scan, twice per
  /// directory entry per sweep, and sweeps run at open, rotation and every
  /// maintain. A hoisted `NSRegularExpression` is NOT the missing fix — it
  /// measured 651 ns, because the NSString bridge and `firstMatch` dominate,
  /// not compilation.
  ///
  /// Two places this is deliberately EXACT where the regex was loose, both
  /// admitting only names rotation actually writes:
  ///
  /// - ICU `$` also matches before a trailing newline, so the regex accepted
  ///   `<stamp>\n` as an archive. This scan requires the tail to reach the
  ///   end of the name.
  /// - ICU `\d` is every Unicode decimal digit, so the regex accepted a stamp
  ///   written in Arabic-Indic digits. `stampFormatter` is `en_US_POSIX` and
  ///   can only produce ASCII.
  ///
  /// Both differences make the purge predicate recognise FEWER names, which
  /// is the direction that needs justifying: neither form is a name this
  /// writer can ever put on disk, so treating them as foreign files is the
  /// truth, not a hole. Pinned by the imposter cases in
  /// `testTheStampGrammarIsExact`.
  private static func tailAfterStamp(_ suffix: Substring) -> Substring.UTF8View.SubSequence? {
    let utf8 = suffix.utf8
    var index = utf8.startIndex

    func take(_ count: Int, _ admits: (UInt8) -> Bool) -> Bool {
      for _ in 0..<count {
        guard index < utf8.endIndex, admits(utf8[index]) else { return false }
        index = utf8.index(after: index)
      }
      return true
    }
    func literal(_ ascii: UInt8) -> Bool {
      guard index < utf8.endIndex, utf8[index] == ascii else { return false }
      index = utf8.index(after: index)
      return true
    }

    let digit: (UInt8) -> Bool = { $0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9") }
    let hex: (UInt8) -> Bool = {
      ($0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9"))
        || ($0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "f"))
    }

    guard take(8, digit), literal(UInt8(ascii: "T")),
          take(6, digit), literal(UInt8(ascii: "Z")),
          literal(UInt8(ascii: "_")), take(8, hex)
    else { return nil }
    return utf8[index...]
  }

  /// The stamp-bearing suffix of `name`, or nil when it is not `<base>.<…>`.
  ///
  /// The prefix check stays a `String.hasPrefix` — canonical equivalence, as
  /// the regex path had — because HFS+ hands names back NFD-normalised, and a
  /// byte-exact check against an NFC `baseName` would stop recognising this
  /// writer's own archives on such a volume. The STAMP is pure ASCII, where
  /// normalisation cannot occur, so byte-scanning it is safe; the base name
  /// is the caller's and is not.
  private static func stampSuffix(_ name: String, baseName: String) -> Substring? {
    let prefix = baseName + "."
    guard name.hasPrefix(prefix) else { return nil }
    return name.dropFirst(prefix.count)
  }

  /// The active file and every archive, newest first — read **on the queue**.
  ///
  /// Rotation, compression, retention and purge all mutate these names, and all
  /// of them run on the queue. Enumerating from the caller's thread would race
  /// every one of them: the honest failure is handing back a `.gz` that is
  /// mid-rename, or an archive that pruning removed a microsecond later, to a
  /// caller whose whole purpose is to open those files.
  ///
  /// Bounded, because this is reachable from the JS thread and the queue may be
  /// wedged on storage that has stopped answering. On timeout the active path is
  /// returned alone: it is the one name this writer owns unconditionally and can
  /// state without reading the directory, whereas a partial archive list would
  /// be indistinguishable from a complete one.
  func logFilePaths() -> [String] {
    let directory = fileURL.deletingLastPathComponent()
    let baseName = fileURL.lastPathComponent

    if DispatchQueue.getSpecific(key: queueKey) == true {
      return [fileURL.path] + Self.archives(in: directory, baseName: baseName).map(\.url.path)
    }

    var snapshot: [String]?
    let group = DispatchGroup()
    group.enter()
    queue.async {
      snapshot = [self.fileURL.path]
        + Self.archives(in: directory, baseName: baseName).map(\.url.path)
      group.leave()
    }
    guard group.wait(timeout: .now() + .milliseconds(Self.pathsDeadlineMs)) != .timedOut,
          let paths = snapshot
    else {
      return [fileURL.path]
    }
    return paths
  }

  /// The same list, for a path this object has no handle for — a **best-effort
  /// directory snapshot**, and the weaker guarantee is the point.
  ///
  /// A sink that opened and then closed still has its files on disk, and a
  /// caller collecting them for support needs their names — see the
  /// `getLogFilePaths` row of `FileSinkLifecycle`'s table. There is no queue to
  /// serialize against here, because there is no handle to reach one through.
  ///
  /// **That is not the same as no writer.** `beginClose` detaches the handle
  /// before `close` has drained, and a close can time out with work still
  /// running, so a caller on another thread can land here while the writer is
  /// finishing a rotation, a compression or a prune. The result is then a read
  /// of a directory that is still moving: an archive mid-rename can be missed
  /// or named a moment before it changes. The live path is queue-confined
  /// precisely to avoid that; this one cannot be, and says so rather than
  /// implying a consistency it does not have. For a support upload — which
  /// opens what it finds and tolerates a file having gone — best effort is the
  /// right trade against answering `[]`.
  ///
  /// The active path is included when it exists. Unlike the live case it is not
  /// unconditional — with no handle there is nothing that owns it, and naming a
  /// file that is not there would send a collector to open nothing.
  static func artifactPaths(at fileURL: URL) -> [String] {
    let directory = fileURL.deletingLastPathComponent()
    let baseName = fileURL.lastPathComponent
    let active = FileManager.default.fileExists(atPath: fileURL.path) ? [fileURL.path] : []
    return active + archives(in: directory, baseName: baseName).map(\.url.path)
  }

  // MARK: - Support bundle deletion

  /// Deletes the support bundle and its staging leftovers — see the spec's
  /// `deleteSupportBundle` for what `true` does and does not promise.
  ///
  /// Queue-confined for the reason `logFilePaths` is, and a sharper one: a
  /// collect publishes by renaming its staging name onto the final one, on this
  /// queue. Unlinking those same two names from the caller's thread would run
  /// inside that rename.
  ///
  /// Bounded, because this is reachable from the JS thread and the queue may be
  /// wedged. A timeout is `false`: nothing was observed, and the one thing this
  /// call must never do is report a bundle gone while it is still on disk.
  ///
  /// `handleGeneration` is checked the way `append` checks it, and on the queue
  /// rather than here: a purge between this call and the block reaching the
  /// front would otherwise have this handle delete the *current* generation's
  /// bundle. Being active is not the same as being current — `liveGeneration()`
  /// answers the first question only — and a stale handle owns nothing in that
  /// directory any more.
  func deleteSupportBundle(handleGeneration: UInt64, deadlineMs: Double) -> Bool {
    // Already on the queue — a nested `async` + `wait` here would deadlock,
    // exactly as `logFilePaths` guards against.
    if DispatchQueue.getSpecific(key: queueKey) == true {
      return deleteIfCurrent(handleGeneration)
    }

    let request = DeleteRequest()
    var removed = false
    let group = DispatchGroup()
    group.enter()
    // No explicit QoS, like every other deadline-bound barrier here: the
    // submission inherits the caller, which is the thread waiting on it. See
    // `queueQoSForTesting`.
    queue.async { [self] in
      // Nothing is cancellable once queued, so the block asks whether it is
      // still wanted rather than being removed.
      if request.begin() { removed = deleteIfCurrent(handleGeneration) }
      group.leave()
    }
    guard group.wait(timeout: .now() + .milliseconds(Self.clampDeadline(deadlineMs)))
      != .timedOut
    else {
      // A timed-out delete is not a cancelled one, and unlike a stale read it
      // does damage. Sitting behind a slow build, this block would otherwise
      // reach the front of the queue *after* that build renamed a fresh bundle
      // into place, and unlink a bundle some later collect had just published
      // and reported the path of — a call that returned "I deleted nothing"
      // deleting somebody else's file, seconds later. This is the same barrier
      // `CollectHandoff.giveUp` puts in front of a publish, for the same
      // reason, in the opposite direction.
      request.abandon()
      return false
    }
    return removed
  }

  /// Deletes only if `handleGeneration` is still the writer's current one.
  ///
  /// Queue only, and the ordering is the point: the generation is read at the
  /// last possible instant before the unlinks, so a purge that landed while
  /// this block waited its turn is seen. Reading it at the call site instead
  /// would compare a number that was true when the caller asked and false by
  /// the time anything was deleted.
  private func deleteIfCurrent(_ handleGeneration: UInt64) -> Bool {
    stateLock.lock()
    let current = generation
    stateLock.unlock()
    // Not this handle's directory any more. The same refusal `append` gives a
    // stale handle, for the same reason, with more at stake: an append that
    // slipped through would add a record to somebody else's file, and a delete
    // that slipped through would remove somebody else's bundle.
    guard handleGeneration == current else { return false }
    return Self.deleteSupportArtifacts(at: fileURL)
  }

  /// One `deleteSupportBundle` call's claim on its own queued block.
  ///
  /// Per call, and shared by exactly the two parties to it — the thread waiting
  /// and the block running — for the reason `CollectHandoff` is per collect: a
  /// writer-wide flag would let one caller's timeout abandon another caller's
  /// deletion.
  ///
  /// The window this does *not* close is the terminal one: a block that has
  /// already passed `begin` runs to completion, so a caller can be told `false`
  /// about a deletion that then happens. That direction is safe — the artifacts
  /// are gone and a retry says so — and it cannot take a later bundle, because
  /// the queue is serial and any subsequent publish is a later task than a
  /// block that has already started.
  private final class DeleteRequest: @unchecked Sendable {
    private let lock = NSLock()
    private var abandoned = false

    /// Claims the right to unlink. `false` once the caller has stopped waiting.
    func begin() -> Bool {
      lock.lock()
      defer { lock.unlock() }
      return !abandoned
    }

    func abandon() {
      lock.lock()
      abandoned = true
      lock.unlock()
    }
  }

  /// Unlinks the three support names under `fileURL`'s directory and reports
  /// whether none of them remains.
  ///
  /// The one implementation, called from two places: on the queue while a
  /// handle is live, and directly for a sink whose handle has gone — the same
  /// split, for the same reason, as `logFilePaths` and `artifactPaths`. What
  /// differs between the callers is what serializes them, never which names get
  /// deleted.
  ///
  /// Absence is success. `removeItem` on a name that was never there fails, and
  /// treating that as a failure would report a surviving bundle for the
  /// overwhelmingly common case of deleting one that was already deleted — so
  /// the verdict is a re-check of the three names rather than the return value
  /// of three removals.
  ///
  /// The directory is synced for the reason the purge syncs it: `unlink`
  /// returning success only puts the change in the directory's in-memory state,
  /// and a crash before that reaches storage brings back a gzipped copy of the
  /// whole log that this call said was gone.
  static func deleteSupportArtifacts(at fileURL: URL) -> Bool {
    let fm = FileManager.default
    let directory = fileURL.deletingLastPathComponent()
    let baseName = fileURL.lastPathComponent
    // Exactly these three, from the same helpers `isArtifactName` uses. Never a
    // directory listing filtered by `isArtifactName`: that matches the log files
    // too, and this call is not a purge.
    let names = [
      supportName(baseName), supportStagingName(baseName), supportMemberName(baseName),
    ]

    for name in names {
      let target = directory.appendingPathComponent(name)
      // The result is deliberately ignored; the loop below is the verdict.
      try? fm.removeItem(at: target)
    }

    // Only ENOENT counts as gone, matching the `Presence.ABSENT` rule the purge
    // applies on both platforms. `fileExists` is the tempting spelling and the
    // wrong one: it answers false for a permissions failure and for an I/O
    // error as readily as for absence, so a directory that has stopped
    // answering would report every artifact deleted.
    let absent = names.allSatisfy { name in
      var info = stat()
      return lstat(directory.appendingPathComponent(name).path, &info) != 0 && errno == ENOENT
    }
    guard absent else { return false }

    // A directory that is not there cannot be opened and has nothing whose
    // removal needs committing; the three names are absent for the strongest
    // possible reason.
    var info = stat()
    if lstat(directory.path, &info) != 0 && errno == ENOENT { return true }
    return syncDirectory(directory)
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
    //
    // Waited against `deadline`, the monotonic budget computed above — not a
    // fresh realtime target. `NSLock.lock(before:)` takes a `Date`, and a
    // clock step during the wait stretches or collapses the budget; the
    // semaphore's `DispatchTime` deadline cannot be moved, and reusing
    // `deadline` also stops the lock wait from quietly restarting the budget
    // the comment above says starts at entry.
    guard purgeLock.wait(timeout: deadline) == .success else {
      stateLock.lock()
      let current = generation
      stateLock.unlock()
      return (
        LogClearOutcome(deletedCount: 0, failedPaths: [fileURL.path], durable: false),
        current
      )
    }
    defer { purgeLock.signal() }

    stateLock.lock()
    generation &+= 1
    let fenced = generation
    loss.removeAll()
    degraded = LogDegradation()
    stateLock.unlock()

    // The whole sweep is ONE queue task, and that is what serialises it against
    // a collect's publish — see the matching note in `buildBundle`. Splitting
    // it into several tasks would let a build's rename land in the middle of a
    // deletion, publishing a bundle the purge has already walked past.
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
      currentFileStart = clock()
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

  /// The queue's own QoS, which must stay `.unspecified`.
  ///
  /// Not a curiosity: a `DispatchQueue` created with a QoS treats it as a
  /// ceiling and discards the QoS of work submitted with `async(qos:)`, so an
  /// assigned QoS here would silently demote every deadline-bound barrier to
  /// it. The appends carry `.utility` on the submission instead, which leaves
  /// the barriers inheriting their caller.
  var queueQoSForTesting: DispatchQoS { queue.qos }

  /// Blocks until everything already enqueued has run, so a test can assert on
  /// the file without racing the writer.
  func settleForTesting() {
    queue.sync {}
  }
}
