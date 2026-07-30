package com.margelo.nitro.nitrologger

import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import java.io.File

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
   * The handle, the artifacts flag, and every rule about which combinations are
   * legal — see [FileSinkLifecycle], and `ios/FileSinkLifecycle.swift` for the
   * full transition table.
   *
   * Kept out of this file on purpose. This class needs nitrogen-generated code
   * to compile, so while these rules lived here they went untested on both
   * platforms — which is how the two adapters came to answer the same question
   * differently.
   */
  private val lifecycle = FileSinkLifecycle()

  /**
   * The React instance whose JavaScript built this sink.
   *
   * Captured at construction rather than at [open], and that is the point: the
   * runtime that constructed the hybrid is the runtime whose death has to
   * release it. By the time `open` runs on a reload the instance may already be
   * the *next* one, and a handle recorded against that one would outlive
   * exactly the teardown it exists to survive.
   *
   * Null wherever no instance was ever registered — a JVM test, or a host that
   * does not install `NitroLoggerLifecycle` — and null means the old behaviour,
   * unchanged. See [ReactInstanceEpoch].
   */
  private val owner: Long? = ReactInstanceEpoch.currentOrNull()

  private fun current(): LogFileHandle? = lifecycle.current()

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
   * **This cannot run on Nitro 0.36, and is kept as the hook it would be if
   * that changed.** See `SPIKE-C13.md`; the short version:
   *
   * `HybridObject.CxxPart` holds a `HybridData` whose C++ side holds a JNI
   * *global* reference back to that same `CxxPart`. A global reference is a GC
   * root, so the cycle is rooted outside the Java heap and ART can never
   * collect it — and `CxxPart.javaPart` pins this object along with it. Only
   * `HybridData.resetNative()` breaks that, which is reached only through
   * `dispose()`. So an object nobody disposes is immortal, and its finalizer
   * never runs.
   *
   * Which mattered because a Metro reload tears the JavaScript context down
   * without running any of it: no `close()`, no `dispose()`. The writer
   * survived holding the registry slot and the descriptor, and the next `open`
   * with a different rotation config failed `CONFIG_CONFLICT` against a sink
   * nothing could reach — file logging gone for the life of the process, every
   * reload. iOS never had the problem: `deinit` is not a finalizer and runs
   * deterministically.
   *
   * **That leak is now closed, and not by this method.** The release comes from
   * outside the object entirely: [ReactInstanceEpoch] records which React
   * instance each handle was acquired for, and `NitroLoggerLifecycle.invalidate`
   * — which fires on exactly instance teardown — releases that instance's
   * claims. Nothing has to reach this hybrid to do it, which is the point,
   * because nothing can. `C13ReloadLeakTest` drives a real `ReactHost.reload()`
   * and watches it happen.
   *
   * Left in place rather than deleted because it is still the right hook for
   * the case the epoch cannot see — a hybrid dropped by JavaScript while its
   * instance keeps running — and because the day Nitro breaks that cycle this
   * becomes correct with no other change. Removing it would take the reasoning
   * with it.
   */
  @Suppress("removal", "DEPRECATION")
  protected fun finalize() {
    releaseHandle()
  }

  /**
   * Terminal, unlike [close]: JavaScript may legitimately close a sink and open
   * it again, but a disposed object must not be reopened.
   *
   * Routed through the lifecycle rather than reaching for the handle directly,
   * because a `dispose` racing an in-flight `open` is exactly when that
   * matters: JS can call `dispose` from another thread while `open` is inside
   * `acquire`, and without recording it that acquisition installs a live writer
   * into an object nothing can reach to release. (`finalize` cannot hit that
   * race — a thread inside `open` keeps the object reachable — but it costs
   * nothing to be right by construction rather than by argument.)
   *
   * Idempotent: the detach happens under the lock, so a second call finds
   * nothing. Both callers above can fire for the same object.
   *
   * Zero deadline: a teardown must not wait on a wedged disk, and on the
   * finalizer thread blocking would stall every other object's release.
   */
  private fun releaseHandle() {
    runCatching { lifecycle.beginDispose().handle?.close(0.0) }
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
    // Refused rather than allowed to race a second acquisition: the loser's
    // handle would be unreachable, and unreachable means a later purge never
    // deletes its files. The lock is not held across the acquisition, which
    // does real I/O — see [FileSinkLifecycle].
    //
    // The refusal says which refusal it is. "Already open" and "an earlier open
    // is still being cancelled" are different instructions to the caller: the
    // second is temporary, bounded by the registry's close wait, and retrying
    // is the right response to it.
    when (lifecycle.beginOpen()) {
      FileSinkLifecycle.Claim.GRANTED -> Unit
      FileSinkLifecycle.Claim.ALREADY_OPEN -> throw LogWriterException(
        LogWriterException.Kind.CONFIG_CONFLICT,
        "this sink is already open"
      )
      FileSinkLifecycle.Claim.CLOSING -> throw LogWriterException(
        LogWriterException.Kind.STILL_CLOSING,
        "an earlier open on this sink is still being cancelled; retry"
      )
      FileSinkLifecycle.Claim.DISPOSED -> throw LogWriterException(
        LogWriterException.Kind.CONFIG_CONFLICT,
        "this sink has been disposed"
      )
    }

    // Written by `acquire` the moment it resolves, so the failure path below
    // has the canonical name without asking the filesystem a second question.
    // Still null if resolution itself failed — nothing was resolved, and `path`
    // as spelled here is not a stand-in for a name the registry produced.
    var resolvedPath: String? = null

    val acquired = try {
      LogWriterRegistry.shared.acquire(
        path = path,
        policy = policyOf(rotation),
        // Absent means absent: without a declared one-record-per-line contract
        // the startup scan must not trim a trailing record, because it cannot
        // tell a torn one from an intentional newline.
        lineFramed = lineFramed ?: false,
        platform = AndroidPlatformIo,
        onResolve = { resolvedPath = it },
        owner = owner
      )
    } catch (e: Throwable) {
      // Failed attempts have to release the claim, or a retry is refused
      // forever.
      //
      // The resolved path goes with it: `acquire` creates the log directory
      // before it opens the file, so a throw can still leave artifacts, and
      // they are under the canonical name. Null — resolution never got that
      // far — means there is nothing to enumerate, which is exactly what
      // should be recorded.
      lifecycle.failOpen(resolvedPath)
      throw e
    }

    // A close that arrived mid-acquisition found nothing to hand back and has
    // already returned. Installing now would leave a live writer holding a
    // descriptor nothing can reach or release.
    //
    // Zero deadline: the caller has already been told this sink is closed.
    if (lifecycle.finishOpen(acquired) == FileSinkLifecycle.Installation.ABANDON) {
      acquired.close(0.0)
    }
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

  override fun maintain(deadlineMs: Double): SinkStatus {
    // Same shape as [getStatus], deliberately: a sink nobody has opened has no
    // files to rotate and no archives to sweep, so "nothing to do" is the whole
    // answer and a zeroed status describes it exactly. A closed one is the same
    // — its writer is gone, and the artifacts it left are the registry's to
    // sweep the next time somebody opens that path.
    val live = current() ?: return SinkStatus(0.0, 0.0, 0.0, 0.0)
    val status = live.maintain(deadlineMs)
    return SinkStatus(
      status.queuedBytes.toDouble(),
      status.lostBytes.toDouble(),
      status.lostEntries.toDouble(),
      status.degraded.toDouble()
    )
  }

  override fun collectLogs(deadlineMs: Double, maxTotalBytes: Double): CollectOutcome {
    // No handle, no bundle — and `complete = true`, because a sink that was
    // never opened has finished collecting everything it has. A support flow
    // that treated this as an error would show a failure for an app that simply
    // has no logs yet.
    val live = current()
      ?: return CollectOutcome("", 0.0, 0.0, truncated = false, complete = true)
    val outcome = live.collectLogs(deadlineMs, maxTotalBytes)
    return CollectOutcome(
      outcome.path,
      outcome.byteCount,
      outcome.sourceFileCount,
      outcome.truncated,
      outcome.complete
    )
  }

  override fun flush(deadlineMs: Double): FlushOutcome {
    // One snapshot, so the handle and the answer to give without one cannot
    // disagree about which instant they describe.
    val (live, durableWithoutHandle) = lifecycle.snapshot()
    if (live == null) return noHandleOutcome(durableWithoutHandle)
    return outcomeOf(live.flush(deadlineMs))
  }

  override fun close(deadlineMs: Double): FlushOutcome {
    // Detaching also records the close against an acquisition still in flight,
    // which keeps that writer from being installed into a sink the caller has
    // already closed.
    val detached = lifecycle.beginClose()
    val live = detached.handle ?: return noHandleOutcome(detached.durableWithoutHandle)
    return outcomeOf(live.close(deadlineMs))
  }

  /**
   * What [flush] and [close] answer when there is no handle to ask.
   *
   * `durable` is the whole question, and it differs between the two states that
   * produce no handle. Never opened: nothing was ever accepted, so "every
   * accepted byte reached storage" holds with nothing to check. Opened and
   * since closed: the files are out of reach and this object cannot vouch for
   * them — `true` there would tell the JavaScript batcher to mark loss notices
   * confirmed that may never have reached disk, including after a close that
   * timed out with bytes still pending.
   *
   * This used to be an unconditional `false`, which re-armed notices for a sink
   * that could not owe any; iOS used to be an unconditional `true`.
   */
  private fun noHandleOutcome(durable: Boolean) =
    FlushOutcome(durable, false, 0.0, 0.0, 0.0, 0.0, 0.0)

  private fun outcomeOf(outcome: LogFlushOutcome) = FlushOutcome(
    outcome.durable,
    outcome.timedOut,
    outcome.pendingBytes.toDouble(),
    outcome.status.queuedBytes.toDouble(),
    outcome.status.lostBytes.toDouble(),
    outcome.status.lostEntries.toDouble(),
    outcome.status.degraded.toDouble()
  )

  override fun getLogFilePaths(): Array<String> {
    // Not `current()?.logFilePaths() ?: emptyArray()`. Closing releases a
    // handle; it does not delete files, and `[]` from a closed sink tells a
    // support-upload flow there is nothing to collect over logs that are still
    // on the device. See the `getLogFilePaths` row of [FileSinkLifecycle]'s
    // table, and the iOS twin, which is the same shape.
    val (live, path) = lifecycle.artifactSource()
    if (live != null) return live.logFilePaths().toTypedArray()
    val opened = path ?: return emptyArray()
    return LogFileWriter.artifactPaths(File(opened)).toTypedArray()
  }

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
    val (live, durableWithoutHandle) = lifecycle.snapshot()
    if (live == null) return ClearOutcome(0.0, emptyArray(), durableWithoutHandle, false)
    val outcome = live.clearLogs(deadlineMs)
    return ClearOutcome(
      outcome.deletedCount.toDouble(),
      outcome.failedPaths.toTypedArray(),
      outcome.durable,
      outcome.rebound
    )
  }
}
