package com.margelo.nitro.nitrologger

import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * One writer per file, no matter how many destinations point at it.
 *
 * Two streams appending to the same path from different threads interleave
 * mid-record, and two rotation schedules racing over the same file archive each
 * other's fresh output. The registry makes that impossible by construction:
 * everything that resolves to the same file gets the same [LogFileWriter].
 *
 * **The key is the canonical path.** `logs/app.log`, `logs/../logs/app.log`,
 * and a `logs` symlink into the real directory are the same file and must land
 * on the same entry — comparing the strings the caller passed in would hand out
 * two writers for one file, which is exactly the collision the registry exists
 * to stop.
 */
class LogWriterRegistry {
  companion object {
    val shared = LogWriterRegistry()

    /**
     * How long an acquire will wait for a previous writer on the same path to
     * finish shutting down before giving up.
     */
    const val CLOSE_WAIT_MS = 5_000L

    /**
     * Turns a caller-supplied path into the canonical file it names.
     *
     * The parent directory is created before resolution, because canonical
     * resolution answers only for things that exist — resolving first would
     * fall back to the literal string on a fresh install and hand out a key
     * that stops matching the moment the directory appears.
     */
    @Throws(LogWriterException::class)
    fun resolve(path: String, platform: PlatformIo): Resolved {
      if (path.isEmpty()) {
        throw LogWriterException(LogWriterException.Kind.OPEN_FAILED, "empty path")
      }
      // Collapse `.` and `..` lexically before anything looks at the parent.
      // `logs/sub/../app.log` names a file in `logs`, but taken literally its
      // parent is `logs/sub/..` — a directory that only exists if `sub` does,
      // so creating it fails and the open dies on a path that was perfectly
      // valid. iOS gets this from `standardizedFileURL`.
      val requested = lexicallyNormalized(File(path).absoluteFile)
      val name = requested.name
      if (name.isEmpty() || name == "." || name == "..") {
        throw LogWriterException(
          LogWriterException.Kind.OPEN_FAILED,
          "path does not name a file"
        )
      }
      val directory = requested.parentFile
        ?: throw LogWriterException(
          LogWriterException.Kind.OPEN_FAILED,
          "path has no directory"
        )

      if (!LogSecureFile.createDirectory(directory, platform) && !directory.isDirectory) {
        throw LogWriterException(
          LogWriterException.Kind.OPEN_FAILED,
          "could not create the log directory"
        )
      }

      val canonicalDirectory = try {
        directory.canonicalFile
      } catch (_: Exception) {
        throw LogWriterException(
          LogWriterException.Kind.OPEN_FAILED,
          "could not resolve the log directory"
        )
      }

      // The log file itself must not be a symlink, even though the directory
      // above it was resolved through one deliberately.
      val candidate = File(canonicalDirectory, name)
      if (LogSecureFile.isSymbolicLink(candidate, platform)) {
        throw LogWriterException(
          LogWriterException.Kind.SYMLINK_ESCAPE,
          "the log file is a symbolic link"
        )
      }

      return Resolved(candidate, candidate.absolutePath)
    }

    /**
     * Collapses `.` and `..` in an absolute path, textually.
     *
     * `Path.normalize()` would be the obvious call and was the original one, but
     * `java.nio.file` arrived in API 26 and this library supports 24. A missing
     * class there raises `NoClassDefFoundError` — an `Error`, which passes
     * straight through `catch (Exception)` — so on an older device the failure
     * would not have been a fallback but an unhandled throw out of `open()`.
     *
     * Purely lexical, like the original: it does not touch the filesystem, so
     * `a/symlink/../b` collapses to `a/b` whether or not that is where the link
     * pointed. That is the same trade `standardizedFileURL` makes on iOS, and it
     * is safe here because the *directory* is canonicalised for real straight
     * afterwards, and the leaf is `lstat`-checked.
     */
    private fun lexicallyNormalized(file: File): File {
      val separator = File.separatorChar
      val stack = ArrayList<String>()
      for (part in file.absolutePath.split(separator)) {
        when (part) {
          "", "." -> Unit
          ".." -> if (stack.isNotEmpty()) stack.removeAt(stack.size - 1)
          else -> stack.add(part)
        }
      }
      return File(separator + stack.joinToString(separator.toString()))
    }

    /** A registry with no shared state, so tests do not leak writers. */
    fun isolated() = LogWriterRegistry()
  }

  data class Resolved(val file: File, val canonicalPath: String)

  /**
   * A lock with a condition, because acquisition sometimes has to *wait* — see
   * [closing].
   */
  private val lock = ReentrantLock()
  private val pathFreed = lock.newCondition()
  private val writers = HashMap<String, LogFileWriter>()

  /**
   * Paths whose writer has been evicted but is still draining and closing.
   *
   * Eviction and close cannot be one atomic step: closing waits on the write
   * executor, and holding the registry lock across that would stall every other
   * file. But between the two, the map has no entry for the path — so an
   * acquire arriving in that window would build a *second* writer while the
   * first still has accepted batches queued, giving one file two executors and
   * two rotation schedules. That is the exact collision this registry exists to
   * prevent, so acquisition waits out the close instead.
   *
   * Counted rather than a set: it costs nothing and stops a stray double
   * release from clearing a marker another close still needs.
   */
  private val closing = HashMap<String, Int>()
  private var nextHandleId = 1L

  /**
   * Which React instance each live handle was acquired for.
   *
   * Only handles acquired with an owner appear here. A null owner — a JVM test,
   * a host where `NitroLoggerLifecycle` never ran — is recorded against nobody
   * and behaves exactly as it did before any of this existed.
   *
   * Two maps rather than one, because both directions are asked for: a sweep
   * needs every handle of one owner, and [release] needs the owner of one
   * handle so a normal JavaScript-side close does not leave a claim behind for
   * the sweep to close a second time.
   */
  private val ownerClaims = HashMap<Long, MutableMap<Long, LogFileHandle>>()
  private val claimOwner = HashMap<Long, Long>()

  /**
   * Acquires a handle on the writer for [path], creating it if needed.
   *
   * Acquisition happens entirely under the lock, so two runtimes opening the
   * same file concurrently cannot both construct a writer and have one silently
   * replace the other.
   */
  @Throws(LogWriterException::class)
  fun acquire(
    path: String,
    policy: LogRotationPolicy,
    lineFramed: Boolean,
    /**
     * Required, with no default on purpose — see [LogFileWriter.open]. Falling
     * back to [PlatformIo.Jvm] on Android would put `java.nio.file` back on the
     * open path, where it does not exist below API 26.
     */
    platform: PlatformIo,
    rawWrite: LogFileWriter.RawWrite? = null,
    compressor: LogFileWriter.Compressor? = null,
    clock: (() -> Long)? = null,
    monotonic: (() -> Long)? = null,
    /**
     * Reports the canonical path, once, the instant resolution produces it.
     *
     * For the caller that has to answer "where are the artifacts" after this
     * call has **thrown**. [resolve] creates the log directory before it opens
     * anything, so a failure downstream of it can still leave files on disk,
     * and they are under the canonical name rather than the caller's spelling
     * of it.
     *
     * Reported from here rather than looked up again afterwards, and that is
     * the whole point: re-resolving the caller's string after the failure would
     * consult the filesystem a second time, and a symlink retargeted in between
     * would answer with a directory this acquire never touched. What is handed
     * over is the value this acquire actually used.
     *
     * Not called when [resolve] itself throws — nothing was resolved, so there
     * is no canonical name to give, and the caller's spelling is not a
     * substitute for one.
     */
    onResolve: ((String) -> Unit)? = null,
    /**
     * The React instance this handle belongs to — see [ReactInstanceEpoch].
     *
     * A handle acquired for an instance is released when that instance is
     * destroyed, because nothing on the JavaScript side will ever run again to
     * release it. Null means nobody is claiming it, which is what a JVM test
     * and any host without `NitroLoggerLifecycle` pass, and that keeps exactly
     * the old behaviour.
     */
    owner: Long? = null
  ): LogFileHandle {
    val resolved = resolve(path, platform)
    onResolve?.invoke(resolved.canonicalPath)

    lock.withLock {
      // Refused before anything is built, and inside this lock, which is what
      // makes the reload race safe: `ReactInstanceEpoch.end` marks the token
      // dead *before* it sweeps, so an acquisition either got here first and
      // will be swept, or arrives to find the owner gone. A writer opened for a
      // runtime that has already been destroyed has nobody left to close it.
      refuseIfOwnerIsGone(owner)

      // Wait out a close still in progress on this path — but not forever. The
      // claim is cleared by the writer's own executor rather than by whoever
      // called close, so wedged storage means it may never clear at all.
      // Failing the open is the fail-closed answer: one writer per file is the
      // invariant worth keeping, and a caller that cannot have it should be
      // told so rather than handed a second one.
      var budget = CLOSE_WAIT_MS
      while (closing.containsKey(resolved.canonicalPath)) {
        if (budget <= 0) {
          throw LogWriterException(
            LogWriterException.Kind.STILL_CLOSING,
            "a previous writer for this path is still closing"
          )
        }
        val waited = try {
          pathFreed.awaitNanos(TimeUnit.MILLISECONDS.toNanos(budget))
        } catch (_: InterruptedException) {
          // Same answer as running out of budget, and for the same reason: one
          // writer per file is the invariant, and a caller that cannot be given
          // it is told so rather than handed a second one.
          Thread.currentThread().interrupt()
          throw LogWriterException(
            LogWriterException.Kind.STILL_CLOSING,
            "interrupted while a previous writer for this path was closing"
          )
        }
        budget = TimeUnit.NANOSECONDS.toMillis(waited)
      }

      // Asked again, because the wait above **released this lock**. An owner can
      // die and be swept while an acquisition of its own is asleep in there —
      // and the sweep finds nothing to take, because this claim is not
      // registered yet. Registering it now would leave a writer owned by a
      // runtime nothing will ever sweep again, which is C13 through a smaller
      // gap. Everything below this line runs without releasing the lock.
      refuseIfOwnerIsGone(owner)

      val existing = writers[resolved.canonicalPath]
      val writer: LogFileWriter
      if (existing != null && !existing.isClosed) {
        // A second destination on the same file must agree about how that file
        // is written. Silently honouring the first caller's rotation policy
        // would give the second one a file that behaves nothing like what it
        // asked for, and silently honouring the last would change it under the
        // first.
        if (existing.policy != policy || existing.lineFramed != lineFramed) {
          throw LogWriterException(
            LogWriterException.Kind.CONFIG_CONFLICT,
            "this file is already open with a different configuration"
          )
        }
        writer = existing
      } else {
        writer = LogFileWriter.open(
          file = resolved.file,
          canonicalPath = resolved.canonicalPath,
          policy = policy,
          lineFramed = lineFramed,
          platform = platform,
          rawWrite = rawWrite,
          compressor = compressor,
          clock = clock,
          monotonic = monotonic
        )
        writers[resolved.canonicalPath] = writer
      }

      writer.retain()
      val id = nextHandleId
      nextHandleId += 1
      val handle = LogFileHandle(id, writer, this)
      if (owner != null) {
        ownerClaims.getOrPut(owner) { HashMap() }[id] = handle
        claimOwner[id] = owner
      }
      afterAcquireForTesting?.invoke(handle)
      return handle
    }
  }

  /**
   * Releases every handle a destroyed React instance was holding.
   *
   * **The claim is the unit of release, not the writer.** Two destinations can
   * share one writer, and they can belong to different instances — a live one
   * and the one being torn down. Closing the writer would take the log file out
   * from under the survivor; dropping one claim leaves it open at a lower
   * refcount, which is what every other release path here already does.
   *
   * Snapshot under the lock, close outside it. `LogFileHandle.close` flushes and
   * waits on the write executor, and holding the registry lock across that would
   * stall every other file in the process — including the replacement instance's
   * own open, which is the one thing that must not be blocked here.
   */
  fun releaseOwner(owner: Long, deadlineMs: Double) {
    val doomed = lock.withLock {
      val claims = ownerClaims.remove(owner) ?: return
      // Also for the handles that turn out to be closing already: their own
      // close is finishing the job, but the record must not outlive this sweep.
      //
      // Before the loop, not after, and not only for tidiness: both maps are
      // emptied of this owner up front, so [dropClaimLocked] below finds nothing
      // to unregister and does not mutate `claims` while the loop is walking it.
      claims.keys.forEach { claimOwner.remove(it) }
      duringOwnerReleaseForTesting?.invoke()
      claims.values.mapNotNull { handle ->
        // The state flip and the eviction happen together, under this lock, and
        // that is the whole point of the two phases. Doing the flip out here and
        // the eviction inside `close` — which is what this used to do — leaves a
        // window in which the writer is still installed and still retained,
        // where a replacement runtime's `open` sees a live writer with the dead
        // runtime's rotation config and is refused `CONFIG_CONFLICT`. That is
        // the bug this whole file exists to fix, arriving through a smaller gap.
        val writer = handle.beginOwnerRelease() ?: return@mapNotNull null
        Doomed(handle, writer, handle.id, dropClaimLocked(writer, handle.id))
      }
    }

    // Only the parts that wait are out here: the purge wait, the flush, and the
    // executor drain. By now the path is already marked `closing`, so an
    // acquisition arriving during any of it waits for the path rather than
    // colliding with a writer that is on its way out.
    for (item in doomed) {
      // One budget across both phases, the same way [LogFileHandle.close] spends
      // one across its own three waits. Handing `deadlineMs` to the drain as
      // well would let a caller asking for 200 ms wait 400.
      val left = item.handle.finishOwnerRelease(deadlineMs)
      item.path?.let { path -> drain(item, left, path) }
    }
    afterOwnerReleaseForTesting?.invoke(owner)
  }

  /**
   * Refuses an acquisition for a React instance that is already gone.
   *
   * **The caller holds [lock]**, and calls this both before and after the
   * `closing` wait — the wait releases the lock, so one check cannot speak for
   * both sides of it. The first is a fail-fast; the second is the load-bearing
   * one.
   */
  private fun refuseIfOwnerIsGone(owner: Long?) {
    if (owner == null || ReactInstanceEpoch.isLive(owner)) return
    throw LogWriterException(
      LogWriterException.Kind.OPEN_FAILED,
      "the runtime that asked for this log file has been destroyed"
    )
  }

  /**
   * The executor drain, on whatever the flush left of the sweep's budget.
   *
   * Its own function so the number is stated once. The budget is the entire
   * point of splitting the close in two, and a second place to write it down is
   * a second place to write down `deadlineMs` by mistake.
   */
  private fun drain(item: Doomed, budget: Double, path: String) {
    ownerDrainBudgetForTesting?.invoke(budget)
    item.writer.close(item.id, budget) { finishClosing(path) }
  }

  /** One handle on its way out, and the path to free if it was the last. */
  private class Doomed(
    val handle: LogFileHandle,
    val writer: LogFileWriter,
    val id: Long,
    val path: String?
  )

  /**
   * The registry-side bookkeeping for one handle letting go. **The caller holds
   * [lock].**
   *
   * Returns the path to close and free, or null while other claims remain.
   *
   * Shared by the two ways a handle can go away — its own [LogFileHandle.close]
   * and an owner sweep — because the two have to agree exactly about when a
   * writer stops being installed and when a path starts being `closing`. Two
   * copies of that decision is two chances for a replacement writer to open a
   * file the old one is still draining.
   */
  private fun dropClaimLocked(writer: LogFileWriter, handleId: Long): String? {
    claimOwner.remove(handleId)?.let { owner ->
      ownerClaims[owner]?.let { claims ->
        claims.remove(handleId)
        if (claims.isEmpty()) ownerClaims.remove(owner)
      }
    }
    if (writer.releaseOne() > 0) return null
    val path = writer.canonicalPath
    if (writers[path] === writer) writers.remove(path)
    // Claim the path for the duration of the close. An acquire arriving now
    // waits rather than building a rival writer over a file this one is still
    // draining.
    closing[path] = (closing[path] ?: 0) + 1
    return path
  }

  /**
   * Drops one handle's claim, closing and evicting the writer at zero.
   */
  internal fun release(writer: LogFileWriter, handleId: Long, deadlineMs: Double) {
    // Whichever side lets go first, the claim goes with it — a JavaScript-side
    // close must not leave a record for a later owner sweep to find.
    val path = lock.withLock { dropClaimLocked(writer, handleId) } ?: return

    // The path is dropped by the writer's own executor, not when this call stops
    // waiting. A close that hits its deadline leaves work still executing;
    // releasing the path then would let a replacement writer open the same file
    // underneath it.
    writer.close(handleId, deadlineMs) { finishClosing(path) }
  }

  private fun finishClosing(path: String) {
    lock.withLock {
      val outstanding = closing[path] ?: 0
      if (outstanding > 1) closing[path] = outstanding - 1 else closing.remove(path)
      pathFreed.signalAll()
    }
  }

  val liveWriterCountForTesting: Int get() = lock.withLock { writers.size }
  val closingCountForTesting: Int get() = lock.withLock { closing.size }

  /**
   * How many handles this instance is still holding.
   *
   * The number `C13ReloadLeakTest` watches go to zero, and the only way to ask
   * that question from outside: a live writer count cannot answer it, because a
   * writer shared with another instance is *supposed* to survive the sweep.
   */
  fun claimCountForOwnerForTesting(owner: Long): Int =
    lock.withLock { ownerClaims[owner]?.size ?: 0 }

  /**
   * Test seams, called from inside the acquisition lock and after a sweep.
   *
   * Both exist because the states worth asserting are momentary: a claim
   * registered against an instance that is about to be destroyed, and the
   * instant the last of its claims is gone. Polling for either is how a test
   * ends up asserting whatever came next.
   */
  @Volatile var afterAcquireForTesting: ((LogFileHandle) -> Unit)? = null
  @Volatile var afterOwnerReleaseForTesting: ((Long) -> Unit)? = null

  /**
   * Called from inside [releaseOwner]'s lock, the instant ownership is gone and
   * before the writer is evicted — **holding [lock]**, which is the point.
   *
   * The window this sits in is the one the sweep used to leave open: ownership
   * dropped, writer still installed and still retained, so a replacement
   * runtime's `open` found a live writer carrying the dead runtime's rotation
   * configuration and was refused `CONFIG_CONFLICT`. There is no way to observe
   * the window from outside — that it cannot be observed is the fix — so a test
   * that wants to try has to be let in here.
   */
  @Volatile var duringOwnerReleaseForTesting: (() -> Unit)? = null

  /**
   * What each writer's drain is given, as [drain] gives it.
   *
   * Reported rather than timed. The property worth pinning is that the sweep's
   * two waits come out of one budget, and the honest way to ask that is to read
   * the number the second wait was handed — timing the call instead makes the
   * test an assertion about how busy the machine is.
   */
  @Volatile var ownerDrainBudgetForTesting: ((Double) -> Unit)? = null
}

/**
 * One destination's claim on a writer.
 *
 * The generation is the fence. A purge bumps the writer's generation; a handle
 * that has not rebound to the new one is refused with `staleGeneration` rather
 * than being allowed to write pre-purge data into the fresh file.
 */
class LogFileHandle internal constructor(
  val id: Long,
  private val writer: LogFileWriter,
  private val registry: LogWriterRegistry
) {
  private enum class State { ACTIVE, CLOSING, CLOSED }

  private val lock = ReentrantLock()
  private val purgeFinished = lock.newCondition()
  private var generation = writer.currentGeneration
  private var state = State.ACTIVE
  /** A purge is running on this handle; close has to wait it out. */
  private var purging = false

  val filePath: String get() = writer.file.absolutePath

  /**
   * Whether this handle may still speak for the writer.
   *
   * Every entry point below is gated on it, and on ACTIVE specifically rather
   * than "not yet CLOSED". A handle in CLOSING has already had its flush
   * barrier enqueued by [close]; letting it submit more work, or report a
   * status it will not be around to make true, is how a released destination
   * ends up observing — or writing to — a writer that another handle now owns.
   */
  private val isLive: Boolean get() = lock.withLock { state == State.ACTIVE }

  private fun inertStatus() = LogSinkStatus(0, 0, 0, 0)

  fun appendBatch(batch: String, entryCount: Long): LogAppendResult = lock.withLock {
    if (state != State.ACTIVE) {
      return LogAppendResult(false, LogRejectReason.CLOSED, inertStatus())
    }
    writer.append(id, generation, batch, entryCount)
  }

  fun status(): LogSinkStatus {
    if (!isLive) return inertStatus()
    return writer.status(id)
  }

  /**
   * Housekeeping on demand — see [LogFileWriter.maintain].
   *
   * Gated on the handle still being live for the same reason every other entry
   * point here is: a released handle must not move files a writer another
   * handle now owns.
   */
  fun maintain(deadlineMs: Double): LogSinkStatus {
    if (!isLive) return inertStatus()
    return writer.maintain(id, deadlineMs)
  }

  fun flush(deadlineMs: Double): LogFlushOutcome {
    // Not `durable = true`. A released handle flushed nothing, and saying
    // otherwise invites the caller to treat its pending records as safe.
    if (!isLive) return LogFlushOutcome(false, false, 0, inertStatus())
    return writer.flush(id, deadlineMs)
  }

  fun logFilePaths(): List<String> {
    if (!isLive) return emptyList()
    return writer.logFilePaths()
  }

  /**
   * Purges, then rebinds only if the writer really came back.
   *
   * `rebound` is a fact about THIS handle, not about the writer: if this handle
   * is closing, or the purge did not end with a usable file, the caller must
   * stay fenced even though the deletion itself may have been perfectly
   * durable.
   */
  fun clearLogs(deadlineMs: Double): LogClearOutcome {
    lock.lock()
    if (state != State.ACTIVE || purging) {
      lock.unlock()
      return LogClearOutcome(0, listOf(filePath), durable = false)
    }
    purging = true
    lock.unlock()

    val result = try {
      writer.clearLogs(deadlineMs)
    } finally {
      lock.withLock {
        purging = false
        purgeFinished.signalAll()
      }
    }

    lock.withLock {
      var outcome = result.first
      if (state == State.ACTIVE && outcome.durable && outcome.rebound) {
        generation = result.second
      } else {
        outcome = outcome.copy(rebound = false)
      }
      return outcome
    }
  }

  /**
   * Closes this handle, waiting out any purge still running on it.
   *
   * One budget across all three waits. Giving each the full deadline means a
   * caller asking for 200 ms can wait 600.
   */
  fun close(deadlineMs: Double): LogFlushOutcome {
    // Monotonic, not `currentTimeMillis`. This budget spans three waits, and a
    // device clock that steps backward part-way through — an NTP correction, a
    // user changing the date — would hand the flush and teardown far more than
    // the caller asked for. On the crash path that is the difference between a
    // bounded close and an ANR.
    val expiry = monotonicMs() + LogFileWriter.clampDeadline(deadlineMs)

    lock.lock()
    if (state != State.ACTIVE) {
      lock.unlock()
      return LogFlushOutcome(false, false, 0, inertStatus())
    }
    state = State.CLOSING
    waitOutPurgeLocked(expiry)
    lock.unlock()

    val outcome = writer.flush(id, remaining(expiry))
    registry.release(writer, id, remaining(expiry))
    lock.withLock { state = State.CLOSED }
    return outcome
  }

  /**
   * Phase one of a close the *registry* is driving, for an owner sweep.
   *
   * Everything here has to be atomic with the registry's own bookkeeping, and
   * so none of it may block: the registry calls this while holding its lock, and
   * evicts the writer in the same breath. Splitting the close this way is what
   * removes the window in which a handle is spoken for but its writer is still
   * installed — see `LogWriterRegistry.releaseOwner`.
   *
   * Returns the writer this handle was speaking for, or null if it is already
   * closing, in which case whoever started that owns the rest of it.
   *
   * **Lock order: registry then handle, and only ever that way.** This is the
   * one place the two are nested. [close] takes this handle's lock, gives it
   * back, and only then calls into the registry — so there is no path that holds
   * a handle lock while reaching for the registry's, and no cycle to deadlock
   * on.
   */
  internal fun beginOwnerRelease(): LogFileWriter? = lock.withLock {
    if (state != State.ACTIVE) return null
    state = State.CLOSING
    writer
  }

  /**
   * Phase two: the parts that wait, once the registry's lock is gone.
   *
   * The same waits [close] does, in the same order and against one budget — a
   * purge still running on this handle, then the flush. What it does *not* do is
   * call back into the registry: the eviction already happened, under the lock,
   * before this was reachable.
   *
   * Returns what is left of [deadlineMs], because the caller still has the
   * executor drain to pay for and it comes out of the same budget. Spending the
   * whole deadline here and handing the whole deadline on would make a sweep
   * take twice what was asked of it.
   */
  internal fun finishOwnerRelease(deadlineMs: Double): Double {
    val expiry = monotonicMs() + LogFileWriter.clampDeadline(deadlineMs)
    lock.lock()
    waitOutPurgeLocked(expiry)
    lock.unlock()

    writer.flush(id, remaining(expiry))
    lock.withLock { state = State.CLOSED }
    return remaining(expiry)
  }

  /** **Caller holds [lock].** Waits out a purge on this handle, bounded. */
  private fun waitOutPurgeLocked(expiry: Long) {
    while (purging) {
      val left = maxOf(0L, expiry - monotonicMs())
      if (left <= 0) break
      try {
        if (!purgeFinished.await(left, TimeUnit.MILLISECONDS)) break
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        break
      }
    }
  }

  private fun remaining(expiry: Long): Double =
    maxOf(0L, expiry - monotonicMs()).toDouble()

  private fun monotonicMs(): Long = System.nanoTime() / 1_000_000L
}
