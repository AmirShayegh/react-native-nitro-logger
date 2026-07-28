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
  private var handle: LogFileHandle? = null

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
    if (handle != null) {
      throw LogWriterException(
        LogWriterException.Kind.CONFIG_CONFLICT,
        "this sink is already open"
      )
    }
    handle = LogWriterRegistry.shared.acquire(
      path = path,
      policy = policyOf(rotation),
      // Absent means absent: without a declared one-record-per-line contract
      // the startup scan must not trim a trailing record, because it cannot
      // tell a torn one from an intentional newline.
      lineFramed = lineFramed ?: false,
      platform = AndroidPlatformIo
    )
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
    val live = handle ?: return AppendResult(
      false, RejectReason.CLOSED, 0.0, 0.0, 0.0, 0.0
    )
    val result = live.appendBatch(batch, entryCount.toLong())
    return AppendResult(
      result.accepted,
      result.rejectReason?.let { wireReason(it) },
      result.status.queuedBytes.toDouble(),
      result.status.lostBytes.toDouble(),
      result.status.lostEntries.toDouble(),
      result.status.degraded.toDouble()
    )
  }

  private fun wireReason(reason: LogRejectReason): RejectReason = when (reason) {
    LogRejectReason.FULL -> RejectReason.FULL
    LogRejectReason.STALE_GENERATION -> RejectReason.STALEGENERATION
    LogRejectReason.CLOSED -> RejectReason.CLOSED
    LogRejectReason.FAILED -> RejectReason.FAILED
  }

  override fun getStatus(): SinkStatus {
    val live = handle ?: return SinkStatus(0.0, 0.0, 0.0, 0.0)
    val status = live.status()
    return SinkStatus(
      status.queuedBytes.toDouble(),
      status.lostBytes.toDouble(),
      status.lostEntries.toDouble(),
      status.degraded.toDouble()
    )
  }

  override fun flush(deadlineMs: Double): FlushOutcome {
    val live = handle ?: return FlushOutcome(false, false, 0.0, 0.0, 0.0, 0.0, 0.0)
    return outcomeOf(live.flush(deadlineMs))
  }

  override fun close(deadlineMs: Double): FlushOutcome {
    val live = handle ?: return FlushOutcome(false, false, 0.0, 0.0, 0.0, 0.0, 0.0)
    val outcome = live.close(deadlineMs)
    handle = null
    return outcomeOf(outcome)
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
    handle?.logFilePaths()?.toTypedArray() ?: emptyArray()

  override fun clearLogs(deadlineMs: Double): ClearOutcome {
    val live = handle ?: return ClearOutcome(0.0, emptyArray(), true, false)
    val outcome = live.clearLogs(deadlineMs)
    return ClearOutcome(
      outcome.deletedCount.toDouble(),
      outcome.failedPaths.toTypedArray(),
      outcome.durable,
      outcome.rebound
    )
  }
}
