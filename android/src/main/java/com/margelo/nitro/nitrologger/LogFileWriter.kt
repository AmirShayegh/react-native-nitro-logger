package com.margelo.nitro.nitrologger

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import java.util.zip.GZIPOutputStream
import kotlin.concurrent.withLock

/**
 * The thing that actually writes, one per canonical path.
 *
 * Handles for the same file share it — see [LogWriterRegistry]. Batching, drop
 * policy and loss notices all live in JavaScript; this side appends pre-batched
 * text, rotates, compresses, prunes and keeps counters. It is deliberately the
 * dumb end.
 *
 * **Two synchronisation domains, and the split is the whole design.**
 * [stateLock] guards counters and the stream swap and is never held across I/O;
 * the single-threaded [executor] owns every byte that touches the disk. That is
 * what makes [status] answerable while the writer thread is stalled on storage
 * that has stopped responding — which the JavaScript side depends on, because
 * its backpressure loop polls exactly then.
 *
 * **Accepted bytes stay reserved until the write terminally completes.** The cap
 * is on bytes in flight, not bytes enqueued, so a burst cannot queue a gigabyte
 * behind a slow disk by virtue of each individual batch fitting.
 *
 * This is a port of the iOS `LogFileWriter`, and the parity is the point: a
 * rotation or purge that behaves differently on the two platforms is a bug
 * report nobody can reproduce. Where the platforms genuinely differ — no
 * `O_NOFOLLOW`, no protection class, `Os.fstat` behind [PlatformIo] — the
 * comment says so rather than papering over it.
 */
class LogFileWriter internal constructor(
  val file: File,
  val canonicalPath: String,
  val policy: LogRotationPolicy,
  val lineFramed: Boolean,
  private val platform: PlatformIo,
  private val rawWrite: RawWrite,
  private val compressor: Compressor,
  /**
   * Epoch millis. Answers "how old is this file" and stamps archive names, both
   * of which have to mean the same thing across a restart — so this one is
   * allowed to jump when the device clock is corrected.
   */
  private val clock: () -> Long,
  /**
   * Monotonic millis. Answers "how much of the budget is left" and "has the
   * backoff elapsed", neither of which may ever be affected by an NTP
   * correction or a user changing the date.
   *
   * The two are separate because a wall clock that jumps forward mid-wait
   * shortens a deadline harmlessly, but one that jumps *backward* extends it —
   * and a close that was promised 200 ms and takes an hour is an ANR. iOS keeps
   * the same split, using `DispatchTime` for deadlines and `Date` for ages.
   */
  private val monotonic: () -> Long
) {
  /**
   * The raw write, injectable so short writes and hard failures can be tested
   * without storage that misbehaves on demand.
   *
   * Returns the number of bytes written, which is allowed to be fewer than
   * asked for. `FileOutputStream.write` loops internally, but it can still
   * throw after having written some of the buffer — so the caller has to treat
   * a failure as "an unknown prefix landed" either way.
   */
  fun interface RawWrite {
    fun write(stream: FileOutputStream, data: ByteArray, offset: Int, length: Int): Int
  }

  /** Archive compression, injectable because the interesting case is failure. */
  fun interface Compressor {
    fun compress(source: File, destination: File): Boolean
  }

  companion object {
    /**
     * Hard cap on payload bytes in flight. Documented as a payload bound: the
     * process still holds the `ByteArray` copies and queue entries on top.
     */
    const val HARD_CAP_BYTES = 1_048_576L

    /** Reads used to find the last record boundary during a startup trim. */
    private const val TAIL_SCAN_WINDOW = 1 shl 20

    /** Successful writes between descriptor-liveness checks. */
    private const val HEALTH_CHECK_STRIDE = 8

    /** How long a failed rotation waits before being attempted again. */
    private const val ROTATION_BACKOFF_MS = 5_000L

    /** How long a failed reopen waits. */
    private const val REOPEN_BACKOFF_MS = 1_000L

    /**
     * Longest any deadline-bounded call will wait. Well short of the ANR
     * window a synchronous crash-path flush has to live inside.
     */
    const val MAX_DEADLINE_MS = 30_000L

    /**
     * How long [logFilePaths] will wait for the executor before answering with
     * the active path alone. Short: this call takes no deadline of its own, and
     * a support-log collection is not worth blocking the JS thread over.
     */
    const val PATHS_DEADLINE_MS = 2_000L

    private const val NEWLINE = '\n'.code.toByte()

    /**
     * `Infinity` means "wait as long as you are allowed to", which is the
     * ceiling — not zero. `NaN` and non-positive values mean no waiting, which
     * is also what a caller passing 0 deliberately asks for.
     */
    fun clampDeadline(value: Double): Long = when {
      value.isNaN() || value <= 0 -> 0L
      value.isInfinite() -> MAX_DEADLINE_MS
      else -> minOf(value, MAX_DEADLINE_MS.toDouble()).toLong()
    }

    private val defaultRawWrite = RawWrite { stream, data, offset, length ->
      stream.write(data, offset, length)
      length
    }

    private val defaultCompressor = Compressor { source, destination ->
      try {
        source.inputStream().use { input ->
          GZIPOutputStream(destination.outputStream().buffered()).use { output ->
            input.copyTo(output, 64 * 1024)
          }
        }
        true
      } catch (_: Exception) {
        false
      }
    }

    /**
     * `<base>.YYYYMMDDTHHMMSSZ_<8 hex>`.
     *
     * Spelled out rather than left to a locale-sensitive formatter so the
     * produced name and [isArchiveName] cannot drift apart — a purge that stops
     * recognising its own archives is a silent compliance failure. The random
     * suffix disambiguates rotations inside the same second, which the
     * one-second stamp cannot.
     */
    private val ARCHIVE_SUFFIX = Regex("""^\d{8}T\d{6}Z_[a-f0-9]{8}(\.gz)?$""")
    private val STAGING_SUFFIX = Regex("""^\d{8}T\d{6}Z_[a-f0-9]{8}\.gz\.part$""")

    /**
     * A finished archive: `<base>.<stamp>` or `<base>.<stamp>.gz`.
     *
     * Deliberately excludes `.part`. A staging file is a compression that was
     * interrupted — counting it as an archive would let it occupy a retention
     * slot a real archive should have, and would hand a truncated gzip to
     * anyone calling `getLogFilePaths()` to collect logs for support.
     */
    fun isArchiveName(name: String, baseName: String): Boolean =
      matches(name, baseName, ARCHIVE_SUFFIX)

    /** A gzip staging file, `<base>.<stamp>.gz.part`. */
    fun isStagingName(name: String, baseName: String): Boolean =
      matches(name, baseName, STAGING_SUFFIX)

    /**
     * Everything this writer can ever put on disk under its directory: the
     * active file, the sidecar, every archive, every gzip staging file.
     *
     * This predicate IS the naming scheme, and `clearLogs` is the reason it is
     * written down in one place. A purge that recognises fewer names than
     * rotation can produce leaves survivors — and an interrupted compression
     * leaving a plaintext orphan that outlives a compliance purge is exactly
     * the failure this is here to prevent.
     */
    fun isArtifactName(name: String, baseName: String): Boolean {
      if (name == baseName) return true
      if (name == "$baseName.meta") return true
      return isArchiveName(name, baseName) || isStagingName(name, baseName)
    }

    private fun matches(name: String, baseName: String, pattern: Regex): Boolean {
      val prefix = "$baseName."
      if (!name.startsWith(prefix)) return false
      return pattern.matches(name.substring(prefix.length))
    }

    @Throws(LogWriterException::class)
    fun open(
      file: File,
      canonicalPath: String,
      policy: LogRotationPolicy,
      lineFramed: Boolean,
      /**
       * Required, with no default on purpose. [PlatformIo.Jvm] is the only
       * thing in this package that touches `java.nio.file`, so a caller who
       * silently fell back to it on Android would reintroduce the API-26
       * problem the seam exists to keep out. Tests pass it explicitly too.
       */
      platform: PlatformIo,
      rawWrite: RawWrite? = null,
      compressor: Compressor? = null,
      clock: (() -> Long)? = null,
      monotonic: (() -> Long)? = null
    ): LogFileWriter = LogFileWriter(
      file = file,
      canonicalPath = canonicalPath,
      policy = policy,
      lineFramed = lineFramed,
      platform = platform,
      rawWrite = rawWrite ?: defaultRawWrite,
      compressor = compressor ?: defaultCompressor,
      clock = clock ?: System::currentTimeMillis,
      monotonic = monotonic ?: { System.nanoTime() / 1_000_000L }
    ).also { it.start() }
  }

  /** Set by the thread factory so the inline-flush guard can recognise itself. */
  @Volatile
  private var writerThread: Thread? = null

  private val executor = Executors.newSingleThreadExecutor(ThreadFactory { runnable ->
    Thread(runnable, "com.nitrologger.filewriter").apply {
      isDaemon = true
      writerThread = this
    }
  })

  // State behind stateLock — cheap, never held across I/O.
  private val stateLock = ReentrantLock()
  /** Held for the whole of [clearLogs], so purges cannot interleave. */
  private val purgeLock = ReentrantLock()
  private var reservedBytes = 0L
  private var generation = 1L
  private var closed = false
  private var degraded = LogDegradation.NONE
  private val loss = HashMap<Long, LongArray>()
  private var lastSyncSucceeded = true
  /** Handles currently holding this writer. The registry evicts at zero. */
  var refCount = 0
    private set

  // State confined to the executor thread.
  private var stream: FileOutputStream? = null
  private var currentFileSize = 0L
  private var currentFileStart = 0L
  private var lastReopenAttempt = Long.MIN_VALUE / 4
  private var rotationBlockedUntil = Long.MIN_VALUE / 4
  /**
   * A rotation's fresh start time that is not safely on disk yet.
   *
   * Set when a rotation archives the file, cleared only once the sidecar has
   * actually been written. While it is set it outranks the sidecar entirely,
   * because the sidecar still holds the *archived* file's age — and every
   * reopen has to survive that, not just the one rotation performs. A failed
   * sidecar write followed by a failed reopen would otherwise send the next
   * backoff retry back to the stale value and restart the rotate-on-every-write
   * runaway.
   */
  private var pendingFileStart: Long? = null
  private var writesSinceHealthCheck = 0
  /**
   * Set by the close barrier, on the executor. Everything enqueued before the
   * barrier still writes; everything after it is refused.
   */
  private var terminated = false
  /** Rotations that got past the backoff guard. Test support. */
  private var rotationAttempts = 0

  private val directory: File get() = file.parentFile ?: File(".")
  private val baseName: String get() = file.name

  private fun start() {
    val shortfall = !LogSecureFile.createDirectory(directory, platform)
    if (shortfall) note(LogDegradation.PROTECTION)

    // The startup trim happens before the append stream exists, through its own
    // read-write descriptor. iOS reads and truncates through the very
    // descriptor it will write with; here the JDK gives no single handle that
    // is both appending and readable, so this is a separate open. The window
    // that opens is the construction of one writer over app-private storage
    // with no other descriptor on the file yet, which is the narrowest form of
    // the problem — but it is a real difference and not worth hiding.
    trimTornTailIfFramed()

    if (!reopen(initial = true)) {
      throw LogWriterException(
        LogWriterException.Kind.OPEN_FAILED,
        "could not open the log file"
      )
    }
    onExecutor { sweepRetention() }
  }

  // MARK: - Reference counting (registry-owned, called under the registry lock)

  fun retain() {
    refCount += 1
  }

  fun releaseOne(): Int {
    refCount -= 1
    return refCount
  }

  // MARK: - Opening

  /**
   * Opens for appending, creating if needed. Every open funnels through here.
   *
   * Append mode is `O_APPEND` underneath, which makes each write land at the
   * current end of file whatever else wrote in between. Without it a second
   * descriptor on the same file — a replaced destination draining late, a stale
   * handle after a rotation — writes from its own stale offset and silently
   * overwrites.
   *
   * There is no `O_NOFOLLOW` equivalent here, so the symlink check is done by
   * the registry before the path is ever handed over, and re-checked here.
   * That is a check-then-open rather than one atomic syscall; on Android the
   * directory is app-private storage that no other app can write to, which is
   * what makes the remaining window acceptable rather than merely unavoidable.
   */
  private fun reopen(initial: Boolean = false): Boolean {
    if (!initial) lastReopenAttempt = monotonic()
    closeCurrentStream()

    if (!LogSecureFile.createDirectory(directory, platform)) note(LogDegradation.PROTECTION)

    val opened = try {
      if (LogSecureFile.isSymbolicLink(file, platform)) null else FileOutputStream(file, true)
    } catch (_: Exception) {
      null
    }

    if (opened == null) {
      // Reset the rotation triggers even though nothing opened. Leaving the
      // size above the threshold makes every later write re-enter rotation,
      // which archives the file again and again until pruning has eaten every
      // real archive.
      currentFileSize = 0
      // `pendingFileStart` deliberately survives a failed open — it is the only
      // record that this file was rotated, and the retry needs it.
      currentFileStart = pendingFileStart ?: clock()
      writesSinceHealthCheck = 0
      return false
    }

    if (!LogSecureFile.secure(file, platform)) note(LogDegradation.PROTECTION)

    stream = opened
    currentFileSize = try {
      opened.channel.size()
    } catch (_: Exception) {
      file.length()
    }
    // A pending rotation time outranks the sidecar, which until it is rewritten
    // still describes the file that was just archived. The write is retried on
    // every reopen and the value is only dropped once it lands, so no number of
    // failed opens in between can send this process back to the stale age.
    val pending = pendingFileStart
    if (pending != null) {
      currentFileStart = pending
      if (writeSidecar(pending)) pendingFileStart = null else note(LogDegradation.SIDECAR)
    } else {
      currentFileStart = creationTimeOf(file)
    }
    writesSinceHealthCheck = 0
    return true
  }

  private fun closeCurrentStream() {
    val live = stream ?: return
    stream = null
    try {
      live.close()
    } catch (_: Exception) {
      // The descriptor is going away regardless.
    }
  }

  /**
   * When the current log file was created, for age-based rotation.
   *
   * **The sidecar is authoritative once it exists.** Age rotation has to survive
   * a restart, so it cannot be measured from when this process happened to open
   * the file — but the filesystem's own answer cannot carry it either.
   * `creationTime()` is API 26, and where it exists it is not reliably
   * populated: several Android filesystems have no birth time and hand back the
   * mtime instead. An mtime advances on *every write*, so a writer that trusted
   * it would see a freshly-created file at every restart and postpone age
   * rotation forever — the exact failure the sidecar was introduced to prevent,
   * which reading the filesystem first quietly reintroduced.
   *
   * So the filesystem is consulted only to *seed* a sidecar that does not exist
   * yet, and only when its answer is plausible (positive, not in the future).
   * After that the recorded value is the only one that counts, and rotation
   * deletes it along with the file it describes.
   */
  private fun creationTimeOf(target: File): Long {
    val now = clock()
    val sidecar = File(directory, "$baseName.meta")
    val recorded = try {
      if (sidecar.isFile) sidecar.readText().trim().toLongOrNull() else null
    } catch (_: Exception) {
      null
    }

    // Positive AND not in the future. A recorded time ahead of the clock is
    // either a corrupt sidecar or one written before the device's time was
    // corrected backwards; either way `now - it` is negative, which reads as
    // "this file is not old yet" and postpones age rotation until wall time
    // catches up — potentially days. Falling through rewrites it.
    if (recorded != null && recorded > 0 && recorded <= now) return recorded

    // `Throwable`, not `Exception`. This is a best-effort enrichment on a path
    // that must never fail to open a log file, and the specific hazard is
    // `NoClassDefFoundError` from an implementation that reached for a class its
    // API level does not have — an `Error`, which `catch (Exception)` would let
    // straight through.
    val reported = try {
      platform.creationTimeMillis(target)
    } catch (_: Throwable) {
      null
    }
    val seed = if (reported != null && reported > 0 && reported <= now) reported else now

    // Without a sidecar, age-based rotation restarts its clock on every open.
    // That degrades the policy rather than breaking the writer, so it is
    // recorded and logging continues.
    if (!writeSidecar(seed)) note(LogDegradation.SIDECAR)
    return seed
  }

  /** Records [value] as the current file's start time. */
  private fun writeSidecar(value: Long): Boolean {
    val sidecar = File(directory, "$baseName.meta")
    return try {
      sidecar.writeText(value.toString())
      if (!LogSecureFile.secure(sidecar, platform)) note(LogDegradation.PROTECTION)
      true
    } catch (_: Exception) {
      false
    }
  }

  /**
   * Cuts a torn trailing record left by a crash — but only when the producer
   * has declared that records are newline-framed.
   *
   * Without that declaration the trailing bytes are indistinguishable from a
   * record that simply contains newlines, and trimming would eat good data to
   * tidy up after a crash that may not have happened.
   */
  private fun trimTornTailIfFramed() {
    if (!lineFramed || !file.isFile || file.length() == 0L) return

    try {
      RandomAccessFile(file, "rw").use { raf ->
        val length = raf.length()
        if (length == 0L) return

        raf.seek(length - 1)
        if (raf.read() == NEWLINE.toInt()) return // already on a record boundary

        // Scan backwards a window at a time rather than giving up after one.
        // A single fixed window is wrong in both directions: a record larger
        // than the window hides its own preceding boundary, and a file whose
        // only content is one incomplete record has no boundary at all.
        val buffer = ByteArray(TAIL_SCAN_WINDOW)
        var end = length
        var keep: Long? = null

        while (end > 0) {
          val start = if (end > TAIL_SCAN_WINDOW) end - TAIL_SCAN_WINDOW else 0L
          val wanted = (end - start).toInt()
          raf.seek(start)
          raf.readFully(buffer, 0, wanted)
          val index = lastIndexOfNewline(buffer, wanted)
          if (index >= 0) {
            keep = start + index + 1
            break
          }
          end = start
        }

        // No newline in the whole file. Under a *declared* framing contract
        // that is not ambiguous — every record ends in one, so a file without
        // any contains no complete record and all of it is torn.
        val target = keep ?: 0L
        if (target < length) raf.setLength(target)
      }
    } catch (_: Exception) {
      // A file that cannot be read is left exactly as it was found.
    }
  }

  private fun lastIndexOfNewline(buffer: ByteArray, length: Int): Int {
    for (i in length - 1 downTo 0) {
      if (buffer[i] == NEWLINE) return i
    }
    return -1
  }

  // MARK: - Appending

  /**
   * Accept or refuse a batch, then write it on the executor.
   *
   * The decision is made entirely under [stateLock] and before anything is
   * enqueued, so the cap holds no matter how many threads are calling: two
   * batches that each fit but do not fit together cannot both be accepted.
   */
  fun append(
    handleId: Long,
    handleGeneration: Long,
    batch: String,
    entryCount: Long
  ): LogAppendResult {
    val data = batch.toByteArray(Charsets.UTF_8)
    val bytes = data.size.toLong()

    stateLock.lock()
    if (closed) return rejectUnlocking(LogRejectReason.CLOSED, handleId)
    if (handleGeneration != generation) {
      return rejectUnlocking(LogRejectReason.STALE_GENERATION, handleId)
    }
    // Validated on both sides of the bridge. An entry count that disagrees with
    // the payload makes every loss number downstream a guess.
    if (entryCount < 0 || entryCount > 1_000_000) {
      return rejectUnlocking(LogRejectReason.FAILED, handleId)
    }
    if ((bytes == 0L) != (entryCount == 0L)) {
      return rejectUnlocking(LogRejectReason.FAILED, handleId)
    }
    if (bytes == 0L) {
      // Nothing to do, and nothing to complain about.
      val status = statusLocked(handleId)
      stateLock.unlock()
      return LogAppendResult(accepted = true, rejectReason = null, status = status)
    }
    if (reservedBytes + bytes > HARD_CAP_BYTES) {
      return rejectUnlocking(LogRejectReason.FULL, handleId)
    }
    reservedBytes += bytes
    val status = statusLocked(handleId)
    stateLock.unlock()

    try {
      executor.execute { performWrite(data, handleId, entryCount, handleGeneration) }
    } catch (_: RejectedExecutionException) {
      // A close shut the executor down between this batch being accepted and
      // being submitted. Two things have to happen and neither is optional:
      // give back the reservation, because nothing will ever run to release it
      // and a leak here permanently inflates `queuedBytes` until the 1 MB cap
      // refuses everything; and refuse the batch rather than letting the
      // exception cross the bridge, since the caller must be told these records
      // did not make it.
      release(bytes)
      return LogAppendResult(
        accepted = false,
        rejectReason = LogRejectReason.CLOSED,
        status = status(handleId)
      )
    }
    return LogAppendResult(accepted = true, rejectReason = null, status = status)
  }

  private fun rejectUnlocking(reason: LogRejectReason, handleId: Long): LogAppendResult {
    val status = statusLocked(handleId)
    stateLock.unlock()
    return LogAppendResult(accepted = false, rejectReason = reason, status = status)
  }

  private fun performWrite(data: ByteArray, handleId: Long, entryCount: Long, writeGeneration: Long) {
    try {
      if (terminated) {
        // Past the close barrier. Anything reaching here was accepted, missed
        // the flush, and has no stream left to go to — reopening one would
        // resurrect a writer the caller has finished with. It is counted lost
        // rather than dropped silently, which matches the `durable = false`
        // and non-zero `pendingBytes` that close already reported.
        record(entryCount, data.size.toLong(), handleId)
        return
      }

      val stale = stateLock.withLock { writeGeneration != generation }
      if (stale) {
        // A purge landed between acceptance and here. These bytes belong to a
        // file that was deliberately deleted, so they are dropped WITHOUT being
        // counted as loss: writing them into the fresh file would resurrect
        // pre-purge data, and reporting them would describe a gap the user
        // asked for.
        return
      }

      val live = writableStream()
      if (live == null) {
        record(entryCount, data.size.toLong(), handleId)
        return
      }

      // The true end of file, not a tracked counter: it is what a partial write
      // has to be rolled back to, and being wrong about it means truncating
      // somebody else's bytes.
      val offsetBefore = try {
        live.channel.size()
      } catch (_: Exception) {
        currentFileSize
      }

      try {
        writeAll(live, data)
        currentFileSize = offsetBefore + data.size
        healthCheckPeriodically()
        rotateIfNeeded()
      } catch (_: Exception) {
        // Roll back to the record boundary the batch started at. A half-written
        // batch is a half-written record, and a half-written record makes the
        // rest of the file unparseable from that point on — the loss would
        // spread from one batch to everything after it.
        try {
          live.channel.truncate(offsetBefore)
          currentFileSize = offsetBefore
        } catch (_: Exception) {
          // Nothing better to try; the batch is counted lost either way.
        }
        record(entryCount, data.size.toLong(), handleId)
        invalidateStreamIfUnlinked()
      }
    } finally {
      release(data.size.toLong())
    }
  }

  /**
   * Writes every byte or throws.
   *
   * `FileOutputStream.write` loops internally, but it is still allowed to throw
   * having written part of the buffer, and an injected [RawWrite] may report a
   * short write directly. Treating either as success is how a log file ends up
   * with a record missing its second half.
   */
  private fun writeAll(target: FileOutputStream, data: ByteArray) {
    var written = 0
    while (written < data.size) {
      val n = rawWrite.write(target, data, written, data.size - written)
      if (n <= 0) throw LogWriterException(LogWriterException.Kind.OPEN_FAILED, "write failed")
      written += n
    }
  }

  // MARK: - Stream liveness (executor only)

  /**
   * The live stream, reopening if the backoff allows.
   *
   * [ignoringBackoff] is for the explicit-durability paths — [flush] and
   * [close]. A caller there is asking for what is buffered to be on storage
   * NOW, and a degraded writer sitting inside its reopen backoff would
   * otherwise report failure and hand back nothing, with no second chance
   * coming. That is exactly the process-death case, where the records being
   * given up on are the ones explaining the shutdown.
   *
   * The parameter comes from SwiftLogger's `FileDestination`, by way of the
   * iOS twin's `writableHandle(ignoringBackoff:)`; both ports had dropped it.
   */
  private fun writableStream(ignoringBackoff: Boolean = false): FileOutputStream? {
    stream?.let { return it }
    if (!ignoringBackoff && monotonic() - lastReopenAttempt < REOPEN_BACKOFF_MS) return null
    reopen()
    return stream
  }

  /**
   * Confirms the stream still points at a file anyone can read.
   *
   * Writes to an unlinked inode succeed forever and land nowhere. No error is
   * raised, so without this an externally deleted log file means silent loss
   * for the rest of the process's life. A link count of zero catches the plain
   * delete and the delete-then-recreate that a path-existence check misses.
   */
  private fun healthCheckPeriodically() {
    writesSinceHealthCheck += 1
    if (writesSinceHealthCheck < HEALTH_CHECK_STRIDE) return
    writesSinceHealthCheck = 0
    invalidateStreamIfUnlinked()
  }

  private fun invalidateStreamIfUnlinked() {
    val live = stream ?: return
    val links = try {
      platform.linkCount(live.fd)
    } catch (_: Exception) {
      -1
    }
    // -1 means the platform cannot say, which is not evidence of deletion.
    if (links != 0) return
    reopen()
  }

  // MARK: - Status, flush, close

  fun status(handleId: Long): LogSinkStatus = stateLock.withLock { statusLocked(handleId) }

  private fun statusLocked(handleId: Long): LogSinkStatus {
    val totals = loss[handleId]
    return LogSinkStatus(
      queuedBytes = reservedBytes,
      lostBytes = totals?.get(1) ?: 0L,
      lostEntries = totals?.get(0) ?: 0L,
      degraded = degraded
    )
  }

  /**
   * Drains and syncs, bounded by a monotonic deadline.
   *
   * The barrier is enqueued behind whatever the executor is already doing, so a
   * writer wedged mid-write times out here rather than blocking the caller
   * forever — which on the crash path is the difference between a partial log
   * and an ANR.
   */
  fun flush(handleId: Long, deadlineMs: Double): LogFlushOutcome =
    flushUntil(handleId, monotonic() + clampDeadline(deadlineMs))

  private fun flushUntil(handleId: Long, expiry: Long): LogFlushOutcome {
    var timedOut = false

    if (Thread.currentThread() === writerThread) {
      // Already on the write thread. Enqueueing and waiting here would be a
      // deadlock against ourselves — the barrier could never run until we
      // returned. Run it inline instead; ordering is preserved either way,
      // because nothing enqueued after us has started.
      syncNow()
    } else {
      val done = CountDownLatch(1)
      try {
        executor.execute {
          try {
            syncNow()
          } finally {
            done.countDown()
          }
        }
        timedOut = !done.await(remaining(expiry), TimeUnit.MILLISECONDS)
      } catch (_: InterruptedException) {
        // Nothing was established about durability, so this reports the same as
        // a timeout — with the interrupt put back, because a caller that is
        // being cancelled has to stay cancellable.
        Thread.currentThread().interrupt()
        timedOut = true
      } catch (_: Exception) {
        // A rejected execution means the executor is gone; nothing is pending
        // that could still become durable.
        timedOut = true
      }
    }

    stateLock.lock()
    val status = statusLocked(handleId)
    val pending = reservedBytes
    val synced = lastSyncSucceeded
    stateLock.unlock()

    return LogFlushOutcome(
      durable = !timedOut && pending == 0L && synced,
      timedOut = timedOut,
      pendingBytes = pending,
      status = status
    )
  }

  /**
   * Executor-confined. Records whether the data actually reached storage, which
   * is the difference between `durable` and "we asked".
   */
  private fun syncNow() {
    // Ignoring the backoff, which is the whole point: this runs only for a
    // caller that asked for durability now. Without it a writer that lost its
    // stream inside the backoff window reports a failed flush and reopens
    // nothing, so the retry the caller is told to make fails the same way.
    val live = writableStream(ignoringBackoff = true)
    if (live == null) {
      stateLock.withLock { lastSyncSucceeded = false }
      return
    }
    val ok = try {
      live.fd.sync()
      true
    } catch (_: Exception) {
      false
    }
    stateLock.withLock { lastSyncSucceeded = ok }
  }

  /**
   * Flushes, then closes the stream — both inside ONE budget.
   *
   * The deadline is computed once, at entry. Giving the flush the full budget
   * and then the close barrier the full budget again means a stalled writer
   * blocks for twice what the caller asked for.
   *
   * [onTerminated] runs on the executor once the stream is really shut,
   * **regardless of whether this call waited that long**. The two are
   * deliberately decoupled: the caller's deadline bounds how long it blocks;
   * the callback reports when the writer actually stopped. The registry needs
   * the second, because releasing a path because a close *gave up waiting*
   * would let a replacement writer open the same file while this one still has
   * a write executing.
   */
  fun close(handleId: Long, deadlineMs: Double, onTerminated: (() -> Unit)? = null): LogFlushOutcome {
    val expiry = monotonic() + clampDeadline(deadlineMs)

    stateLock.withLock { closed = true }

    val outcome = flushUntil(handleId, expiry)

    val done = CountDownLatch(1)
    var submitted = false
    try {
      executor.execute {
        try {
          terminated = true
          closeCurrentStream()
          onTerminated?.invoke()
        } finally {
          done.countDown()
        }
      }
      submitted = true
      // Whatever the flush left of the budget, and nothing more.
      done.await(remaining(expiry), TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (_: RejectedExecutionException) {
      // Never enqueued, so nothing else will ever run it.
    }
    // Only when the barrier never got submitted. Invoking it because the *wait*
    // ended early would run it twice — once here and once on the executor — and
    // the registry's close claim is counted, so a second call releases a path
    // another close still holds.
    if (!submitted) onTerminated?.invoke()
    executor.shutdown()
    return outcome
  }

  /** Milliseconds left on a [monotonic]-based expiry, never negative. */
  private fun remaining(expiry: Long): Long = maxOf(0L, expiry - monotonic())

  private fun release(bytes: Long) {
    stateLock.withLock { reservedBytes = maxOf(0L, reservedBytes - bytes) }
  }

  private fun record(entries: Long, bytes: Long, handleId: Long) {
    if (entries <= 0 && bytes <= 0) return
    stateLock.withLock {
      val totals = loss.getOrPut(handleId) { longArrayOf(0, 0) }
      totals[0] += entries
      totals[1] += bytes
    }
  }

  private fun note(flag: Int) {
    stateLock.withLock { degraded = degraded or flag }
  }

  // MARK: - Rotation (executor only)

  private fun rotateIfNeeded() {
    val live = stream ?: return

    // Two clocks, deliberately. The backoff asks "has enough time passed since
    // the last failure", which must not be re-answered by an NTP correction;
    // the age test asks "how old is this file", which is measured against a
    // creation time recorded on a previous run and so has to be epoch.
    val steady = monotonic()
    if (steady < rotationBlockedUntil) return

    val now = clock()
    val tooBig = currentFileSize >= policy.maxFileSizeBytes
    val tooOld = policy.maxFileAgeSeconds?.let {
      now - currentFileStart >= (it * 1000).toLong()
    } ?: false
    if (!tooBig && !tooOld) return
    rotationAttempts += 1

    try {
      live.fd.sync()
    } catch (_: Exception) {
      // The rename below still moves whatever did land.
    }
    closeCurrentStream()

    val archive = File(directory, "$baseName.${rotationStamp()}")
    if (!file.renameTo(archive)) {
      // Back off. A rotation that fails on every write — a read-only volume, a
      // directory someone removed — would otherwise retry on every single
      // batch, turning a degraded log into a busy one.
      note(LogDegradation.ROTATION)
      rotationBlockedUntil = steady + ROTATION_BACKOFF_MS
      reopen()
      return
    }
    if (!LogSecureFile.secure(archive, platform)) note(LogDegradation.PROTECTION)

    // The sidecar describes the file that was just archived, so it must not
    // survive to date the fresh one: leaving it makes a brand new file look old
    // enough to rotate immediately, on every write.
    //
    // Overwritten rather than deleted, and held in memory until it lands.
    // Deleting was the obvious move and the wrong one — now that the sidecar is
    // authoritative, a deletion that *fails* leaves the archived file's age in
    // charge of the fresh file and causes exactly the runaway this prevents.
    // Recording the intent here and letting `reopen` perform and retry the
    // write is what makes a failed write survivable across as many failed
    // reopens as it takes.
    pendingFileStart = clock()

    if (policy.compressArchives) compress(archive)
    sweepRetention()
    reopen()
  }

  /**
   * Replaces [source] with a gzipped copy, keeping the original if anything
   * goes wrong: a bigger archive beats a lost one.
   *
   * Compression writes to a `.part` staging name and renames on success, so an
   * interruption leaves something the purge recognises rather than a
   * plausible-looking `.gz` that no tool can open.
   */
  private fun compress(source: File) {
    val finalFile = File(source.absolutePath + ".gz")
    val staging = File(finalFile.absolutePath + ".part")
    staging.delete()

    if (!compressor.compress(source, staging)) {
      staging.delete()
      note(LogDegradation.GZIP)
      return
    }
    if (!LogSecureFile.secure(staging, platform)) note(LogDegradation.PROTECTION)

    if (!staging.renameTo(finalFile)) {
      staging.delete()
      note(LogDegradation.GZIP)
      return
    }
    if (!LogSecureFile.secure(finalFile, platform)) note(LogDegradation.PROTECTION)

    if (!source.delete()) {
      // The plaintext original survived alongside the compressed copy. Remove
      // the compressed one instead of leaving two: a plaintext log the caller
      // believes was compressed away is a file nobody remembers to delete.
      finalFile.delete()
      note(LogDegradation.GZIP)
    }
  }

  private fun rotationStamp(): String {
    val stamp = java.text.SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US).apply {
      timeZone = java.util.TimeZone.getTimeZone("UTC")
    }.format(java.util.Date(clock()))
    val suffix = java.util.UUID.randomUUID().toString().replace("-", "").take(8).lowercase(Locale.US)
    return "${stamp}_$suffix"
  }

  // MARK: - Retention (executor only)

  data class Artifact(val file: File, val modified: Long, val size: Long)

  /**
   * Applies all three retention limits. Runs at open and after each rotation.
   *
   * No background timer: an idle process writes nothing, so there is nothing to
   * sweep, and a timer that fires in the background is a wakeup the app pays
   * for. An active process rotates, and rotation sweeps.
   */
  private fun sweepRetention() {
    var failed = false
    fun remove(target: File) {
      if (target.delete()) return
      // Not `exists()`: it returns false both for "already gone" and for "could
      // not tell", and only the first of those is a successful removal.
      if (platform.lookup(target) != PlatformIo.Presence.ABSENT) failed = true
    }

    val names = directory.list()
    if (names == null) {
      // An unreadable directory is not an empty one, and a sweep that silently
      // did nothing would let retention drift without a word.
      note(LogDegradation.PRUNE)
      return
    }

    // Orphaned compressions first. A `.part` is a gzip that was interrupted —
    // by a crash, or by a process that died mid-rotation — and nothing will
    // ever finish it. Compression runs on this same executor, so a staging file
    // seen from here is never one being written.
    names.filter { isStagingName(it, baseName) }.forEach { remove(File(directory, it)) }

    var archives = archives(directory, baseName)

    // Oldest first for age, then count, then total size — each pass works on
    // what the previous one left.
    policy.maxArchiveAgeSeconds?.let { maxAge ->
      val cutoff = clock() - (maxAge * 1000).toLong()
      val expired = archives.filter { it.modified < cutoff }
      expired.forEach { remove(it.file) }
      archives = archives - expired.toSet()
    }

    if (archives.size > policy.maxArchivedFilesCount) {
      val excess = archives.drop(policy.maxArchivedFilesCount)
      excess.forEach { remove(it.file) }
      archives = archives.take(policy.maxArchivedFilesCount)
    }

    policy.maxTotalLogBytes?.let { cap ->
      var total = currentFileSize + archives.sumOf { it.size }
      val remaining = archives.toMutableList()
      // Newest-first order, so dropping from the end sheds the oldest.
      while (total > cap && remaining.isNotEmpty()) {
        val oldest = remaining.removeAt(remaining.size - 1)
        remove(oldest.file)
        total = if (total > oldest.size) total - oldest.size else 0
      }
    }

    if (failed) note(LogDegradation.PRUNE)
  }

  /**
   * Archives for [baseName], newest first.
   *
   * Ordered by modification time rather than by name. The name's timestamp has
   * one-second resolution, so a burst of rotations inside the same second all
   * share it and only the random suffix differs — sorting by name would keep an
   * arbitrary subset and delete newer archives than it kept. Names break exact
   * ties so the order is still deterministic.
   */
  private fun archives(directory: File, baseName: String): List<Artifact> {
    val names = directory.list() ?: return emptyList()
    return names
      .filter { isArchiveName(it, baseName) }
      .map { File(directory, it) }
      .map { Artifact(it, it.lastModified(), it.length()) }
      .sortedWith(compareByDescending<Artifact> { it.modified }.thenByDescending { it.file.name })
  }

  /**
   * The active file and every archive, newest first — read **on the executor**.
   *
   * Rotation, compression, retention and purge all mutate these names, and all
   * of them run on the executor. Enumerating from the caller's thread would
   * race every one of them: the honest failure is handing back a `.gz` that is
   * mid-rename, or an archive that pruning deleted a microsecond later, to a
   * caller whose whole purpose is to open those files.
   *
   * Bounded, because this is reachable from the JS thread and the executor may
   * be wedged on storage that has stopped answering. On timeout the active
   * path is returned alone: it is the one name this writer owns unconditionally
   * and can state without reading the directory, whereas a partial archive list
   * would be indistinguishable from a complete one.
   */
  fun logFilePaths(): List<String> {
    var snapshot: List<String>? = null
    val captured = onExecutorBounded(PATHS_DEADLINE_MS) {
      val paths = mutableListOf(file.absolutePath)
      paths.addAll(archives(directory, baseName).map { it.file.absolutePath })
      snapshot = paths
    }
    return if (captured) snapshot ?: listOf(file.absolutePath) else listOf(file.absolutePath)
  }

  // MARK: - Purge

  /**
   * Deletes every artifact and fences every handle.
   *
   * The generation bumps FIRST and unconditionally. Anything still in flight is
   * dropped when it reaches the executor, and any handle that has not rebound
   * is refused — so a deletion still running cannot race a fresh write, and a
   * partial deletion leaves everyone fenced rather than half of them writing
   * into files that are about to disappear.
   *
   * Only a complete deletion reopens the file. The caller rebinds on
   * `durable && rebound`, and on anything else stays fenced until it retries.
   */
  fun clearLogs(deadlineMs: Double): Pair<LogClearOutcome, Long> {
    // The budget starts HERE, before waiting for anything. Computing it after
    // acquiring the lock would let a caller asking for 100 ms sit behind
    // another purge's full 30 seconds and still believe it was given 100.
    val budget = clampDeadline(deadlineMs)
    val expiry = monotonic() + budget

    // One purge at a time per writer. Two overlapping purges each bump the
    // generation, and the first to finish would otherwise report success for a
    // fence the second has already moved.
    val acquired = try {
      purgeLock.tryLock(budget, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      false
    }
    if (!acquired) {
      val current = stateLock.withLock { generation }
      return LogClearOutcome(0, listOf(file.absolutePath), durable = false) to current
    }

    try {
      stateLock.lock()
      generation += 1
      val fenced = generation
      loss.clear()
      degraded = LogDegradation.NONE
      stateLock.unlock()

      var outcome = LogClearOutcome(0, emptyList(), durable = false)
      val done = CountDownLatch(1)

      try {
        executor.execute {
          try {
            closeCurrentStream()

            // An unreadable directory is NOT an empty one. Sweeping an empty
            // list would report a durable purge while every artifact sat
            // untouched behind a permissions or I/O failure — the worst
            // possible lie for this particular call to tell. `list()` returns
            // null for both "not a directory" and "could not read it", so
            // absence has to be established separately.
            val names = directory.list()
            val directoryAbsent =
              names == null && platform.lookup(directory) == PlatformIo.Presence.ABSENT
            if (names == null && !directoryAbsent) {
              outcome = LogClearOutcome(0, listOf(directory.absolutePath), durable = false)
              return@execute
            }

            var deleted = 0
            val failures = mutableListOf<String>()
            for (name in (names ?: emptyArray())) {
              if (!isArtifactName(name, baseName)) continue
              val target = File(directory, name)
              if (target.delete()) {
                deleted += 1
                continue
              }
              // `delete()` said no. Only a platform that positively reports the
              // path as gone lets this count as deleted — something else removed
              // it between the listing and here. `File.exists()` cannot make
              // that distinction: it returns false for an absent file and for
              // one behind a permissions or I/O failure alike, and treating the
              // second as the first is how a purge reports `durable = true` over
              // artifacts still sitting on disk. For this call, of every lie
              // available, that is the worst one.
              if (platform.lookup(target) == PlatformIo.Presence.ABSENT) {
                deleted += 1
              } else {
                // The path is this package's own artifact name, not user
                // content.
                failures.add(target.absolutePath)
              }
            }

            if (failures.isNotEmpty()) {
              outcome = LogClearOutcome(deleted, failures, durable = false)
              return@execute
            }

            // `delete()` returning true only means the change is in the
            // directory's in-memory state. Until the directory itself is
            // synced, a crash or a power loss can bring every one of those
            // names back — and this call exists precisely to promise they are
            // gone.
            if (!directoryAbsent && !platform.syncDirectory(directory)) {
              outcome = LogClearOutcome(deleted, listOf(directory.absolutePath), durable = false)
              return@execute
            }

            val current = stateLock.withLock { generation }
            if (current != fenced) {
              outcome = LogClearOutcome(deleted, emptyList(), durable = false)
              return@execute
            }

            currentFileSize = 0
            currentFileStart = clock()
            // The purge took the sidecar with everything else, so a rotation
            // that never managed to record its time has nothing left to
            // reconcile: the file that follows is new, not rotated.
            pendingFileStart = null
            // Deletion succeeded whether or not a fresh file could be opened,
            // and `durable` describes the deletion — that is what a compliance
            // caller asked about. Whether the writer is usable again is a
            // separate fact, reported separately, because a handle that rebinds
            // onto a writer with no stream would accept records and lose them.
            //
            // A purge that lands after the close barrier still deletes — that
            // is the whole point of the call — but it must not reopen.
            outcome = LogClearOutcome(
              deletedCount = deleted,
              failedPaths = emptyList(),
              durable = true,
              rebound = if (terminated) false else reopen()
            )
          } finally {
            done.countDown()
          }
        }
      } catch (_: Exception) {
        return LogClearOutcome(0, listOf(file.absolutePath), durable = false) to fenced
      }

      val completed = try {
        done.await(remaining(expiry), TimeUnit.MILLISECONDS)
      } catch (_: InterruptedException) {
        // An interrupted wait establishes nothing about the deletion, and this
        // call must never claim durability it did not observe.
        Thread.currentThread().interrupt()
        false
      }
      if (!completed) {
        return LogClearOutcome(0, listOf(file.absolutePath), durable = false) to fenced
      }
      return outcome to fenced
    } finally {
      purgeLock.unlock()
    }
  }

  /** The generation a handle must rebind to after a durable purge. */
  val currentGeneration: Long get() = stateLock.withLock { generation }

  val isClosed: Boolean get() = stateLock.withLock { closed }

  // MARK: - Test support

  private fun onExecutor(block: () -> Unit) {
    if (Thread.currentThread() === writerThread) {
      block()
      return
    }
    val done = CountDownLatch(1)
    executor.execute {
      try {
        block()
      } finally {
        done.countDown()
      }
    }
    try {
      done.await()
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  /**
   * Runs [block] on the executor and waits at most [budgetMs] for it.
   *
   * Returns whether it actually completed — false for a timeout and false for a
   * shut-down executor, both of which mean the caller must not read whatever
   * [block] was going to produce. A successful `await` is also the happens-before
   * edge that makes what [block] wrote visible here.
   */
  private fun onExecutorBounded(budgetMs: Long, block: () -> Unit): Boolean {
    if (Thread.currentThread() === writerThread) {
      block()
      return true
    }
    val done = CountDownLatch(1)
    return try {
      executor.execute {
        try {
          block()
        } finally {
          done.countDown()
        }
      }
      done.await(budgetMs, TimeUnit.MILLISECONDS)
    } catch (_: RejectedExecutionException) {
      false
    } catch (_: InterruptedException) {
      // "Did it complete" is the question, and an interrupted wait never found
      // out — so the caller takes its fallback. The flag goes back on: swallowing
      // an interrupt is how a thread stops being cancellable.
      Thread.currentThread().interrupt()
      false
    }
  }

  /** Blocks until everything already enqueued has run. */
  fun settleForTesting() = onExecutor {}

  /** Closes the stream so the next write fails, standing in for revoked storage. */
  fun closeStreamForTesting() = onExecutor { closeCurrentStream() }

  /**
   * Shuts the executor down without going through [close], standing in for the
   * window where a concurrent close has torn it down but `closed` is not yet
   * visible to a batch already past the acceptance check.
   */
  fun shutdownExecutorForTesting() {
    executor.shutdownNow()
  }

  /** Blocks the executor until the returned lambda is called. */
  fun stallForTesting(): () -> Unit {
    val gate = CountDownLatch(1)
    executor.execute { gate.await() }
    return { gate.countDown() }
  }

  val trackedFileSizeForTesting: Long get() { settleForTesting(); return currentFileSize }
  val hasLiveStreamForTesting: Boolean get() { settleForTesting(); return stream != null }
  val rotationAttemptsForTesting: Int get() { settleForTesting(); return rotationAttempts }
}
