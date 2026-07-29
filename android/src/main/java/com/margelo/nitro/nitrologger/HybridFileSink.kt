package com.margelo.nitro.nitrologger

import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import java.io.File
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * The Nitro adapter. Everything interesting is in [LogFileWriter]; this
 * translates the bridge's types and holds the handle.
 *
 * The split is deliberate and mirrors iOS: the writer imports nothing from
 * Nitro or Android, so the whole of it runs under plain JUnit. What is left
 * here is argument marshalling, which is the part that cannot be tested off
 * device anyway.
 */
@DoNotStrip
class HybridFileSink : HybridFileSinkSpec() {
  /**
   * Guards [handle] and [mayHaveArtifacts] together, matching the iOS adapter.
   *
   * They have to move under one lock rather than being individually volatile:
   * the question `clearLogs` asks is the *pair* — no handle AND nothing was
   * ever created. Reading them separately lets a close land in between and
   * produce "no handle, never opened", which is the one answer that is never
   * true and the one that reports a durable purge over surviving files.
   */
  private val lock = ReentrantLock()
  private var handle: LogFileHandle? = null

  /**
   * Whether this sink may have put anything on disk.
   *
   * A null handle conflates two states that owe the caller opposite answers:
   * nothing was ever created, and the files are still there but out of reach.
   *
   * Set *before* the acquisition attempt, not after it succeeds. Acquiring
   * creates the log directory and can then fail on the file itself, so a throw
   * is not evidence that nothing was written — and this flag exists precisely
   * to keep a later purge from claiming otherwise. Never cleared: closing
   * releases the handle, it does not unmake the files.
   */
  private var mayHaveArtifacts = false

  /**
   * An [open] past its check and inside `acquire`.
   *
   * Published so a second open is refused instead of racing to install a handle
   * over the first one's, and so [close] can tell "nothing here" from
   * "something is on its way".
   */
  private var opening = false

  /**
   * A [close] that arrived while [opening] was true.
   *
   * That close had no handle to flush and has already returned; this tells the
   * in-flight open to throw away what it acquired rather than install it.
   */
  private var closePending = false

  private fun current(): LogFileHandle? = lock.withLock { handle }

  /**
   * The manual release, which JavaScript can call and usually does not.
   *
   * `@CallSuper`, so `super.dispose()` is not optional — it is what frees the
   * C++ side.
   */
  override fun dispose() {
    releaseHandle()
    super.dispose()
  }

  /**
   * The release that happens whether or not anything asked for one, and the
   * reason this class needs both.
   *
   * A Metro reload tears the JavaScript context down without running any of
   * it, so a JS `dispose()` is never a guarantee. Without this the writer
   * survives the reload holding the registry slot and the descriptor, and the
   * next `open` with a different rotation config fails `CONFIG_CONFLICT`
   * against a sink nothing can reach to close — an every-reload failure during
   * development. iOS gets this from `deinit`; on ART the equivalent is
   * `finalize`, deprecated and still the only hook there is.
   *
   * Best effort by nature: the finalizer thread may never run this. It is a
   * backstop under `dispose`, not a replacement for it.
   */
  @Suppress("removal", "DEPRECATION")
  protected fun finalize() {
    releaseHandle()
  }

  /**
   * Deliberately routed through [close] rather than reaching for the handle
   * directly. `close` is the one place that also records [closePending], and a
   * `dispose` racing an in-flight `open` is exactly when that matters: JS can
   * call `dispose` from another thread while `open` is inside `acquire`, and
   * without the flag that acquisition installs a live writer into a sink
   * nothing can reach to release. (`finalize` cannot hit that race — a thread
   * inside `open` keeps the object reachable — but it costs nothing to be
   * right by construction rather than by argument.)
   *
   * Idempotent: `close` detaches under the lock, so a second call finds
   * nothing. Both callers above can fire for the same object.
   *
   * Zero deadline: a teardown must not wait on a wedged disk, and on the
   * finalizer thread blocking would stall every other object's release.
   */
  private fun releaseHandle() {
    runCatching { close(0.0) }
  }

  override val defaultLogDirectory: String
    get() {
      val context = NitroModules.applicationContext
      // `noBackupFilesDir`, not `filesDir`: the latter is eligible for Android
      // Auto Backup, which would upload the log file to Google Drive. For a
      // package whose entire privacy design is about what may leave the device,
      // shipping the logs off it by default is the one unacceptable default.
      val base = context?.noBackupFilesDir
        ?: File(System.getProperty("java.io.tmpdir") ?: "/tmp")
      return File(base, "logs").absolutePath
    }

  override fun open(path: String, rotation: RotationConfig?, lineFramed: Boolean?) {
    lock.withLock {
      // `opening` counts as open. Acquisition does real I/O — creates the
      // directory, opens the file, may scan a torn tail — so the lock is not
      // held across it, or every `getStatus` would queue behind disk latency,
      // which is the one thing that call must not do. The in-flight attempt is
      // published instead, and a second one is refused rather than allowed to
      // acquire a writer that would overwrite the first: the loser's handle
      // would be unreachable, and unreachable means a later purge never
      // deletes its files.
      if (handle != null || opening) {
        throw LogWriterException(
          LogWriterException.Kind.CONFIG_CONFLICT,
          "this sink is already open"
        )
      }
      opening = true
      closePending = false
      // Before the attempt: see [mayHaveArtifacts].
      mayHaveArtifacts = true
    }

    val acquired = try {
      LogWriterRegistry.shared.acquire(
        path = path,
        policy = policyOf(rotation),
        // Absent means absent: without a declared one-record-per-line contract
        // the startup scan must not trim a trailing record, because it cannot
        // tell a torn one from an intentional newline.
        lineFramed = lineFramed ?: false,
        platform = AndroidPlatformIo
      )
    } catch (e: Throwable) {
      // Failed attempts have to clear the flag, or a retry is refused forever.
      lock.withLock { opening = false }
      throw e
    }

    val abandon = lock.withLock {
      opening = false
      val pending = closePending
      closePending = false
      // A close that arrived mid-acquisition found nothing to hand back and has
      // already returned. Installing now would leave a live writer holding a
      // descriptor nothing can reach or release.
      if (!pending) handle = acquired
      pending
    }

    // Zero deadline: the caller has already been told this sink is closed.
    if (abandon) acquired.close(0.0)
  }

  private fun policyOf(rotation: RotationConfig?): LogRotationPolicy {
    if (rotation == null) return LogRotationPolicy.of()
    return LogRotationPolicy.of(
      maxFileSizeBytes = rotation.maxFileSizeBytes,
      maxArchivedFilesCount = rotation.maxArchivedFilesCount,
      maxFileAgeSeconds = rotation.maxFileAgeSeconds,
      compressArchives = rotation.compressArchives,
      maxArchiveAgeSeconds = rotation.maxArchiveAgeSeconds,
      maxTotalLogBytes = rotation.maxTotalLogBytes
    )
  }

  override fun appendBatch(batch: String, entryCount: Double): AppendResult {
    val live = current() ?: return AppendResult(
      false, RejectReason.CLOSED, 0.0, 0.0, 0.0, 0.0
    )
    // Refused rather than coerced, matching `Int(exactly:)` on iOS. A count
    // that does not survive the round trip cannot be trusted to describe the
    // batch it arrived with. See [BridgeNumber.exactLong].
    val exact = BridgeNumber.exactLong(entryCount)
      ?: return wireResult(
        LogAppendResult(false, LogRejectReason.FAILED, live.status())
      )
    return wireResult(live.appendBatch(batch, exact))
  }

  private fun wireResult(result: LogAppendResult): AppendResult = AppendResult(
    result.accepted,
    result.rejectReason?.let { wireReason(it) },
    result.status.queuedBytes.toDouble(),
    result.status.lostBytes.toDouble(),
    result.status.lostEntries.toDouble(),
    result.status.degraded.toDouble()
  )

  private fun wireReason(reason: LogRejectReason): RejectReason = when (reason) {
    LogRejectReason.FULL -> RejectReason.FULL
    LogRejectReason.STALE_GENERATION -> RejectReason.STALEGENERATION
    LogRejectReason.CLOSED -> RejectReason.CLOSED
    LogRejectReason.FAILED -> RejectReason.FAILED
  }

  override fun getStatus(): SinkStatus {
    val live = current() ?: return SinkStatus(0.0, 0.0, 0.0, 0.0)
    val status = live.status()
    return SinkStatus(
      status.queuedBytes.toDouble(),
      status.lostBytes.toDouble(),
      status.lostEntries.toDouble(),
      status.degraded.toDouble()
    )
  }

  override fun flush(deadlineMs: Double): FlushOutcome {
    val live = current() ?: return FlushOutcome(false, false, 0.0, 0.0, 0.0, 0.0, 0.0)
    return outcomeOf(live.flush(deadlineMs))
  }

  override fun close(deadlineMs: Double): FlushOutcome {
    // Detached before the close runs, so a concurrent caller cannot pick up a
    // handle that is on its way out.
    val live = lock.withLock {
      val current = handle
      handle = null
      // Nothing to close, but an acquisition is in flight and will finish after
      // this returns. Recording the intent keeps that writer from being
      // installed into a sink the caller has already closed.
      if (current == null && opening) closePending = true
      current
    } ?: return FlushOutcome(false, false, 0.0, 0.0, 0.0, 0.0, 0.0)
    return outcomeOf(live.close(deadlineMs))
  }

  private fun outcomeOf(outcome: LogFlushOutcome) = FlushOutcome(
    outcome.durable,
    outcome.timedOut,
    outcome.pendingBytes.toDouble(),
    outcome.status.queuedBytes.toDouble(),
    outcome.status.lostBytes.toDouble(),
    outcome.status.lostEntries.toDouble(),
    outcome.status.degraded.toDouble()
  )

  override fun getLogFilePaths(): Array<String> =
    current()?.logFilePaths()?.toTypedArray() ?: emptyArray()

  override fun clearLogs(deadlineMs: Double): ClearOutcome {
    // Never opened: nothing was created, so "every artifact is gone" holds
    // vacuously. Opened and since closed: the files are still on disk and this
    // object cannot reach them, so the only honest answer is `durable = false`.
    // The registry draws the same distinction for a released handle, but
    // `close` nils the handle below before that branch is reachable.
    //
    // Reporting a durable purge over surviving files is the worst lie this API
    // can tell: the caller asking is the one deleting patient data on request.
    //
    // Both fields are read in one critical section: a close landing between two
    // separate reads would show "no handle, nothing created", which is the one
    // combination that is never true and the one that lies in the dangerous
    // direction.
    val live = lock.withLock {
      handle ?: return ClearOutcome(0.0, emptyArray(), !mayHaveArtifacts, false)
    }
    val outcome = live.clearLogs(deadlineMs)
    return ClearOutcome(
      outcome.deletedCount.toDouble(),
      outcome.failedPaths.toTypedArray(),
      outcome.durable,
      outcome.rebound
    )
  }
}
