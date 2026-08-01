package com.margelo.nitro.nitrologger

import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.ArrayBuffer

/**
 * The Nitro adapter: marshalling, and nothing else.
 *
 * Everything interesting is in [LogFileWriter] and [FileSinkAnswers]; what is
 * left here is copying `Wire*` values into the nitrogen types field for field,
 * and reading the one thing only this class can reach — the application
 * context.
 *
 * The split is deliberate and mirrors iOS. This class extends a
 * nitrogen-generated base and needs the native side to compile, so anything
 * with a decision in it that stays here is a decision no JVM test can reach.
 * That is not a hypothetical cost: while the no-handle rules lived here they
 * were untested on both platforms, which is how the two adapters came to answer
 * the same question differently, and the one bug found in this layer this
 * release was caught by review rather than by a test for exactly that reason.
 *
 * Anything that grows logic in this file has been put in the wrong place.
 * `__tests__/adapterThinness.test.js` enforces that with a line ceiling and
 * a ban on `lifecycle.` calls here.
 */
@DoNotStrip
class HybridFileSink : HybridFileSinkSpec() {
  private val answers = FileSinkAnswers()

  /**
   * The manual release, which JavaScript can call and usually does not.
   *
   * `@CallSuper`, so `super.dispose()` is not optional — it is what frees the
   * C++ side.
   */
  override fun dispose() {
    answers.releaseHandle()
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
    answers.releaseHandle()
  }

  override val defaultLogDirectory: String
    get() {
      val context = NitroModules.applicationContext
      // `noBackupFilesDir`, not `filesDir`: the latter is eligible for Android
      // Auto Backup, which would upload the log file to Google Drive. For a
      // package whose entire privacy design is about what may leave the device,
      // shipping the logs off it by default is the one unacceptable default.
      //
      // Read here because only this class can reach the context. What is done
      // with it — the fallback, and the `logs` subdirectory — is in
      // [FileSinkAnswers.defaultLogDirectory], where a test can see it.
      return answers.defaultLogDirectory(context?.noBackupFilesDir)
    }

  override fun open(path: String, rotation: RotationConfig?, lineFramed: Boolean?) {
    answers.open(path, policyOf(rotation), lineFramed)
  }

  override fun appendBatch(batch: ArrayBuffer, entryCount: Double): AppendResult {
    // Copied, not borrowed: the buffer is JS-owned and only safe inside this
    // call, and the writer enqueues. `getBuffer(copyIfNeeded = false)` views
    // the JS bytes in place; the read into the array is the one copy — where
    // the String this took through 0.3.x crossed JNI as UTF-16 (~2× for JSON
    // Lines) and was re-encoded to UTF-8 under the handle lock.
    val view = batch.getBuffer(copyIfNeeded = false)
    val bytes = ByteArray(view.remaining())
    view.get(bytes)
    return wireResult(answers.appendBatch(bytes, entryCount))
  }

  override fun getStatus(): SinkStatus = wireStatus(answers.getStatus())

  override fun maintain(deadlineMs: Double): SinkStatus =
    wireStatus(answers.maintain(deadlineMs))

  override fun collectLogs(deadlineMs: Double, maxTotalBytes: Double): CollectOutcome =
    answers.collectLogs(deadlineMs, maxTotalBytes).let {
      CollectOutcome(it.path, it.byteCount, it.sourceFileCount, it.truncated, it.complete)
    }

  override fun flush(deadlineMs: Double): FlushOutcome = outcomeOf(answers.flush(deadlineMs))

  override fun close(deadlineMs: Double): FlushOutcome = outcomeOf(answers.close(deadlineMs))

  override fun getLogFilePaths(): Array<String> = answers.getLogFilePaths().toTypedArray()

  override fun deleteSupportBundle(deadlineMs: Double): Boolean =
    answers.deleteSupportBundle(deadlineMs)

  override fun clearLogs(deadlineMs: Double): ClearOutcome =
    answers.clearLogs(deadlineMs).let {
      ClearOutcome(it.deletedCount, it.failedPaths.toTypedArray(), it.durable, it.rebound)
    }

  // MARK: - Marshalling

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

  private fun wireStatus(status: WireSinkStatus) = SinkStatus(
    status.queuedBytes,
    status.lostBytes,
    status.lostEntries,
    status.degraded
  )

  private fun wireResult(result: WireAppendResult) = AppendResult(
    result.accepted,
    result.rejectReason?.let { wireReason(it) },
    result.queuedBytes,
    result.lostBytes,
    result.lostEntries,
    result.degraded
  )

  private fun wireReason(reason: WireRejectReason): RejectReason = when (reason) {
    WireRejectReason.FULL -> RejectReason.FULL
    WireRejectReason.STALE_GENERATION -> RejectReason.STALEGENERATION
    WireRejectReason.CLOSED -> RejectReason.CLOSED
    WireRejectReason.FAILED -> RejectReason.FAILED
  }

  private fun outcomeOf(outcome: WireFlushOutcome) = FlushOutcome(
    outcome.durable,
    outcome.timedOut,
    outcome.pendingBytes,
    outcome.queuedBytes,
    outcome.lostBytes,
    outcome.lostEntries,
    outcome.degraded
  )
}
