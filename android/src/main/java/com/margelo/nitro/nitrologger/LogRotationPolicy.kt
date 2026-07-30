package com.margelo.nitro.nitrologger

/**
 * Rotation and retention for one log file.
 *
 * Every field is clamped on the way in. These numbers arrive from JavaScript,
 * where `NaN`, `Infinity` and `-1` are all ordinary values, and an unchecked
 * `Double.toLong()` of any of them is silently wrong rather than loud — `NaN`
 * becomes 0, which would turn "rotate at 10 MB" into "rotate on every write".
 *
 * The clamping rules are the iOS writer's, deliberately: a policy that behaves
 * differently on the two platforms is a bug report nobody can reproduce.
 */
data class LogRotationPolicy(
  val maxFileSizeBytes: Long,
  val maxArchivedFilesCount: Int,
  val maxFileAgeSeconds: Double?,
  val compressArchives: Boolean,
  val maxArchiveAgeSeconds: Double?,
  val maxTotalLogBytes: Long?
) {
  companion object {
    /** Effectively "no limit" while still fitting in the types below. */
    private const val BYTE_CEILING = 1_000_000_000_000_000L
    private const val COUNT_CEILING = 10_000
    private const val SECONDS_CEILING = 1e9

    const val DEFAULT_MAX_FILE_SIZE_BYTES = 10_485_760L
    const val DEFAULT_MAX_ARCHIVED_FILES = 5

    fun of(
      maxFileSizeBytes: Double = DEFAULT_MAX_FILE_SIZE_BYTES.toDouble(),
      maxArchivedFilesCount: Double = DEFAULT_MAX_ARCHIVED_FILES.toDouble(),
      maxFileAgeSeconds: Double? = null,
      compressArchives: Boolean = false,
      maxArchiveAgeSeconds: Double? = null,
      maxTotalLogBytes: Double? = null
    ): LogRotationPolicy = LogRotationPolicy(
      maxFileSizeBytes = bytes(maxFileSizeBytes, DEFAULT_MAX_FILE_SIZE_BYTES),
      maxArchivedFilesCount = count(maxArchivedFilesCount, DEFAULT_MAX_ARCHIVED_FILES),
      maxFileAgeSeconds = seconds(maxFileAgeSeconds),
      compressArchives = compressArchives,
      maxArchiveAgeSeconds = seconds(maxArchiveAgeSeconds),
      maxTotalLogBytes = optionalBytes(maxTotalLogBytes)
    )

    /**
     * `Infinity` clamps UP, to the ceiling. It reads as "never rotate", and
     * folding it into the default — or into zero — would turn a request for no
     * rotation into constant rotation. Only `NaN` and non-positive values fall
     * back, because those carry no intent to honour.
     */
    private fun bytes(value: Double, fallback: Long): Long = when {
      value.isNaN() || value < 1 -> fallback
      value.isInfinite() -> BYTE_CEILING
      else -> minOf(value, BYTE_CEILING.toDouble()).toLong()
    }

    /**
     * Same rule as [bytes], and for a sharper reason: this limit is what
     * pruning deletes down to.
     *
     * A literal zero is a real instruction — "keep no archives" — so it is
     * honoured. `NaN` and negatives are not instructions at all, and folding
     * them into zero would make one malformed number from JavaScript delete
     * every rotated file on the next sweep. They fall back to the default
     * instead: retaining five archives nobody asked for is recoverable, and
     * deleting the lot is not.
     */
    private fun count(value: Double, fallback: Int): Int = when {
      value.isNaN() || value < 0 -> fallback
      value.isInfinite() -> COUNT_CEILING
      else -> minOf(value, COUNT_CEILING.toDouble()).toInt()
    }

    /**
     * Optional limits read `Infinity` as absence: "no age cap" and "no cap at
     * all" are the same instruction, and null is how this type spells it.
     */
    private fun seconds(value: Double?): Double? {
      if (value == null || !value.isFinite() || value <= 0) return null
      return minOf(value, SECONDS_CEILING)
    }

    private fun optionalBytes(value: Double?): Long? {
      if (value == null || !value.isFinite() || value < 1) return null
      return minOf(value, BYTE_CEILING.toDouble()).toLong()
    }
  }
}

/**
 * Payload-free record of what has stopped working.
 *
 * A bitmask rather than messages on purpose: these cross into JavaScript and
 * eventually into a log file, and a path or an errno string is exactly the kind
 * of thing that carries a username in it.
 */
object LogDegradation {
  const val NONE = 0
  const val ROTATION = 1 shl 0
  const val GZIP = 1 shl 1
  const val PRUNE = 1 shl 2
  const val SIDECAR = 1 shl 3
  const val PROTECTION = 1 shl 4

  /**
   * This writer holds no exclusive claim on its file, because the filesystem
   * would not give one.
   *
   * Not a failure to write — the log keeps working — but a failure of the
   * promise that one process at a time owns this file, and the caller is the
   * only one who can decide whether that matters. Proceeding unlocked is the
   * deliberate choice: refusing to log because a filesystem does not support
   * locking would be a worse answer than logging without the guarantee.
   */
  const val EXCLUSIVITY = 1 shl 5
}

enum class LogRejectReason(val wire: String) {
  FULL("full"),
  STALE_GENERATION("staleGeneration"),
  CLOSED("closed"),
  FAILED("failed")
}

data class LogSinkStatus(
  val queuedBytes: Long,
  val lostBytes: Long,
  val lostEntries: Long,
  val degraded: Int
)

data class LogAppendResult(
  val accepted: Boolean,
  val rejectReason: LogRejectReason?,
  val status: LogSinkStatus
)

/**
 * Numbers arriving from JavaScript, which reach Kotlin as [Double].
 *
 * This lives here rather than in the Nitro adapter so the JUnit suite can
 * reach it: the adapter needs a device, and this is the part worth testing.
 */
object BridgeNumber {
  /**
   * [value] as an exact [Long], or null if it was never one.
   *
   * `Double.toLong()` saturates and truncates rather than failing, so every
   * check has to happen before the conversion. NaN would become 0 — which then
   * passes the writer's own checks whenever the batch is empty too — each
   * infinity would become a bound, and 2.5 would become 2, an accepted batch
   * carrying a count nobody sent. iOS refuses all of these via `Int(exactly:)`;
   * this is the same refusal.
   */
  fun exactLong(value: Double): Long? {
    if (!value.isFinite()) return null
    if (value != Math.floor(value)) return null
    // Integral is not sufficient: 1e19 has no fractional part and still does
    // not fit, and `toLong()` would clamp it to Long.MAX_VALUE.
    //
    // The two bounds are deliberately not symmetric, because the two constants
    // are not. Long.MIN_VALUE is -2^63, exactly representable as a Double, so
    // it converts and the comparison is inclusive. Long.MAX_VALUE is 2^63 - 1,
    // which is NOT representable — `Long.MAX_VALUE.toDouble()` rounds UP to
    // 2^63. An inclusive upper bound would therefore admit 2^63 itself and let
    // `toLong()` saturate it to 2^63 - 1: a silently different number, which is
    // the precise failure this function exists to prevent. Hence `>=`.
    if (value < Long.MIN_VALUE.toDouble() || value >= Long.MAX_VALUE.toDouble()) return null
    return value.toLong()
  }
}

data class LogFlushOutcome(
  val durable: Boolean,
  val timedOut: Boolean,
  val pendingBytes: Long,
  val status: LogSinkStatus
)

data class LogClearOutcome(
  val deletedCount: Int,
  val failedPaths: List<String>,
  /** Every artifact is gone. This is the compliance question. */
  val durable: Boolean,
  /**
   * The writer has a usable file again. Separate from [durable] because a
   * complete deletion can still be followed by a failed reopen, and a caller
   * that resumes on [durable] alone writes into a writer with nowhere to put
   * anything.
   */
  val rebound: Boolean = false
)

class LogWriterException(val kind: Kind, message: String) : Exception(message) {
  enum class Kind {
    OPEN_FAILED,
    CONFIG_CONFLICT,
    SYMLINK_ESCAPE,
    STILL_CLOSING,
    /** Another OS process holds this log file. Its own, because it is the one
     * failure here that no amount of retrying inside this process can fix. */
    LOCKED
  }
}
