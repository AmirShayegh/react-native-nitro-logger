package com.margelo.nitro.nitrologger

/**
 * Every message the file sink's open path can send to JavaScript, and the
 * mapping from an acquisition failure onto one of them.
 *
 * ## Why this is not in [HybridFileSink]
 *
 * That class extends a generated Nitro spec, which needs the JNI layer, so no
 * JVM unit test can reach a single line of it. The mapping is the part with a
 * rule in it — one message per [LogWriterException.Kind], no payload, matching
 * iOS — and a rule nothing can execute is a rule nothing checks. So it lives
 * where the tests are, and the adapter calls it.
 *
 * ## Payload-free by construction
 *
 * The strings are constants. Nothing here interpolates the exception's own
 * message, its cause, a path, or an `errno` description, because this string
 * ends up in JavaScript and from there in whatever the app logs to. A log path
 * carries a username on every platform this ships to; an `errno` description
 * carries the path. Dropping the payload is the point of the mapping, not a
 * side effect of it — before this, whatever text the throwable happened to
 * arrive with went straight across the bridge.
 *
 * What is lost with it: the specific reason an open failed is no longer visible
 * from JavaScript. `getStatus().degraded` is where a caller looks instead, and
 * it is payload-free by design.
 *
 * ## Parity with iOS
 *
 * These are byte-identical to `ios/HybridFileSink.swift`'s `Message`, and
 * `__tests__/openFailureParity.test.js` fails if they stop being. Before that
 * test the two platforms silently disagreed on all eight — Android sent
 * "this sink is already open" where iOS sent "FileSink: already open" — which
 * is precisely the kind of difference that survives review and then surfaces
 * as a cross-platform bug report about a string nobody meant to be an API.
 */
internal object FileSinkMessages {
  const val ALREADY_OPEN = "FileSink: already open"
  const val CLOSING = "FileSink: an earlier open on this sink is still being cancelled; retry"
  const val DISPOSED = "FileSink: this sink has been disposed"
  const val CONFIG_CONFLICT =
    "FileSink: another destination already opened this file with a different configuration"
  const val SYMLINK_ESCAPE = "FileSink: the log path is a symbolic link"
  const val LOCKED = "FileSink: another process is writing this log file"
  const val STILL_CLOSING = "FileSink: the previous destination for this file is still closing"
  const val OPEN_FAILED = "FileSink: could not open the log file"

  /**
   * Throws what the adapter should throw for [error], having already released
   * the lifecycle claim.
   *
   * The whole decision lives here rather than in [HybridFileSink] because that
   * class cannot be reached from a JVM test, and "which throwables get
   * normalized" is the sort of rule that is wrong quietly. Returns [Nothing]:
   * there is no path out of it that does not throw.
   */
  fun rethrowingOpenFailure(error: Throwable): Nothing {
    // An `Error` leaves exactly as it arrived. `OutOfMemoryError`, a linkage
    // failure, `StackOverflowError` — none of those is an open failure, and
    // reporting one as "could not open the log file" sends the caller to look
    // at the filesystem for a problem that is in the VM. Catching `Exception`
    // instead would read the same but would also stop the claim above being
    // released, which has to happen either way.
    if (error is Error) throw error

    // The mapping is about to discard the throwable this arrived on, and with
    // it the fact that the thread was interrupted. Swallowing that is how a
    // thread stops being cancellable, so it goes back on the flag before the
    // original is dropped.
    if (error is InterruptedException) Thread.currentThread().interrupt()

    throw openFailure(error)
  }

  /**
   * Maps an acquisition failure onto a message that can cross into JavaScript.
   *
   * Anything that is not a [LogWriterException] — and there is no shortage of
   * candidates, since `acquire` touches the filesystem — becomes
   * [OPEN_FAILED]. That is the honest answer: the open did not happen, and
   * this layer knows nothing more about why that it is willing to say out
   * loud.
   *
   * The kind is preserved on the returned exception even though the message is
   * replaced. Nothing across the bridge reads it, but the Kotlin side does,
   * and throwing away the one payload-free fact in the exception to keep the
   * one that is not would be the wrong way round.
   */
  fun openFailure(error: Throwable): LogWriterException {
    val kind = (error as? LogWriterException)?.kind ?: LogWriterException.Kind.OPEN_FAILED
    // An expression, not a statement, and that is load-bearing: a `when` used
    // as an expression must be exhaustive, so adding a `Kind` without a
    // message here fails the build. A statement `when` would compile happily
    // and the new kind would fall through with no message at all.
    val message = when (kind) {
      LogWriterException.Kind.CONFIG_CONFLICT -> CONFIG_CONFLICT
      LogWriterException.Kind.SYMLINK_ESCAPE -> SYMLINK_ESCAPE
      LogWriterException.Kind.LOCKED -> LOCKED
      LogWriterException.Kind.STILL_CLOSING -> STILL_CLOSING
      LogWriterException.Kind.OPEN_FAILED -> OPEN_FAILED
    }
    return LogWriterException(kind, message)
  }
}
