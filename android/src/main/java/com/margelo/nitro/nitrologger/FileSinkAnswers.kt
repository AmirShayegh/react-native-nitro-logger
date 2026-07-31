package com.margelo.nitro.nitrologger

import java.io.File

/**
 * Everything [HybridFileSink] decides, in a class a JVM test can construct.
 *
 * `HybridFileSink` extends a nitrogen-generated base and needs the native side
 * to compile, so no unit test on this platform has ever executed a line of it.
 * What sat there was not marshalling: which lifecycle call each spec op makes,
 * what it does with the answer, and what it returns when there is no handle —
 * ~400 lines of policy, unreachable. The one bug found in that layer this
 * release ([deleteSupportBundle] reading `artifactSource()` where the
 * `snapshot()` discipline was required) was caught by review rather than by a
 * test, precisely because the file could not be reached.
 *
 * So the decisions live here, returning plain `Wire*` mirrors of the nitrogen
 * value types, and `HybridFileSink` becomes what its own header always claimed
 * it was: a field-for-field copy and nothing else. The iOS twin is
 * `ios/FileSinkAnswers.swift`, same shape, same order.
 *
 * ## What this does NOT close
 *
 * The `Wire*`-to-nitrogen copy in `HybridFileSink`, and Nitro's own marshalling
 * under it, stay untested here — they are covered end to end only by the min-rn
 * smoke jobs. This is a real reduction of that gap, not its elimination: what
 * moves is the part that had decisions in it.
 */

// MARK: - Wire mirrors

/**
 * Mirrors of the nitrogen value types, field for field.
 *
 * They exist so this file can name what it returns without needing the
 * generated code. `data class` on purpose: the paired suite compares whole
 * values, so a field added on one side and forgotten on the other fails rather
 * than being silently dropped from the comparison. `List` rather than `Array`
 * for the same reason — array equality is identity, which would compare equal
 * to nothing and unequal to everything.
 */
data class WireSinkStatus(
  val queuedBytes: Double,
  val lostBytes: Double,
  val lostEntries: Double,
  val degraded: Double
)

/**
 * [wire] is the spelling the shared row table uses, and it is deliberately the
 * iOS spelling: the table is read by three targets and a value that rendered as
 * `STALE_GENERATION` here and `staleGeneration` there would need a per-platform
 * row, which is the thing the table exists to stop.
 */
enum class WireRejectReason(val wire: String) {
  FULL("full"),
  STALE_GENERATION("staleGeneration"),
  CLOSED("closed"),
  FAILED("failed")
}

data class WireAppendResult(
  val accepted: Boolean,
  /** Present only when [accepted] is false. */
  val rejectReason: WireRejectReason?,
  val queuedBytes: Double,
  val lostBytes: Double,
  val lostEntries: Double,
  val degraded: Double
)

data class WireFlushOutcome(
  val durable: Boolean,
  val timedOut: Boolean,
  val pendingBytes: Double,
  val queuedBytes: Double,
  val lostBytes: Double,
  val lostEntries: Double,
  val degraded: Double
)

data class WireCollectOutcome(
  val path: String,
  val byteCount: Double,
  val sourceFileCount: Double,
  val truncated: Boolean,
  val complete: Boolean
)

data class WireClearOutcome(
  val deletedCount: Double,
  val failedPaths: List<String>,
  val durable: Boolean,
  val rebound: Boolean
)

// MARK: - The answers

class FileSinkAnswers(
  /**
   * Injected so a test can run against an isolated registry rather than the
   * process-wide one. The adapter passes nothing and gets [LogWriterRegistry
   * .shared], which is the only configuration that ships.
   */
  private val registry: LogWriterRegistry = LogWriterRegistry.shared,
  /**
   * `AndroidPlatformIo` on a device, `PlatformIo.Jvm` under JUnit. The writer's
   * syscalls are behind this interface precisely so the suite does not need a
   * device or Robolectric.
   */
  private val platform: PlatformIo = AndroidPlatformIo,
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
) {
  /**
   * The handle, the artifacts flag, and every rule about which combinations are
   * legal — see [FileSinkLifecycle], and `ios/FileSinkLifecycle.swift` for the
   * full transition table.
   */
  private val lifecycle = FileSinkLifecycle()

  private fun current(): LogFileHandle? = lifecycle.current()

  /**
   * Terminal, unlike [close]: JavaScript may legitimately close a sink and open
   * it again, but a disposed object must not be reopened.
   *
   * Routed through the lifecycle rather than reaching for the handle directly,
   * because a `dispose` racing an in-flight `open` is exactly when that
   * matters: JS can call `dispose` from another thread while `open` is inside
   * `acquire`, and without recording it that acquisition installs a live writer
   * into an object nothing can reach to release.
   *
   * Idempotent: the detach happens under the lock, so a second call finds
   * nothing. Both of the adapter's callers can fire for the same object.
   *
   * Zero deadline: a teardown must not wait on a wedged disk, and on the
   * finalizer thread blocking would stall every other object's release.
   */
  fun releaseHandle() {
    runCatching { lifecycle.beginDispose().handle?.close(0.0) }
  }

  /**
   * Where logs go when the caller does not say, given the app's own base
   * directory.
   *
   * The base is passed in because reading it needs `NitroModules
   * .applicationContext`, which only the adapter can reach. **Which** directory
   * it hands over is the decision that matters, and it stays documented at the
   * call site: `noBackupFilesDir`, never `filesDir`, because the latter is
   * eligible for Android Auto Backup and would upload the log file to Google
   * Drive.
   *
   * Null — no context, which is every JVM test and any host that has not
   * installed the module — falls back to the JVM temp directory. Not a
   * plausible production path, and deliberately not a silent one: it is a
   * writable directory that no backup agent touches, which is the property that
   * matters if it is ever reached.
   */
  fun defaultLogDirectory(base: File?): String {
    val root = base ?: File(System.getProperty("java.io.tmpdir") ?: "/tmp")
    return File(root, "logs").absolutePath
  }

  fun open(path: String, policy: LogRotationPolicy, lineFramed: Boolean?) {
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
        FileSinkMessages.ALREADY_OPEN
      )
      FileSinkLifecycle.Claim.CLOSING -> throw LogWriterException(
        LogWriterException.Kind.STILL_CLOSING,
        FileSinkMessages.CLOSING
      )
      FileSinkLifecycle.Claim.DISPOSED -> throw LogWriterException(
        LogWriterException.Kind.CONFIG_CONFLICT,
        FileSinkMessages.DISPOSED
      )
    }

    // Written by `acquire` the moment it resolves, so the failure path below
    // has the canonical name without asking the filesystem a second question.
    // Still null if resolution itself failed — nothing was resolved, and `path`
    // as spelled here is not a stand-in for a name the registry produced.
    var resolvedPath: String? = null

    val acquired = try {
      registry.acquire(
        path = path,
        policy = policy,
        // Absent means absent: without a declared one-record-per-line contract
        // the startup scan must not trim a trailing record, because it cannot
        // tell a torn one from an intentional newline.
        lineFramed = lineFramed ?: false,
        platform = platform,
        onResolve = { resolvedPath = it },
        owner = owner
      )
    } catch (e: Throwable) {
      // Failed attempts have to release the claim, or a retry is refused
      // forever. One exit, whatever went wrong: spreading the release across a
      // clause per throwable kind is how the clause added next gets forgotten,
      // and the cost of forgetting it is an object that refuses every later
      // open for the rest of its life.
      //
      // The resolved path goes with it: `acquire` creates the log directory
      // before it opens the file, so a throw can still leave artifacts, and
      // they are under the canonical name. Null — resolution never got that
      // far — means there is nothing to enumerate, which is exactly what
      // should be recorded.
      lifecycle.failOpen(resolvedPath)

      // What gets normalized and what passes through untouched is decided in
      // [FileSinkMessages]. Until that mapping existed, whatever text the
      // throwable happened to carry went straight to JavaScript.
      FileSinkMessages.rethrowingOpenFailure(e)
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

  fun appendBatch(batch: String, entryCount: Double): WireAppendResult {
    val live = current() ?: return WireAppendResult(
      false, WireRejectReason.CLOSED, 0.0, 0.0, 0.0, 0.0
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

  fun getStatus(): WireSinkStatus {
    val live = current() ?: return WireSinkStatus(0.0, 0.0, 0.0, 0.0)
    return wireStatus(live.status())
  }

  fun maintain(deadlineMs: Double): WireSinkStatus {
    // Same shape as [getStatus], deliberately: a sink nobody has opened has no
    // files to rotate and no archives to sweep, so "nothing to do" is the whole
    // answer and a zeroed status describes it exactly. A closed one is the same
    // — its writer is gone, and the artifacts it left are the registry's to
    // sweep the next time somebody opens that path.
    val live = current() ?: return WireSinkStatus(0.0, 0.0, 0.0, 0.0)
    return wireStatus(live.maintain(deadlineMs))
  }

  fun collectLogs(deadlineMs: Double, maxTotalBytes: Double): WireCollectOutcome {
    // No handle, no bundle — and `complete = true`, because a sink that was
    // never opened has finished collecting everything it has. A support flow
    // that treated this as an error would show a failure for an app that simply
    // has no logs yet.
    val live = current()
      ?: return WireCollectOutcome("", 0.0, 0.0, truncated = false, complete = true)
    val outcome = live.collectLogs(deadlineMs, maxTotalBytes)
    return WireCollectOutcome(
      outcome.path,
      outcome.byteCount,
      outcome.sourceFileCount,
      outcome.truncated,
      outcome.complete
    )
  }

  fun flush(deadlineMs: Double): WireFlushOutcome {
    // One snapshot, so the handle and the answer to give without one cannot
    // disagree about which instant they describe.
    val (live, durableWithoutHandle) = lifecycle.snapshot()
    if (live == null) return noHandleOutcome(durableWithoutHandle)
    return outcomeOf(live.flush(deadlineMs))
  }

  fun close(deadlineMs: Double): WireFlushOutcome {
    // Detaching also records the close against an acquisition still in flight,
    // which keeps that writer from being installed into a sink the caller has
    // already closed.
    val detached = lifecycle.beginClose()
    val live = detached.handle ?: return noHandleOutcome(detached.durableWithoutHandle)
    return outcomeOf(live.close(deadlineMs))
  }

  fun getLogFilePaths(): List<String> {
    // Not `current()?.logFilePaths() ?: emptyList()`. Closing releases a
    // handle; it does not delete files, and `[]` from a closed sink tells a
    // support-upload flow there is nothing to collect over logs that are still
    // on the device. See the `getLogFilePaths` row of [FileSinkLifecycle]'s
    // table, and the iOS twin, which is the same shape.
    val (live, path) = lifecycle.artifactSource()
    if (live != null) return live.logFilePaths()
    val opened = path ?: return emptyList()
    return LogFileWriter.artifactPaths(File(opened))
  }

  fun deleteSupportBundle(deadlineMs: Double): Boolean {
    // [FileSinkLifecycle.snapshot], the [clearLogs] treatment — deliberately
    // NOT the [getLogFilePaths] one, though the two look alike and this method
    // sat on the other side of that line until a review pushed back.
    //
    // The difference is that reading a directory this object no longer owns is
    // harmless and deleting from it is not. Once the handle is gone there is no
    // generation left to check and no executor to serialize against, so a live
    // handle may own that path now and be mid-publish in it; a `.support.gz`
    // deleted from here would be *its* bundle, whose path it has already handed
    // back to a caller. The upload-finishes-after-`dispose` case is real, and
    // the answer to it is to delete before disposing, or through a fresh
    // destination on the same path — both of which produce a live handle with a
    // current generation, which is the only thing that makes this safe.
    //
    // Both fields in ONE critical section, like [clearLogs]: reading them
    // separately lets a close land in between and produce "no handle, nothing
    // created", the one combination that is never true.
    val (live, durableWithoutHandle) = lifecycle.snapshot()
    // Never opened: no directory, no bundle, vacuously gone. Opened and since
    // closed: the files are out of reach and this object cannot vouch for them.
    val handle = live ?: return durableWithoutHandle
    return handle.deleteSupportBundle(deadlineMs)
  }

  fun clearLogs(deadlineMs: Double): WireClearOutcome {
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
    if (live == null) return WireClearOutcome(0.0, emptyList(), durableWithoutHandle, false)
    val outcome = live.clearLogs(deadlineMs)
    return WireClearOutcome(
      outcome.deletedCount.toDouble(),
      outcome.failedPaths,
      outcome.durable,
      outcome.rebound
    )
  }

  // MARK: - Marshalling

  private fun wireStatus(status: LogSinkStatus) = WireSinkStatus(
    status.queuedBytes.toDouble(),
    status.lostBytes.toDouble(),
    status.lostEntries.toDouble(),
    status.degraded.toDouble()
  )

  private fun wireResult(result: LogAppendResult) = WireAppendResult(
    result.accepted,
    result.rejectReason?.let { wireReason(it) },
    result.status.queuedBytes.toDouble(),
    result.status.lostBytes.toDouble(),
    result.status.lostEntries.toDouble(),
    result.status.degraded.toDouble()
  )

  private fun wireReason(reason: LogRejectReason): WireRejectReason = when (reason) {
    LogRejectReason.FULL -> WireRejectReason.FULL
    LogRejectReason.STALE_GENERATION -> WireRejectReason.STALE_GENERATION
    LogRejectReason.CLOSED -> WireRejectReason.CLOSED
    LogRejectReason.FAILED -> WireRejectReason.FAILED
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
    WireFlushOutcome(durable, false, 0.0, 0.0, 0.0, 0.0, 0.0)

  private fun outcomeOf(outcome: LogFlushOutcome) = WireFlushOutcome(
    outcome.durable,
    outcome.timedOut,
    outcome.pendingBytes.toDouble(),
    outcome.status.queuedBytes.toDouble(),
    outcome.status.lostBytes.toDouble(),
    outcome.status.lostEntries.toDouble(),
    outcome.status.degraded.toDouble()
  )
}
