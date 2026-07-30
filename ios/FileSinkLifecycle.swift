import Foundation

/// The file sink's lifecycle, with no Nitro in it.
///
/// Both adapters — `HybridFileSink` here and `HybridFileSink.kt` — used to
/// carry their own copy of this: a handle, three booleans, and a set of rules
/// about which combinations are legal. Neither copy had a test, because the
/// adapters cannot be built without Nitro and so are excluded from the test
/// targets. Two independent implementations of one contract, both unpinned,
/// diverged exactly where you would expect (see **Divergences found** below).
/// Extracting the rules to a type both adapters delegate to is what makes them
/// testable, and the pattern already exists here — `PlatformIo`,
/// `NativeConsoleWriter`.
///
/// This type owns the *decisions*. It never does I/O and never holds its lock
/// across a call out: acquisition creates directories and can scan a torn tail,
/// and putting that behind the lock would put `getStatus` behind disk latency,
/// which is the one thing that call is documented not to do. So the caller does
/// the I/O and comes back to report what happened.
///
/// # States
///
/// | State | Meaning |
/// | --- | --- |
/// | `idle` | Nothing has been opened through this sink, ever. |
/// | `opening` | An `open` is past its check and inside `acquire`. |
/// | `open` | A handle is installed and reachable. |
/// | `closePending` | A `close` arrived while `opening`; the in-flight open must discard what it acquires. |
/// | `closed` | Was open (or tried to be), and is not now. |
/// | `disposed` | Terminal. The object is being torn down; nothing may reopen. |
///
/// Two states the review's sketch named are deliberately **not** separate here:
///
/// - **`failed`** — a failed `open` lands in `closed`, not in a state of its
///   own, because it is not observably different and must not be treated as
///   better. `acquire` creates the log directory before it opens the file, so a
///   throw is not evidence that nothing was written. A distinct `failed` state
///   would invite exactly the "nothing happened, so nothing is on disk"
///   reasoning that `mayHaveArtifacts` exists to prevent.
/// - **never-opened vs. closed-after-open** — one `closed` state plus the
///   monotonic `mayHaveArtifacts` flag, rather than two states. They differ in
///   precisely one respect (whether files may exist), that difference is
///   permanent once set, and it is the same bit every operation needs.
///
/// # Linearization points
///
/// Every one of these is the moment the lock is held, and nothing else counts:
///
/// | Operation | Linearizes at |
/// | --- | --- |
/// | `open` (start) | `beginOpen()` returning `true` — `idle`/`closed` → `opening`. From here a rival `open` is refused, and the sink is no longer "closed" to a racing `close`. |
/// | `open` (finish) | `finishOpen(_:)` — `opening` → `open` (installed) or `closePending` → `closed` (abandoned). |
/// | `open` (failure) | `failOpen()` — `opening` → `closed`. |
/// | `close` | `beginClose()` — whichever of the handle detach or the `closePending` record applies. |
/// | `dispose` | `beginDispose()` — as `close`, and terminal. |
///
/// `mayHaveArtifacts` is set inside `beginOpen()`, **before** the caller
/// attempts acquisition, for the reason above.
///
/// # Who wins when close races open
///
/// **Close wins, always.** A `close` arriving during `opening` cannot flush
/// anything — there is no handle yet — so it records `closePending` and
/// returns. The open then completes, finds the flag, and closes what it
/// acquired instead of installing it.
///
/// The alternative, letting the open install and requiring the caller to close
/// again, loses the descriptor whenever the caller does not: the writer would
/// be live, holding the registry slot, with nothing able to reach it. That is
/// the failure this ordering exists to prevent, and it is why `close` is
/// allowed to return before the open it cancelled has finished.
///
/// A cancelled `open` does **not** throw. The caller asked for a close after
/// asking for an open; being told the open failed would be a second, confusing
/// report of its own decision.
///
/// # Ownership
///
/// - **The handle** has exactly one owner at every instant. `acquire` hands it
///   to the opening caller; `finishOpen` transfers it to this type, or refuses
///   it and leaves the caller owning it (and obliged to close it); `beginClose`
///   transfers it back out to the closing caller, who must close it. This type
///   never closes a handle itself — it has no deadline to close it with, and
///   taking one would mean holding a lock across I/O.
/// - **`mayHaveArtifacts`** is owned by this type for its whole life and is
///   monotonic: `false` → `true`, never back. Closing releases a handle; it
///   does not unmake files.
///
/// # What each operation answers with no live handle
///
/// This is where the two adapters disagreed, so the rule is stated once here
/// and both now derive it from the same bit:
///
/// | | never opened | opened, now closed |
/// | --- | --- | --- |
/// | `flush` / `close` `durable` | `true` | `false` |
/// | `clearLogs` `durable` | `true` | `false` |
/// | `getLogFilePaths` | `[]` | the artifacts still on disk |
///
/// `true` only where it is **vacuous**. Nothing was ever accepted through a
/// sink that never opened, so "every accepted byte reached storage" holds with
/// nothing to check. Once files may exist, this object cannot reach them, and
/// so cannot vouch for them: `durable: true` there would tell the JavaScript
/// batcher to mark loss notices confirmed that may never have reached disk
/// (`Batcher.settled`), and it would tell a compliance caller that a purge
/// succeeded over files that are still on the device. Both lie in the direction
/// that matters.
///
/// `getLogFilePaths` is the row that runs the other way, and it is why the
/// table is about the *question* rather than about `durable`. Closing releases
/// a handle; it does not delete files. A closed sink answering `[]` says "there
/// is nothing to collect" over logs that are still on the device — which a
/// consent-gated support upload believes, and then uploads nothing. So the
/// answer with no handle is not the empty list but the directory: the paths are
/// a fact about storage, not a claim about this object's reach, and enumerating
/// them needs no live writer. Empty then means "no artifacts", not "no sink" —
/// a purge or a retention sweep leaves an opened sink with nothing to name, and
/// that is a correct answer rather than the vacuous one.
///
/// ## Divergences found
///
/// Extracting this forced a single answer where there had been two, and neither
/// platform was right in both states:
///
/// - iOS returned `durable: true` from `flush` and `close` with no handle **in
///   both states** — including after a close that timed out with bytes still
///   pending, which is the case where the claim is worst.
/// - Android returned `durable: false` from `flush` and `close` with no handle
///   **in both states** — including for a sink that never opened, which re-arms
///   notices for a sink that cannot owe any.
///
/// Only `clearLogs` already drew the distinction, on both platforms. It is now
/// the rule for all three.
final class FileSinkLifecycle {

  enum State: Equatable {
    case idle
    case opening
    case open
    case closePending
    case closed
    case disposed
  }

  /// What `finishOpen` tells the caller to do with the handle it acquired.
  enum Installation: Equatable {
    /// The handle now belongs to this type.
    case installed
    /// A close arrived first. The caller still owns the handle and must close
    /// it — with a zero deadline, since whoever closed has already returned.
    case abandon
  }

  private let lock = NSLock()
  private var state: State = .idle
  private var handle: LogFileHandle?
  private var created = false
  /// Where the artifacts are, kept for the life of this object.
  ///
  /// **Only ever a registry-resolved path.** The caller's spelling is never
  /// stored, and that is the rule rather than an implementation detail: the
  /// registry canonicalizes what it is given — a relative path against the
  /// working directory, a symlinked ancestor resolved through — and the
  /// writer's files are under *that* name. Keeping the caller's string would
  /// leave a name that a symlink retargeted after the fact could redirect, and
  /// hand a consent-gated support upload somebody else's directory.
  ///
  /// Written by `finishOpen` from the acquired handle, and by `failOpen` from
  /// the path the failed acquire reported as it resolved. Both come from the
  /// acquisition itself rather than from a second look at the filesystem, so
  /// neither can be redirected by a symlink retargeted after the fact.
  ///
  /// Still `nil` while an open is in flight, so `getLogFilePaths` answers `[]`
  /// for that window. Correct rather than merely safe — nothing has been
  /// accepted through this sink yet.
  private var openedPath: String?

  // MARK: - Reading

  var currentState: State {
    lock.lock()
    defer { lock.unlock() }
    return state
  }

  /// The live handle, or `nil`.
  func current() -> LogFileHandle? {
    lock.lock()
    defer { lock.unlock() }
    return handle
  }

  /// Whether an operation that finds no handle may claim success vacuously.
  ///
  /// `true` only for a sink that never opened. See the table above.
  var vacuousSuccess: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !created
  }

  /// The handle, and the answer to give if there isn't one — read together.
  ///
  /// One critical section, deliberately. Reading them separately lets a close
  /// land in between and produce "no handle, nothing ever created" — the one
  /// combination that is never true, and the one that reports a durable purge
  /// over surviving files.
  ///
  /// Returns the **verdict**, not the raw flag, so that the negation lives here
  /// rather than at each caller. That is not tidiness: `durable: !created` in
  /// the adapters is precisely the expression this whole extraction exists to
  /// put under test, and leaving it out there would leave it exactly as
  /// unpinned as it was — the review's own demonstration was that reverting it
  /// kept every test green.
  func snapshot() -> (handle: LogFileHandle?, durableWithoutHandle: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (handle, !created)
  }

  /// Where to get the artifact list: the live handle, or failing that the path
  /// to enumerate. Read together, for the same reason `snapshot` reads its two
  /// fields in one critical section.
  ///
  /// `(nil, nil)` is the never-opened sink, the one case with nowhere to look.
  /// An opened sink always has somewhere, which is not the same as always
  /// having something: a purge leaves the directory there and empty.
  func artifactSource() -> (handle: LogFileHandle?, path: String?) {
    lock.lock()
    defer { lock.unlock() }
    return (handle, openedPath)
  }

  // MARK: - Transitions

  /// Claims the right to open. `false` means the caller must refuse.
  ///
  /// Marks `mayHaveArtifacts` before the attempt rather than after it succeeds:
  /// acquisition creates the log directory and can then fail on the file, so a
  /// throw is not evidence that nothing was written.
  ///
  /// Deliberately takes no path. `mayHaveArtifacts` is a bit and can be set
  /// from a guess; `openedPath` is a name something will be opened by, and the
  /// only safe source for it is the registry — see `openedPath`.
  func beginOpen() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    switch state {
    case .open, .opening, .closePending, .disposed:
      return false
    case .idle, .closed:
      state = .opening
      created = true
      return true
    }
  }

  /// Reports a successful acquisition, and learns whether to keep it.
  ///
  /// Takes the acquired handle's own path as the artifact source from here on
  /// — see `openedPath`. Recorded in the abandoned case too: that handle really
  /// did open those files, and whoever closes it does not unmake them.
  func finishOpen(_ acquired: LogFileHandle) -> Installation {
    lock.lock()
    defer { lock.unlock() }
    openedPath = acquired.filePath
    switch state {
    case .opening:
      handle = acquired
      state = .open
      return .installed
    case .closePending:
      // A close won. Back to closed, and the caller disposes of the handle.
      state = .closed
      return .abandon
    case .disposed:
      return .abandon
    case .idle, .open, .closed:
      // Unreachable: only an in-flight open calls this, and only `beginOpen`
      // starts one. Refusing the handle is the safe reading either way — an
      // installed handle nothing expects is a descriptor nothing will release.
      return .abandon
    }
  }

  /// Reports a failed acquisition. `mayHaveArtifacts` deliberately stays set.
  ///
  /// `artifactPath` is the path the failed acquire reported as it resolved, or
  /// `nil` if it never got that far. Recorded because a throw is not evidence
  /// that nothing was written: acquisition creates the log directory before it
  /// opens the file, and what it left behind is enumerable under the resolved
  /// name. `nil` leaves `openedPath` as it was — a previous open's artifacts do
  /// not stop existing because a later open failed.
  func failOpen(artifactPath: String? = nil) {
    lock.lock()
    defer { lock.unlock() }
    if let artifactPath { openedPath = artifactPath }
    if state == .opening || state == .closePending { state = .closed }
  }

  /// Detaches the handle so the caller can close it, and says what to report
  /// if there was not one.
  ///
  /// Both in one critical section, for the same reason `snapshot` reads its
  /// two fields together: a caller that detached nothing and then asked
  /// separately whether the sink had ever opened could be answered by an
  /// `open` that started in between, and would report `durable: false` for a
  /// close that linearized while nothing had ever been created.
  ///
  /// A `nil` handle with an open in flight is not "nothing happened": the
  /// recorded state is what makes the acquisition landing after this return
  /// get discarded rather than installed.
  func beginClose() -> (handle: LogFileHandle?, durableWithoutHandle: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return detachLocked(disposing: false)
  }

  /// As `beginClose`, and terminal: nothing may open afterwards.
  ///
  /// Separate from `beginClose` because JavaScript may legitimately close a
  /// sink and open it again; disposing is the caller saying the object itself
  /// is finished. Folding the two together would make an ordinary `close`
  /// permanently unreopenable.
  func beginDispose() -> (handle: LogFileHandle?, durableWithoutHandle: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return detachLocked(disposing: true)
  }

  private func detachLocked(
    disposing: Bool
  ) -> (handle: LogFileHandle?, durableWithoutHandle: Bool) {
    let live = handle
    handle = nil
    switch state {
    case .opening:
      // No handle to hand back, but one is on its way. Record the intent.
      state = disposing ? .disposed : .closePending
    case .closePending:
      // A second close before the acquisition landed. **Stays** `closePending`
      // for an ordinary close: advancing to `closed` would free the sink while
      // that acquisition is still in flight, and it would then land into the
      // *next* open's `opening` state and be installed there — a writer for the
      // path and policy the first caller asked for, handed to the second as
      // though it were theirs, with the second's own handle abandoned and no
      // error anywhere. Closing twice is ordinary — JavaScript can, and
      // `dispose` does — so the cancellation has to survive being repeated.
      if disposing { state = .disposed }
    case .disposed:
      break
    default:
      state = disposing ? .disposed : .closed
    }
    return (live, !created)
  }
}
