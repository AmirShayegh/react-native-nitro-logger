package com.margelo.nitro.nitrologger

import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * M0 spike implementation of the FileSink contract — see the Swift twin for
 * the semantics. M8 replaces the write path with the full LogFileWriter
 * (registry + generations, rotation/gzip/prune, sidecar age, fault recovery).
 */
@DoNotStrip
class HybridFileSink : HybridFileSinkSpec() {
  companion object {
    private const val HARD_CAP_BYTES = 1_048_576L
  }

  private val executor = Executors.newSingleThreadExecutor { r ->
    Thread(r, "com.nitrologger.filesink").apply { isDaemon = true }
  }

  // Guards counters + stream swap only — never held across I/O.
  private val stateLock = Any()
  private var reservedBytes = 0L
  private var lostBytes = 0L
  private var lostEntries = 0L
  private var closed = true
  private var file: File? = null
  private var stream: FileOutputStream? = null

  /** Whether the producer guarantees one `\n`-terminated record per batch
   * line. M8's startup scan trims a torn trailing record only when true. */
  private var lineFramed = false

  override val defaultLogDirectory: String
    get() {
      val context = NitroModules.applicationContext
      // filesDir is Auto-Backup-eligible; logs must never ride a backup.
      val base = context?.noBackupFilesDir ?: File(System.getProperty("java.io.tmpdir") ?: "/tmp")
      return File(base, "logs").absolutePath
    }

  override fun open(path: String, rotation: RotationConfig?, lineFramed: Boolean?) {
    // rotation consumed from M8; numeric clamping happens there too
    // Absent means absent: without a declared one-record-per-line contract
    // the startup scan must not trim a trailing record, because it cannot
    // tell a torn one from an intentional newline.
    this.lineFramed = lineFramed ?: false
    val target = File(path)
    target.parentFile?.mkdirs()
    val out = FileOutputStream(target, /* append = */ true)
    synchronized(stateLock) {
      file = target
      stream = out
      closed = false
    }
  }

  override fun appendBatch(batch: String, entryCount: Double): AppendResult {
    val payload = batch.toByteArray(Charsets.UTF_8)
    val bytes = payload.size.toLong()
    val entries = entryCount.toLong().coerceAtLeast(0)

    val out: FileOutputStream
    synchronized(stateLock) {
      val s = stream
      if (closed || s == null) {
        return AppendResult(false, RejectReason.CLOSED, reservedBytes.toDouble(),
          lostBytes.toDouble(), lostEntries.toDouble(), 0.0)
      }
      if (reservedBytes + bytes > HARD_CAP_BYTES) {
        return AppendResult(false, RejectReason.FULL, reservedBytes.toDouble(),
          lostBytes.toDouble(), lostEntries.toDouble(), 0.0)
      }
      reservedBytes += bytes
      out = s
    }

    executor.execute {
      try {
        out.write(payload)
        synchronized(stateLock) { reservedBytes -= bytes }
      } catch (_: Exception) {
        // Batch is the atomic loss unit.
        synchronized(stateLock) {
          reservedBytes -= bytes
          lostBytes += bytes
          lostEntries += entries
        }
      }
    }

    synchronized(stateLock) {
      return AppendResult(true, null, reservedBytes.toDouble(),
        lostBytes.toDouble(), lostEntries.toDouble(), 0.0)
    }
  }

  override fun getStatus(): SinkStatus = synchronized(stateLock) {
    SinkStatus(reservedBytes.toDouble(), lostBytes.toDouble(), lostEntries.toDouble(), 0.0)
  }

  override fun flush(deadlineMs: Double): FlushOutcome {
    val future = executor.submit {
      val s = synchronized(stateLock) { stream }
      try {
        s?.fd?.sync()
      } catch (_: Exception) {
        // reported via loss counters when the owning batch fails
      }
    }
    val timedOut = try {
      future.get(deadlineMs.toLong().coerceAtLeast(0), TimeUnit.MILLISECONDS)
      false
    } catch (_: TimeoutException) {
      true
    } catch (_: Exception) {
      false
    }
    synchronized(stateLock) {
      return FlushOutcome(!timedOut && reservedBytes == 0L, timedOut,
        reservedBytes.toDouble(), reservedBytes.toDouble(),
        lostBytes.toDouble(), lostEntries.toDouble(), 0.0)
    }
  }

  override fun close(deadlineMs: Double): FlushOutcome {
    synchronized(stateLock) { closed = true }
    val outcome = flush(deadlineMs)
    val s = synchronized(stateLock) { val v = stream; stream = null; v }
    try {
      s?.close()
    } catch (_: Exception) {
    }
    return outcome
  }

  override fun getLogFilePaths(): Array<String> = synchronized(stateLock) {
    val f = file ?: return emptyArray()
    arrayOf(f.absolutePath) // archives join this list in M8
  }

  override fun clearLogs(deadlineMs: Double): ClearOutcome {
    close(deadlineMs)
    val f = synchronized(stateLock) { file } ?: return ClearOutcome(0.0, emptyArray(), true)
    return if (f.delete() || !f.exists()) {
      ClearOutcome(1.0, emptyArray(), true)
    } else {
      ClearOutcome(0.0, arrayOf(f.absolutePath), false)
    }
  }
}
