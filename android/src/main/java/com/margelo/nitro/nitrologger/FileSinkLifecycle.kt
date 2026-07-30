package com.margelo.nitro.nitrologger

import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * The file sink's lifecycle, with no Nitro in it. The Kotlin half of the pair;
 * `ios/FileSinkLifecycle.swift` is the other, and carries the full transition
 * table and the reasoning behind it.
 *
 * Both adapters used to hold their own copy of these rules — a handle, three
 * booleans, and a set of legal combinations — and neither copy had a test.
 * Two unpinned implementations of one contract diverged, which is why this
 * exists rather than the rules staying where they were used.
 *
 * No I/O, and the lock is never held across a call out: acquisition creates
 * directories and can scan a torn tail, and putting that behind this lock would
 * put `getStatus` behind disk latency. The caller does the I/O and comes back to
 * report what happened.
 *
 * ## States
 *
 * - [State.IDLE] — nothing has been opened through this sink, ever.
 * - [State.OPENING] — an open is past its check and inside `acquire`.
 * - [State.OPEN] — a handle is installed and reachable.
 * - [State.CLOSE_PENDING] — a close arrived while opening; the in-flight open
 *   must discard what it acquires.
 * - [State.CLOSED] — was open (or tried to be), and is not now.
 * - [State.DISPOSED] — terminal; nothing may reopen.
 *
 * A failed open lands in [State.CLOSED], not a state of its own: `acquire`
 * creates the log directory before it opens the file, so a throw is not
 * evidence that nothing was written. Never-opened and closed-after-open are
 * likewise one state plus the monotonic `mayHaveArtifacts` bit, because that is
 * the only respect in which they differ.
 *
 * ## Linearization
 *
 * Each of [beginOpen], [finishOpen], [failOpen], [beginClose] and
 * [beginDispose] linearizes at the moment it holds the lock, and nothing else
 * counts. `mayHaveArtifacts` is set inside [beginOpen], **before** the caller
 * attempts acquisition.
 *
 * ## Close beats open
 *
 * A close arriving during [State.OPENING] cannot flush anything, so it records
 * the intent and returns; the open then finds [State.CLOSE_PENDING] and closes
 * what it acquired instead of installing it. The alternative loses the
 * descriptor whenever the caller does not close again — a live writer holding
 * the registry slot with nothing able to reach it.
 *
 * ## Ownership
 *
 * The handle has exactly one owner at every instant: the opening caller, then
 * this object, then the closing caller. This type never closes a handle — it
 * has no deadline to close one with. `mayHaveArtifacts` belongs to this object
 * for its whole life and only ever goes false to true.
 *
 * ## No live handle
 *
 * `flush`, `close` and `clearLogs` all report `durable = ` [vacuousSuccess]:
 * true only for a sink that never opened, where the claim is vacuous. Once
 * files may exist this object cannot reach them and so cannot vouch for them.
 * Android previously answered `false` in both states from `flush` and `close`,
 * iOS `true` in both; only `clearLogs` drew the distinction.
 *
 * `getLogFilePaths` is the row of that table which runs the other way, and it
 * is why the table is about the *question* rather than about `durable`. Closing
 * releases a handle; it does not delete files. A closed sink answering `[]`
 * says "there is nothing to collect" over logs that are still on the device,
 * which a consent-gated support upload believes and then uploads nothing. So
 * the answer with no handle is not the empty list but the directory — see
 * [artifactSource]. Empty then means "no artifacts", not "no sink": a purge or
 * a retention sweep leaves an opened sink with nothing to name, and that is a
 * correct answer rather than the vacuous one.
 */
internal class FileSinkLifecycle {

  enum class State { IDLE, OPENING, OPEN, CLOSE_PENDING, CLOSED, DISPOSED }

  /** What [finishOpen] tells the caller to do with the handle it acquired. */
  enum class Installation {
    /** The handle now belongs to this object. */
    INSTALLED,

    /**
     * A close arrived first. The caller still owns the handle and must close it
     * — with a zero deadline, since whoever closed has already returned.
     */
    ABANDON
  }

  /**
   * The handle, and the answer to give if there isn't one, as of one instant.
   *
   * The **verdict**, not the raw flag: the negation belongs here rather than at
   * each caller, because `durable = !mayHaveArtifacts` in the adapters is
   * precisely the expression this extraction exists to put under test. Leaving
   * it out there would leave it as unpinned as it was.
   */
  data class Snapshot(val handle: LogFileHandle?, val durableWithoutHandle: Boolean)

  /**
   * Where to get the artifact list: the live [handle], or failing that the
   * [path] to enumerate. `(null, null)` is the never-opened sink, the one case
   * with nowhere to look. An opened sink always has somewhere, which is not the
   * same as always having something: a purge leaves the directory there and
   * empty.
   */
  data class ArtifactSource(val handle: LogFileHandle?, val path: String?)

  private val lock = ReentrantLock()
  private var state = State.IDLE
  private var handle: LogFileHandle? = null
  private var created = false

  /**
   * Where the artifacts are, kept for the life of this object.
   *
   * **Only ever a registry-resolved path.** The caller's spelling is never
   * stored, and that is the rule rather than an implementation detail: the
   * registry canonicalizes what it is given — a relative path against the
   * working directory, a symlinked ancestor resolved through — and the writer's
   * files are under *that* name. Keeping the caller's string would leave a name
   * that a symlink retargeted after the fact could redirect, and hand a
   * consent-gated support upload somebody else's directory.
   *
   * Written by [finishOpen] from the acquired handle, and by [failOpen] from
   * the path the failed acquire reported as it resolved. Both come from the
   * acquisition itself rather than from a second look at the filesystem, so
   * neither can be redirected by a symlink retargeted after the fact.
   *
   * Still null while an open is in flight, so `getLogFilePaths` answers `[]`
   * for that window. Correct rather than merely safe — nothing has been
   * accepted through this sink yet.
   */
  private var openedPath: String? = null

  val currentState: State get() = lock.withLock { state }

  fun current(): LogFileHandle? = lock.withLock { handle }

  /**
   * Whether an operation that finds no handle may claim success vacuously.
   * True only for a sink that never opened.
   */
  val vacuousSuccess: Boolean get() = lock.withLock { !created }

  /**
   * Both fields in one critical section. Reading them separately lets a close
   * land in between and produce "no handle, nothing ever created" — the one
   * combination that is never true, and the one that reports a durable purge
   * over surviving files.
   */
  fun snapshot(): Snapshot = lock.withLock { Snapshot(handle, !created) }

  /**
   * Both fields in one critical section, for the same reason [snapshot] reads
   * its two that way.
   */
  fun artifactSource(): ArtifactSource = lock.withLock { ArtifactSource(handle, openedPath) }

  /**
   * Claims the right to open. False means the caller must refuse.
   *
   * Marks `mayHaveArtifacts` before the attempt rather than after it succeeds:
   * acquisition creates the log directory and can then fail on the file.
   *
   * Deliberately takes no path. `mayHaveArtifacts` is a bit and can be set from
   * a guess; [openedPath] is a name something will be opened by, and the only
   * safe source for it is the registry — see [openedPath].
   */
  fun beginOpen(): Boolean = lock.withLock {
    when (state) {
      State.OPEN, State.OPENING, State.CLOSE_PENDING, State.DISPOSED -> false
      State.IDLE, State.CLOSED -> {
        state = State.OPENING
        created = true
        true
      }
    }
  }

  /**
   * Reports a successful acquisition, and learns whether to keep it.
   *
   * Takes the acquired handle's own path as the artifact source from here on —
   * see [openedPath]. Recorded in the abandoned case too: that handle really
   * did open those files, and whoever closes it does not unmake them.
   */
  fun finishOpen(acquired: LogFileHandle): Installation = lock.withLock {
    openedPath = acquired.filePath
    when (state) {
      State.OPENING -> {
        handle = acquired
        state = State.OPEN
        Installation.INSTALLED
      }
      State.CLOSE_PENDING -> {
        state = State.CLOSED
        Installation.ABANDON
      }
      // DISPOSED, or a state only reachable by misuse. Refusing the handle is
      // the safe reading either way: one installed where nothing expects it is
      // a descriptor nothing will release.
      else -> Installation.ABANDON
    }
  }

  /**
   * Reports a failed acquisition. `mayHaveArtifacts` deliberately stays set.
   *
   * [artifactPath] is the path the failed acquire reported as it resolved, or
   * null if it never got that far. Recorded because a throw is not evidence
   * that nothing was written: acquisition creates the log directory before it
   * opens the file, and what it left behind is enumerable under the resolved
   * name. Null leaves [openedPath] as it was — a previous open's artifacts do
   * not stop existing because a later open failed.
   */
  fun failOpen(artifactPath: String? = null) = lock.withLock {
    if (artifactPath != null) openedPath = artifactPath
    if (state == State.OPENING || state == State.CLOSE_PENDING) state = State.CLOSED
  }

  /**
   * Detaches the handle so the caller can close it, and says what to report if
   * there was not one.
   *
   * Both in one critical section, for the same reason [snapshot] reads its two
   * fields together: a caller that detached nothing and then asked separately
   * whether the sink had ever opened could be answered by an `open` that
   * started in between.
   *
   * A null handle with an open in flight is not "nothing happened": the
   * recorded state is what makes the acquisition landing after this return get
   * discarded rather than installed.
   */
  fun beginClose(): Snapshot = lock.withLock { detach(disposing = false) }

  /**
   * As [beginClose], and terminal.
   *
   * Separate because JavaScript may legitimately close a sink and open it
   * again; disposing is the caller saying the object itself is finished.
   * Folding the two together would make an ordinary close unreopenable.
   */
  fun beginDispose(): Snapshot = lock.withLock { detach(disposing = true) }

  private fun detach(disposing: Boolean): Snapshot {
    val live = handle
    handle = null
    when (state) {
      // No handle to hand back, but one is on its way. Record the intent.
      State.OPENING -> state = if (disposing) State.DISPOSED else State.CLOSE_PENDING
      // A second close before the acquisition landed. **Stays** CLOSE_PENDING
      // for an ordinary close: advancing to CLOSED would free the sink while
      // that acquisition is still in flight, and it would then land into the
      // *next* open's OPENING state and be installed there — a writer for the
      // path and policy the first caller asked for, handed to the second as
      // though it were theirs, with the second's own handle abandoned and no
      // error anywhere. Closing twice is ordinary — JavaScript can, and
      // `dispose` does — so the cancellation has to survive being repeated.
      State.CLOSE_PENDING -> if (disposing) state = State.DISPOSED
      State.DISPOSED -> {}
      else -> state = if (disposing) State.DISPOSED else State.CLOSED
    }
    return Snapshot(live, !created)
  }
}
