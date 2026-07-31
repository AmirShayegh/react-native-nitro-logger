package com.margelo.nitro.nitrologger

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.nio.channels.OverlappingFileLockException
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
  private val monotonic: () -> Long,
  /** See the parameter of the same name on [open]. Null in production. */
  private val openSweepGate: (() -> Unit)? = null
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
     * The exclusion file for [baseName], and **deliberately not an artifact.**
     *
     * It holds zero log bytes — it exists only to be locked — so a purge that
     * leaves it behind has still deleted every byte of log data, and `durable`
     * keeps the compliance meaning it has everywhere else. Deleting it would be
     * worse than useless: an advisory lock lives on the inode, so unlinking the
     * name while a writer holds it lets the next process create a fresh file,
     * lock that instead, and write alongside the first — defeating the exclusion
     * in exactly the case it exists for.
     *
     * It is not deleted on close either. A close and another process's open
     * race, and whoever wins that race must not have the file pulled out from
     * under it. An empty file is a cheap thing to leave behind.
     */
    fun lockName(baseName: String): String = "$baseName.lock"

    /**
     * The support bundle for [baseName], `<base>.support.gz`.
     *
     * One fixed name inside the writer's own directory, so a collect can never
     * be talked into writing somewhere else, and so there is at most one bundle
     * at a time — a support flow that left one behind per invocation would grow
     * a second copy of the log next to the first.
     *
     * Not an archive: it holds no records rotation produced, retention must not
     * count it toward a cap or prune it in place of a real archive, and
     * `getLogFilePaths()` must not hand it to a collector as if it were a log
     * file. It IS an artifact, so a purge deletes it.
     */
    fun supportName(baseName: String): String = "$baseName.support.gz"

    /** Where a bundle is written before it is renamed into place. */
    fun supportStagingName(baseName: String): String = supportName(baseName) + ".part"

    /**
     * The scratch file a plaintext source is compressed to on its way into a
     * bundle.
     *
     * Named rather than left anonymous because it holds a compressed copy of a
     * log file: a process that died mid-collect must not leave one behind that
     * neither the retention sweep nor a purge knows about.
     */
    fun supportMemberName(baseName: String): String = supportStagingName(baseName) + ".member"

    private const val COPY_CHUNK_BYTES = 256 * 1024

    /**
     * A byte ceiling from JavaScript, where every number is a Double.
     *
     * Anything that is not a finite positive number becomes ZERO — nothing
     * fits, no bundle, `truncated = true`. The other direction was tempting
     * ("a broken ceiling means no ceiling") and is wrong: this number is the
     * caller's decision about how much of a log may leave the device, and a
     * `NaN` arriving from some arithmetic upstream must not be read as consent
     * to send all of it. The TypeScript side refuses these before they get
     * here; this is what happens if something else calls the sink directly.
     */
    fun byteCap(value: Double): ULong = when {
      // `isFinite` and not merely `!isNaN`: positive infinity is the most
      // obvious way for a broken calculation to arrive here, and reading it as
      // `ULong.MAX_VALUE` is exactly the fail-open this exists to prevent.
      !value.isFinite() || value <= 0.0 -> 0uL
      value >= ULong.MAX_VALUE.toDouble() -> ULong.MAX_VALUE
      else -> value.toULong()
    }

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
      // The support bundle and its staging file. A compliance purge that left a
      // gzipped copy of the whole log next to the files it deleted would not be
      // a purge, and `durable` would be saying something false.
      if (name == supportName(baseName)) return true
      if (name == supportStagingName(baseName)) return true
      if (name == supportMemberName(baseName)) return true
      return isArchiveName(name, baseName) || isStagingName(name, baseName)
    }

    private fun matches(name: String, baseName: String, pattern: Regex): Boolean {
      val prefix = "$baseName."
      if (!name.startsWith(prefix)) return false
      return pattern.matches(name.substring(prefix.length))
    }

    /**
     * Archives for [baseName], newest first.
     *
     * Ordered by modification time rather than by name. The name's timestamp
     * has one-second resolution, so a burst of rotations inside the same second
     * all share it and only the random suffix differs — sorting by name would
     * keep an arbitrary subset and delete newer archives than it kept. Names
     * break exact ties so the order is still deterministic.
     *
     * On the companion rather than the instance because [artifactPaths] needs
     * it with no writer in existence, and because it reads only the two
     * arguments — it never touched instance state.
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
     * The active file and every archive for [file], for a path the caller has
     * no handle for — a **best-effort directory snapshot**, and the weaker
     * guarantee is the point.
     *
     * A sink that opened and then closed still has its files on disk, and a
     * caller collecting them for support needs their names — see the
     * `getLogFilePaths` row of [FileSinkLifecycle]'s table. There is no
     * executor to serialize against here, because there is no handle to reach
     * one through.
     *
     * **That is not the same as no writer.** `beginClose` detaches the handle
     * before `close` has drained, and a close can time out with work still
     * running, so a caller on another thread can land here while the writer is
     * finishing a rotation, a compression or a prune. The result is then a read
     * of a directory that is still moving: an archive mid-rename can be missed,
     * or named a moment before it changes. The live path is executor-confined
     * precisely to avoid that; this one cannot be, and says so rather than
     * implying a consistency it does not have. For a support upload — which
     * opens what it finds and tolerates a file having gone — best effort is the
     * right trade against answering `[]`.
     *
     * The active path is included when it exists. Unlike the live case it is
     * not unconditional — with no handle there is nothing that owns it, and
     * naming a file that is not there would send a collector to open nothing.
     */
    fun artifactPaths(file: File): List<String> {
      val directory = file.parentFile ?: File(".")
      val active = if (file.exists()) listOf(file.absolutePath) else emptyList()
      return active + archives(directory, file.name).map { it.file.absolutePath }
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
      monotonic: (() -> Long)? = null,
      /**
       * Runs on the executor immediately before the open sweep, so a test can
       * hold the sweep there and observe the writer as it is *before* retention
       * has run.
       *
       * Injected here rather than set on the instance afterwards because the
       * sweep is submitted during construction — by the time a caller has a
       * writer to assign a property on, the sweep may already have run. A
       * process-wide static would reach it in time and is what this replaces:
       * these suites share a JVM, and one test's gate left standing is another
       * test's writer wedged at open.
       */
      openSweepGate: (() -> Unit)? = null
    ): LogFileWriter = LogFileWriter(
      file = file,
      canonicalPath = canonicalPath,
      policy = policy,
      lineFramed = lineFramed,
      platform = platform,
      rawWrite = rawWrite ?: defaultRawWrite,
      compressor = compressor ?: defaultCompressor,
      clock = clock ?: System::currentTimeMillis,
      monotonic = monotonic ?: { System.nanoTime() / 1_000_000L },
      openSweepGate = openSweepGate
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

  /**
   * The exclusion this writer holds on its file, or nulls if it never got one.
   *
   * Taken in [start] on the constructing thread and released by the close
   * barrier on the executor; nothing else touches them, and the executor's own
   * queue orders the two.
   */
  private var lockHandle: RandomAccessFile? = null
  private var fileLock: FileLock? = null

  // State behind stateLock — cheap, never held across I/O.
  private val stateLock = ReentrantLock()
  /** Held for the whole of [clearLogs], so purges cannot interleave. */
  private val purgeLock = ReentrantLock()

  /**
   * One collect at a time per writer.
   *
   * **Not for the reason [purgeLock] exists, and the difference is worth being
   * exact about.** Two builds cannot corrupt each other's staging file: builds
   * run as tasks on the single-threaded [executor], so they are already ordered
   * end to end. This lock does not add that.
   *
   * What it adds is that a second collect does not *enqueue* while a first is
   * running. Without it, N concurrent callers put N full copies of the log on
   * the executor, each one holding up every flush behind it, and each caller
   * then spends its whole deadline waiting for work it never began — and
   * reports a timeout, having caused one. Refusing is both cheaper and truer.
   *
   * **It does not make the bundle path stable for a caller.** There is one
   * well-known bundle name, so a later collect replaces an earlier one's file
   * whether or not they overlapped, and a caller holding a path from a
   * completed collect can always find different bytes there by the time it
   * uploads. That is inherent to the name, not to concurrency.
   */
  private val collectLock = ReentrantLock()
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

    // Before anything is opened or trimmed, because the trim truncates: a
    // second process reaching that with the first one's file would cut bytes
    // out from under it.
    acquireExclusiveLock()
    try {
      openInitially()
    } catch (t: Throwable) {
      // Nothing else will run to give it back — there is no writer to close.
      releaseExclusiveLock()
      throw t
    }
  }

  /**
   * Everything after the exclusion is taken, so one `catch` can give it back.
   */
  private fun openInitially() {
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
    // Submitted, not awaited — and that is the change worth understanding.
    //
    // The executor is single-threaded, so the sweep still runs before the first
    // append's write reaches the disk. That is the only ordering the sweep
    // needs: it moves archives, and nothing can append to an archive it has not
    // finished moving if the append is behind it in the same queue.
    //
    // What waiting cost was an unbounded cross-thread wait taken **while the
    // registry lock is held**. Opening one file with a large backlog of
    // archives to prune therefore stalled every other file's acquire and
    // release, including a close with a deadline it had promised to keep.
    //
    // The trim above stays synchronous. It must finish before any byte is
    // appended, it is what the exclusive lock is taken to protect, and it is
    // bounded by the file's size rather than by the directory's history.
    executor.execute {
      openSweepGate?.invoke()
      sweepRetention()
    }
  }

  /**
   * Takes the process-exclusive claim on this log file, or explains why not.
   *
   * A lock on a file of its own rather than on the active log: rotation renames
   * the active file out from under itself, and a lock follows the inode, so the
   * exclusion would quietly move to an archive at the first rotation and leave
   * the live file unguarded.
   *
   * Three outcomes, and each is a decision. Acquired is the ordinary one.
   * Refused means another process is appending to this file right now, and two
   * processes interleaving mid-record is the collision this whole library is
   * built to prevent — so that one throws. Impossible — a filesystem with no
   * locking — notes [LogDegradation.EXCLUSIVITY] and carries on unlocked,
   * because refusing to log at all would be the worse answer and the caller can
   * read the bit and decide for itself.
   */
  @Throws(LogWriterException::class)
  private fun acquireExclusiveLock() {
    val lockFile = File(directory, lockName(baseName))

    // Never through a symlink. `RandomAccessFile` follows one, and following it
    // would put the lock — and the mode below — on a file nobody chose, and
    // could quietly make two unrelated paths exclude each other. iOS gets this
    // atomically from `O_NOFOLLOW`; here it is a check before the open, the same
    // check-then-open the log file itself uses a few lines down in `reopen`, and
    // acceptable for the same reason: this is app-private storage no other app
    // can write to. The answer is the same on both platforms — no exclusion, the
    // target untouched, logging continues and the bit says so.
    if (LogSecureFile.isSymbolicLink(lockFile, platform)) {
      note(LogDegradation.EXCLUSIVITY)
      return
    }

    val handle = try {
      RandomAccessFile(lockFile, "rw")
    } catch (_: Exception) {
      note(LogDegradation.EXCLUSIVITY)
      return
    }

    // Owner-only like every other file this writer creates. It carries no log
    // bytes, but it is created in the log directory under a name derived from
    // the caller's, and there is no reason for it to be the one file in there
    // that anyone can read.
    if (!LogSecureFile.secure(lockFile, platform)) note(LogDegradation.PROTECTION)

    val acquired = try {
      handle.channel.tryLock()
    } catch (_: OverlappingFileLockException) {
      // The same conflict as a null return, arriving as an exception because
      // the JDK tracks locks per JVM per file rather than per channel. Two
      // writers on one path inside one process is what the registry exists to
      // prevent, so reaching here means two registries — or two copies of this
      // library — which is the same problem with a shorter blast radius.
      null
    } catch (_: Exception) {
      runCatching { handle.close() }
      note(LogDegradation.EXCLUSIVITY)
      return
    }

    if (acquired == null) {
      runCatching { handle.close() }
      throw LogWriterException(
        LogWriterException.Kind.LOCKED,
        "another process is writing this log file"
      )
    }

    lockHandle = handle
    fileLock = acquired
  }

  /** Gives the claim back. Idempotent; the kernel would do it at exit anyway. */
  private fun releaseExclusiveLock() {
    val lock = fileLock
    val handle = lockHandle
    fileLock = null
    lockHandle = null
    runCatching { lock?.release() }
    runCatching { handle?.close() }
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

    // Past the close barrier there is nothing to reopen INTO. `close()` is
    // finished with this writer, so opening a fresh stream would leak it for
    // the life of the process and resurrect a writer that was deliberately
    // shut — and `reopen()` is not a passive call: it recreates the directory,
    // the log file and the sidecar it is closing.
    //
    // The guard lives here rather than at each call site because this is the
    // only place a stream is created on demand. [performWrite] and the purge
    // path already refuse after termination; [syncNow] did not, and it reaches
    // this with `ignoringBackoff = true`, so a flush executing on the write
    // thread past the barrier reopened — reporting itself durable, over a file
    // it had just recreated. Callers read `null` as "no stream", which is the
    // truth: a terminated writer cannot sync.
    //
    // Only PAST the barrier. `close()`'s own flush runs before it, with
    // `terminated` still false, and its reopen is deliberate — that is what
    // `ignoringBackoff` is for, and `a flush reopens a stream lost inside the
    // backoff window` pins it on both platforms. The iOS twin guards
    // `writableHandle` identically, as C7.
    if (terminated) return null

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

  /**
   * Runs the housekeeping the write path would otherwise have to trigger.
   *
   * Rotation and retention only ever run from a write — [rotateIfNeeded] from
   * `performWrite`, [sweepRetention] from open and from rotation — so a sink
   * nobody is logging to keeps whatever it had when the last record landed: an
   * age rotation that never fires, an expired archive that is never deleted, a
   * total-bytes cap that goes on being exceeded. [flush] is not a substitute;
   * it drains the queue and touches neither.
   *
   * On the writer's own executor, like everything else that moves files, so it
   * cannot interleave with a rotation a write is already performing.
   *
   * The status is read after the wait, not after the sweep — those are the same
   * instant only when the sweep finished inside [deadlineMs]. A caller that
   * passes `0`, or whose budget expires behind a wedged write, gets a status
   * describing what the sweep found *so far*. The sweep itself still runs, on
   * the executor, and a status read after it completes carries the rest — not
   * necessarily the very next one, since nothing stops a caller reading again
   * while it is still going.
   */
  fun maintain(handleId: Long, deadlineMs: Double): LogSinkStatus {
    val done = CountDownLatch(1)
    try {
      executor.execute {
        try {
          // Rotation would stop at its own `stream == null` check, but the
          // sweep would not: it works off a directory listing and needs no
          // stream, so a writer whose close has already run would go on
          // expiring archives at whichever writer now holds this path, under a
          // policy that one never agreed to.
          if (!terminated) {
            rotateIfNeeded()
            sweepRetention()
          }
        } finally {
          done.countDown()
        }
      }
      done.await(clampDeadline(deadlineMs), TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (_: RejectedExecutionException) {
      // A close shut the executor down; there is nothing left to maintain.
    }
    return status(handleId)
  }

  /**
   * One collect's handoff between the thread waiting on it and the build
   * running it.
   *
   * Per collect, and shared by exactly those two: a writer-wide flag would let
   * one caller's timeout abandon another caller's build, and a writer-wide
   * "committed" would let one build's success answer another's question. The
   * object is the pairing.
   */
  private class CollectHandoff {
    /** The waiter gave up before anything was published. */
    var abandoned = false
    /** The bundle is on disk. [result] is what to tell the caller about it. */
    var claimed = false
    var result: LogCollectOutcome = LogCollectOutcome.NOTHING
  }

  /**
   * The waiter's half of the publish barrier.
   *
   * Either the build has already renamed a bundle into place — in which case
   * the caller is told about the bundle that exists, however late — or it has
   * not, and this stops it from ever doing so. There is no third answer and no
   * timeout: whoever holds the lock decides, and the only thing the loser waits
   * for is one rename.
   */
  private fun CollectHandoff.giveUp(): LogCollectOutcome = synchronized(this) {
    if (claimed) return result
    abandoned = true
    return LogCollectOutcome.NOTHING
  }

  /**
   * Packs the logs into one gzip bundle for a support upload.
   *
   * gzip is a multi-member format, so the bundle is the members concatenated:
   * an existing `.gz` archive is copied in byte for byte and a plaintext one —
   * the active file, or an archive whose compression was turned off or failed —
   * is compressed through the same compressor rotation uses. That is the whole
   * trick, and it is why this can be done without decompressing anything or
   * holding a log in memory.
   *
   * Written OLDEST first, because that is the order somebody reading the
   * gunzipped result wants; chosen NEWEST first, because that is the half of
   * the log worth keeping when the ceiling cuts it.
   *
   * The whole thing runs on the executor. Rotation, compression and retention
   * all move these files and all run there, so a bundle built from the caller's
   * thread could copy in an archive that is being renamed out from under it.
   */
  fun collectLogs(handleId: Long, deadlineMs: Double, maxTotalBytes: Double): LogCollectOutcome {
    // One absolute instant, computed before any waiting, and every wait below
    // is against it rather than against a fresh budget of its own: the gate,
    // the flush, and the build. A caller that asked for 100 ms means 100 ms for
    // the lot — handing each step the full figure turns the deadline into a
    // multiple of itself.
    val budget = clampDeadline(deadlineMs)
    val expiry = monotonic() + budget

    // One collect at a time per writer — see [collectLock]. Refused, not
    // queued: a second collect that waited its turn would spend the caller's
    // whole deadline before starting and then report a timeout for work it
    // never began, which is a worse answer than "not now".
    //
    // Taken before the flush so the whole call is one exclusive region, and
    // before anything is submitted to the executor, so this refusal leaves
    // nothing enqueued to publish later.
    val acquired = try {
      collectLock.tryLock(budget, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      false
    }
    if (!acquired) return LogCollectOutcome.NOTHING

    try {
      // Everything buffered goes in. A support bundle missing the last few
      // seconds is missing exactly the part somebody is asking about.
      flushUntil(handleId, expiry)

      val handoff = CollectHandoff()
      var outcome = LogCollectOutcome.NOTHING
      val done = CountDownLatch(1)
      try {
        executor.execute {
          try {
            if (!terminated) outcome = buildBundle(handoff, maxTotalBytes)
          } finally {
            done.countDown()
          }
        }
        // The task cannot be cancelled mid-copy, but it CAN be stopped from
        // publishing. Without that it would go on to rename a finished bundle
        // into place seconds after this call reported there was none — a second
        // copy of the whole log, on a device whose app was told nothing was
        // collected, outside the retention budget it configured, and skipped by
        // the orphan sweep because a FINISHED bundle is deliberately kept.
        //
        // Every `giveUp()` below runs BEFORE the `finally` releases the gate,
        // which is the point: a build abandoned under the handoff's own monitor
        // can never publish, so the next collect through the gate cannot find
        // one racing it.
        if (!done.await(remaining(expiry), TimeUnit.MILLISECONDS)) return handoff.giveUp()
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        return handoff.giveUp()
      } catch (_: RejectedExecutionException) {
        // Nothing was ever queued, so there is nothing to stop.
        return LogCollectOutcome.NOTHING
      }
      return outcome
    } finally {
      collectLock.unlock()
    }
  }

  /**
   * One log file on its way into a bundle, and whether it is already a gzip
   * member.
   *
   * Carried rather than inferred from the filename. The active file is always
   * plaintext even when the app named it `app.gz`, and copying it in verbatim
   * on the strength of its extension would produce a `.support.gz` that no
   * tool can open. Only rotation decides whether an archive was compressed, so
   * only rotation's own naming answers this.
   */
  private data class Source(val file: File, val alreadyCompressed: Boolean)

  /** Executor only. See [collectLogs]. */
  private fun buildBundle(handoff: CollectHandoff, maxTotalBytes: Double): LogCollectOutcome {
    val baseName = file.name
    val finalFile = File(directory, supportName(baseName))
    val staging = File(directory, supportStagingName(baseName))

    // Staging only, and deliberately not [finalFile].
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
    // by the rename at the end instead, which needs no pre-delete at all.
    staging.delete()

    // Newest first: the active file, then archives. `archives` already excludes
    // `.part` and — because the bundle is not an archive name — the bundle this
    // call is about to write.
    val sources = mutableListOf<Source>()
    if (file.isFile) sources.add(Source(file, alreadyCompressed = false))
    for (archive in archives(directory, baseName)) {
      sources.add(Source(archive.file, alreadyCompressed = archive.file.name.endsWith(".gz")))
    }

    // Measured on the source bytes. A ceiling that could only be checked after
    // compressing would not bound the work, and the caller's question — how
    // much of my log is leaving this device — is about the log, not about how
    // well it compressed.
    var budget = byteCap(maxTotalBytes)
    val chosen = mutableListOf<Source>()
    var truncated = false
    for (source in sources) {
      val bytes = sizeOrNull(source.file)
      if (bytes == null) {
        // Unmeasurable, so it cannot be charged against the ceiling. Taking it
        // for free is the wrong direction on a number that says how much may
        // leave the device.
        truncated = true
        continue
      }
      // Nothing to contribute. Skipped rather than packed as an empty member,
      // which is what makes a ceiling of zero produce no bundle even when the
      // active file has just been opened and is still empty.
      if (bytes == 0uL) continue
      if (bytes > budget) {
        truncated = true
        continue
      }
      budget -= bytes
      chosen.add(source)
    }
    // Nothing to pack is a finished collect, not a failed one. [truncated]
    // carries the difference between a device with no logs and a ceiling too
    // small to fit any of the ones it has.
    if (chosen.isEmpty()) {
      return LogCollectOutcome("", 0.0, 0.0, truncated = truncated, complete = true)
    }

    var written = 0
    try {
      FileOutputStream(staging).use { sink ->
        // Before a byte of log goes in, not after. A staging file that held
        // records at default permissions for the duration of the copy would be
        // readable for exactly as long as it takes to build a bundle of the
        // whole log, which is the longest this directory is ever interesting.
        if (!LogSecureFile.secure(staging, platform)) note(LogDegradation.PROTECTION)
        // Oldest first, so `gunzip` yields the log in the order it happened.
        for (source in chosen.asReversed()) {
          // Where this member starts, so a copy that dies halfway can be undone
          // rather than left in the stream. Half a gzip member followed by a
          // whole one is not a gzip file, and publishing that as a truncated
          // bundle would hand somebody a file no tool will open.
          //
          // NOT covered by a test, and deliberately kept anyway. Reaching it
          // needs a read or a write that fails PART WAY through a 256 KB chunk
          // — a failing flash chip, a volume that filled between two writes —
          // and there is no seam in this file that can stage one. The member
          // failures the suite can stage (a compressor that refuses, a source
          // that will not open) all fail before a byte is written, where this
          // is a no-op.
          val mark = sink.channel.position()
          if (appendMember(source, sink)) {
            written++
          } else {
            truncated = true
            sink.flush()
            sink.channel.truncate(mark)
            sink.channel.position(mark)
          }
        }
        sink.flush()
        sink.fd.sync()
      }
    } catch (_: Exception) {
      staging.delete()
      note(LogDegradation.GZIP)
      return LogCollectOutcome("", 0.0, 0.0, truncated = truncated, complete = false)
    }
    val failed = LogCollectOutcome("", 0.0, 0.0, truncated = truncated, complete = false)
    if (written == 0) {
      staging.delete()
      return failed
    }

    // Measured here rather than after the rename. A size the platform will not
    // answer for is a bundle nothing can be said about, and saying `complete`
    // with a byte count of zero over a file that is really there would send a
    // support flow looking for a fault in the upload.
    val bytes = sizeOrNull(staging)
    if (bytes == null) {
      staging.delete()
      note(LogDegradation.GZIP)
      return failed
    }

    // **What serialises this against a purge is the executor, not a lock.** The
    // rename below, and `clearLogs`'s whole sweep, are each a single task on
    // this single-threaded executor, so their mutating phases cannot interleave
    // — one runs to completion before the other starts.
    //
    // Stated precisely, because the guarantee is narrower than "purge and
    // collect are mutually exclusive": a purge CAN linearize between this
    // collect's flush and the submission of this build, and then it deletes
    // artifacts this build was about to read. What it cannot do is preempt a
    // build already running. A purge submitted behind a slow compressor waits
    // for it — returning non-durable if its own deadline expires first, then
    // executing when the executor frees.
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
    var published: LogCollectOutcome? = null
    synchronized(handoff) {
      if (handoff.abandoned) {
        staging.delete()
        return failed
      }
      // Through the platform seam rather than `File.renameTo`, which promises
      // neither the atomic replace nor the leave-the-destination-alone-on-
      // failure that make the pre-delete unnecessary. See
      // [PlatformIo.renameReplacing].
      if (!platform.renameReplacing(staging, finalFile)) {
        staging.delete()
        note(LogDegradation.GZIP)
        return failed
      }
      published = LogCollectOutcome(
        path = finalFile.absolutePath,
        byteCount = bytes.toDouble(),
        sourceFileCount = written.toDouble(),
        truncated = truncated,
        complete = true
      )
      handoff.result = published!!
      handoff.claimed = true
    }
    // Outside the barrier, because a mode that could not be applied is a
    // degradation bit rather than a reason to withhold a bundle that exists.
    if (!LogSecureFile.secure(finalFile, platform)) note(LogDegradation.PROTECTION)
    return published!!
  }

  /**
   * Size in bytes, or null for anything that cannot be measured.
   *
   * `length()` answers zero both for an empty file and for one it could not
   * stat, which are opposite facts here — the first contributes nothing and
   * the second is a file whose absence makes the bundle incomplete. `isFile`
   * separates them.
   */
  private fun sizeOrNull(candidate: File): ULong? =
    if (candidate.isFile) candidate.length().coerceAtLeast(0L).toULong() else null

  /**
   * Appends one source as a gzip member. Executor only.
   *
   * An archive rotation already compressed is a member and is copied verbatim.
   * Anything else is compressed to a scratch file first and then copied, rather
   * than compressed straight into the sink: that reuses the compressor rotation
   * uses — the same one a test injects — instead of growing a second
   * compression path that nothing else exercises.
   */
  private fun appendMember(source: Source, sink: FileOutputStream): Boolean {
    if (source.alreadyCompressed) return copyInto(source.file, sink)

    val temporary = File(directory, supportMemberName(file.name))
    temporary.delete()
    try {
      if (!compressor.compress(source.file, temporary)) {
        note(LogDegradation.GZIP)
        return false
      }
      // A compressed copy of a log file, so it gets the same protections every
      // other artifact does for as long as it exists — which is what rotation
      // does with the identical file.
      if (!LogSecureFile.secure(temporary, platform)) note(LogDegradation.PROTECTION)
      return copyInto(temporary, sink)
    } finally {
      temporary.delete()
    }
  }

  /**
   * Streams [source] into [sink] in bounded chunks.
   *
   * Chunked rather than `readBytes()` because the caller's ceiling is on what
   * leaves the device, not on what this is allowed to allocate: a 200 MB
   * archive read whole is a memory spike on the thread of an app that was only
   * trying to file a bug report.
   *
   * A false return may leave bytes in [sink]; the caller rolls them back.
   */
  private fun copyInto(source: File, sink: FileOutputStream): Boolean = try {
    source.inputStream().use { input ->
      val buffer = ByteArray(COPY_CHUNK_BYTES)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        sink.write(buffer, 0, read)
      }
    }
    true
  } catch (_: Exception) {
    note(LogDegradation.GZIP)
    false
  }

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
          closeFaultForTesting?.invoke()
        } finally {
          // All three in `finally`, and no `catch`. A `Throwable` escaping
          // `closeCurrentStream` still propagates and still kills this worker —
          // something genuinely went wrong and pretending otherwise would be
          // worse — but it must not take the path's claim with it.
          // `closeCurrentStream` catches `Exception`, not `Throwable`, so an
          // `Error` escaping here used to strand `closing[path]` for the life of
          // the process: every later open on that path refused with the disk
          // perfectly healthy.
          //
          // The order is the same one the stream-then-claim rule always had: the
          // claim must outlast every byte this writer will ever put on disk, or a
          // replacement process can start appending while the last batch is still
          // landing.
          releaseExclusiveLock()
          // A throwing callback must not cost us the latch. Swallowing is right
          // here and only here — this is registry bookkeeping with nowhere to
          // report, and the caller is still waiting on `done`.
          runCatching { onTerminated?.invoke() }
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
   * Applies all three retention limits. Runs at open, after each rotation, and
   * from [maintain].
   *
   * Still no timer of its own: one that fires in the background is a wakeup the
   * app pays for and a retention policy the JS side is not consulted on. An
   * active process rotates, and rotation sweeps; a quiet one is swept by
   * [maintain], on whatever schedule the app decides — which is what
   * `scheduleMaintenance` is, in TypeScript, where the app can see it.
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
    //
    // The support bundle's staging file is swept for the same reason and by the
    // same pass. The finished bundle is not: it is something a caller asked for
    // and may not have uploaded yet, and deleting it here would make
    // [collectLogs] a race against the next rotation.
    names
      .filter {
        isStagingName(it, baseName) ||
          it == supportStagingName(baseName) ||
          it == supportMemberName(baseName)
      }
      .forEach { remove(File(directory, it)) }

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

      // The whole sweep is ONE executor task, and that is what serialises it
      // against a collect's publish — see the matching note in [buildBundle].
      // Splitting it into several tasks would let a build's rename land in the
      // middle of a deletion, publishing a bundle the purge has already walked
      // past.
      var outcome = LogClearOutcome(0, emptyList(), durable = false)
      val done = CountDownLatch(1)

      try {
        executor.execute {
          try {
            outcome = sweepArtifacts(fenced, reopenIfClean = !terminated)
          } finally {
            done.countDown()
          }
        }
      } catch (_: RejectedExecutionException) {
        // The executor is shut down, which only [close] does. The deletion
        // still has to happen — that is the whole point of this call, and a
        // compliance purge that silently did nothing because the destination
        // had just been disposed is the worst version of this failing. It runs
        // inline instead, once the executor is provably finished.
        //
        // Through 0.2.0 this branch deleted nothing and reported
        // `durable = false`, which contradicted the comment two screens up
        // saying a purge landing after the close barrier still deletes. iOS
        // already behaved as documented, because its block was on the queue
        // before the barrier rather than refused by it.
        //
        // Its own `try`, and not a reliance on the `catch (Exception)` below:
        // an exception raised inside a `catch` block does **not** flow into a
        // sibling clause of the same `try`. Without this, a throwing
        // `directory.list()`, `delete()` or `syncDirectory` would escape
        // `clearLogs` entirely — where the very same failure on the executor
        // path stays inside the task, leaves `outcome` at its non-durable
        // initial value, and returns normally. A purge that throws on one path
        // and returns on the other is the divergence this whole item is about.
        return try {
          purgeInline(fenced, expiry)
        } catch (_: Exception) {
          // Named, not empty. A sweep that died partway cannot say what it
          // removed, and "as far as this call can tell the artifacts are still
          // there" is the fail-closed answer every other refusal here gives.
          // `Error` is deliberately not caught: a linkage failure or an OOM is
          // not a purge that declined.
          LogClearOutcome(0, listOf(file.absolutePath), durable = false)
        } to fenced
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

  /**
   * The purge itself: close the stream, delete every artifact, sync, and — only
   * on a clean sweep, and only if [reopenIfClean] — open a fresh file.
   *
   * Extracted rather than inlined in the executor task because there are now
   * two callers, the task and [purgeInline], and they must not drift. The
   * difference between them is one parameter; everything a compliance caller
   * is told comes from here.
   *
   * **Runs with exactly one mutator, always.** On the executor path that is the
   * executor. On the inline path it is the calling thread, after
   * `awaitTermination` has established that no task can ever run again.
   */
  private fun sweepArtifacts(fenced: Long, reopenIfClean: Boolean): LogClearOutcome {
    closeCurrentStream()

    // An unreadable directory is NOT an empty one. Sweeping an empty list would
    // report a durable purge while every artifact sat untouched behind a
    // permissions or I/O failure — the worst possible lie for this particular
    // call to tell. `list()` returns null for both "not a directory" and "could
    // not read it", so absence has to be established separately.
    val names = directory.list()
    val directoryAbsent =
      names == null && platform.lookup(directory) == PlatformIo.Presence.ABSENT
    if (names == null && !directoryAbsent) {
      return LogClearOutcome(0, listOf(directory.absolutePath), durable = false)
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
      // `delete()` said no. Only a platform that positively reports the path as
      // gone lets this count as deleted — something else removed it between the
      // listing and here. `File.exists()` cannot make that distinction: it
      // returns false for an absent file and for one behind a permissions or
      // I/O failure alike, and treating the second as the first is how a purge
      // reports `durable = true` over artifacts still sitting on disk. For this
      // call, of every lie available, that is the worst one.
      if (platform.lookup(target) == PlatformIo.Presence.ABSENT) {
        deleted += 1
      } else {
        // The path is this package's own artifact name, not user content.
        failures.add(target.absolutePath)
      }
    }

    if (failures.isNotEmpty()) {
      return LogClearOutcome(deleted, failures, durable = false)
    }

    // `delete()` returning true only means the change is in the directory's
    // in-memory state. Until the directory itself is synced, a crash or a power
    // loss can bring every one of those names back — and this call exists
    // precisely to promise they are gone.
    if (!directoryAbsent && !platform.syncDirectory(directory)) {
      return LogClearOutcome(deleted, listOf(directory.absolutePath), durable = false)
    }

    val current = stateLock.withLock { generation }
    if (current != fenced) {
      return LogClearOutcome(deleted, emptyList(), durable = false)
    }

    currentFileSize = 0
    currentFileStart = clock()
    // The purge took the sidecar with everything else, so a rotation that never
    // managed to record its time has nothing left to reconcile: the file that
    // follows is new, not rotated.
    pendingFileStart = null
    // Deletion succeeded whether or not a fresh file could be opened, and
    // `durable` describes the deletion — that is what a compliance caller asked
    // about. Whether the writer is usable again is a separate fact, reported
    // separately, because a handle that rebinds onto a writer with no stream
    // would accept records and lose them.
    //
    // A purge that lands after the close barrier still deletes — that is the
    // whole point of the call — but it must not reopen.
    return LogClearOutcome(
      deletedCount = deleted,
      failedPaths = emptyList(),
      durable = true,
      rebound = if (reopenIfClean) reopen() else false
    )
  }

  /**
   * The purge for a writer whose executor is gone.
   *
   * Reached only when [close] has already shut the executor down, so the
   * submission in [clearLogs] was refused. `awaitTermination` is the
   * serialisation point and it is a strong one: `shutdown()` does not discard
   * queued tasks, it refuses new ones and lets the queue drain, so a `true`
   * return means every task has completed AND the worker has exited. Because
   * `ThreadPoolExecutor` signals termination under its own lock, that also
   * establishes a happens-before edge from the last task to this thread —
   * every field the executor owns is visible here, and no thread can ever
   * mutate them again. That is a stronger guarantee than the executor gave
   * while it was alive.
   *
   * **Never reopens.** This path is post-close by construction, so `rebound` is
   * unconditionally false. It deliberately does not consult `terminated`: a
   * close whose own barrier submission was rejected leaves that flag false over
   * a dead executor, and reopening then would leak a descriptor for the life of
   * the process and leave an empty file where a purge had just promised none.
   */
  private fun purgeInline(fenced: Long, expiry: Long): LogClearOutcome {
    val settled = try {
      executor.awaitTermination(remaining(expiry), TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      false
    }
    // Not settled means work may still be moving these files. Nothing durable
    // can be claimed about a directory something else is still writing to, and
    // the sweep must not start — this is the one thing standing between the
    // inline path and two mutators.
    if (!settled) {
      return LogClearOutcome(0, listOf(file.absolutePath), durable = false)
    }
    return sweepArtifacts(fenced, reopenIfClean = false)
  }

  /** The generation a handle must rebind to after a durable purge. */
  val currentGeneration: Long get() = stateLock.withLock { generation }

  val isClosed: Boolean get() = stateLock.withLock { closed }

  // MARK: - Test support

  /**
   * Runs [block] on the executor and waits for it, bounded.
   *
   * **Test support only** since the open sweep stopped waiting — its callers
   * are `settleForTesting`, `closeStreamForTesting` and the three `*ForTesting`
   * getters, and no production path waits on the executor through here any
   * more.
   *
   * The bound is the whole reason this is not just `onExecutorBounded`'s job
   * spelled out again: an unbounded wait in a test helper is a CI run that
   * hangs rather than fails, and a hung run says less and says it far later.
   * `MAX_DEADLINE_MS` rather than a fresh number, so there is nothing here that
   * can drift away from the clamp everything else is measured against. Nothing
   * asserts the value: it is a hang-guard, not a contract.
   *
   * Returns false if the executor never got there — including
   * `RejectedExecutionException`, so a helper called on an already-closed
   * writer is inert rather than explosive. Callers ignore it, because a false
   * means the test is already failing for some other reason.
   */
  private fun onExecutor(block: () -> Unit): Boolean =
    onExecutorBounded(MAX_DEADLINE_MS, block)

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

  /**
   * Makes the close barrier throw, standing in for an `Error` escaping the
   * stream close.
   *
   * There is no natural way to produce one from a test: `closeCurrentStream`
   * catches `Exception` around the only call that can fail, and the stream is a
   * plain `FileOutputStream`. This hook runs exactly where an escaping
   * `Throwable` would — after the stream is shut, before the claim goes back —
   * so a test using it proves the `finally` returns the claim, not that the hook
   * works.
   *
   * Set it and the writer's worker thread dies on the next close. Nothing resets
   * it; a test that sets it is finished with that writer.
   */
  @Volatile
  var closeFaultForTesting: (() -> Unit)? = null

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
