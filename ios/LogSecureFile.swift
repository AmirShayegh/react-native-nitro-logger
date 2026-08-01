import Foundation

/// How much of the claim a directory *this call creates* receives.
///
/// "We made it, so it is ours" is right about a directory whose name this
/// package chose, and wrong about one whose name is a platform convention.
/// `<Library>/Logs` is the second kind: it is where an iOS app is expected to
/// put logs, so the host app and any other library in the process may use it
/// too — and on a fresh container the first `open` is simply whoever gets
/// there first. Winning that race is not ownership.
///
/// What is actually at stake is the two *directory-wide* protections, both of
/// which outlive this sink and neither of which the app can see:
///
/// - the backup exclusion is persistent and applies to the directory, so it
///   silently takes everything anyone later puts in `Logs` out of iCloud
///   backup;
/// - the protection class is inherited by every file created in there
///   afterwards, including files this package never writes — which can turn
///   another component's write into a silent failure on a locked device.
///
/// The mode is a different question and is applied either way: `0700` on a
/// directory this call brought into existence inside the app's own container
/// takes nothing away from anyone — there was nothing there to take.
///
/// **Nothing is lost by holding back.** Every artifact this writer creates
/// gets all three explicitly, through its own descriptor; the directory-wide
/// settings were never what protected the log files. See PRIVACY.md, which
/// already makes that argument for files.
///
/// It is decided by the directory's *name*, not by who asked for it. A caller
/// that spells out `<Library>/Logs` gets the same restraint as one that took
/// the default: the reason to hold back is that the host app is entitled to
/// that directory, and that is true however this writer arrived at it.
internal enum LogDirectoryClaim {
  /// Mode, protection class, and backup exclusion. For a directory whose name
  /// this package or its caller chose, which nothing else has a standing
  /// reason to be in.
  case full
  /// Mode only. For a directory whose name is a platform convention.
  case modeOnly
}

/// Creating log files and directories the way a file full of patient data has
/// to be created.
///
/// Every artifact the writer produces goes through here — the directory, the
/// active file, each archive, the gzip temporary, the recovery staging file —
/// because the protections are only worth anything if they hold on all of
/// them. An archive that inherits default permissions is exactly as readable
/// as the log it was rotated from.
///
/// Three separate things are being asked for, and they fail independently:
///
/// - **POSIX modes**, type-specific. A directory needs `0700`: owner read,
///   write, and *search*, since without the execute bit nothing inside it can
///   be reached by path. A file needs `0600` — an executable log file is a
///   contradiction, and `0700` on a file is the kind of thing that gets copied
///   into the next project.
/// - **Data protection**, `completeUntilFirstUserAuthentication`. Not
///   `complete`: the crash handler and the background flush both write while
///   the device may be locked, and a stricter class would turn those writes
///   into silent failures at exactly the moment the log matters. This class
///   still means the file is unreadable until the user has unlocked once
///   since boot.
/// - **Backup exclusion.** Logs must not ride an iCloud or iTunes backup off
///   the device.
///
/// **Every mode is read back after it is set.** Asking for `0600` and assuming
/// it took is how a world-readable file inherited from a restored backup gets
/// treated as protected: `chmod` can fail, and `setAttributes` swallows the
/// reason. What matters is the mode that is on disk afterwards, so that is what
/// gets checked and what gets reported.
///
/// Failures are reported rather than thrown. A log file that exists with the
/// wrong protection class is a problem the app should know about; a log file
/// that could not be created at all is a worse one.
internal enum LogSecureFile {

  /// What could not be applied. Empty means everything held.
  struct Shortfall: OptionSet {
    let rawValue: Int
    /// The data-protection class or backup exclusion did not stick.
    static let protection = Shortfall(rawValue: 1 << 0)
    /// The POSIX mode on disk is not what it should be — the artifact is
    /// readable by more than its owner, or a directory is not traversable.
    static let permissions = Shortfall(rawValue: 1 << 1)
  }

  static let directoryMode: Int = 0o700
  static let fileMode: Int = 0o600

  /// Where this platform expects an app to keep its logs.
  ///
  /// One definition, read twice: the Nitro adapter advertises it as
  /// `defaultLogDirectory`, and this file treats it as a name it does not own.
  /// Two spellings of that would be a bug that hides — the directory the
  /// package hands out by default has to be exactly the directory it declines
  /// to claim.
  static var conventionalLogDirectory: URL {
    let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    return base.appendingPathComponent("Logs")
  }

  /// Whether a directory's *name* is a platform convention rather than a name
  /// this package or its caller chose.
  ///
  /// Asked about the directory that was actually created, at the moment it is
  /// created. It used to be asked in the adapter, of the string the caller
  /// passed, before anything resolved it — and that is defeated by a second
  /// spelling of the same directory: `/var/…` against `/private/var/…`, a
  /// container reached through a symlink, a relative path. Missing the match
  /// there did not withhold a claim, it *made* one, on the single directory
  /// that must not be claimed.
  ///
  /// Asking here also covers the level the adapter could not speak for at all:
  /// `Logs` created as an *intermediate* of `<Library>/Logs/mine` is the same
  /// conventional directory as `Logs` created as a leaf, and a claim threaded
  /// down from the caller describes only the leaf.
  private static func isConventional(_ url: URL) -> Bool {
    if sameDirectory(url, conventionalLogDirectory) { return true }
    seamLock.lock()
    defer { seamLock.unlock() }
    return conventionalDirectoriesForTesting.contains { sameDirectory(url, $0) }
  }

  /// Two names for one directory.
  ///
  /// Either spelling matching is enough, and the asymmetry is deliberate. A
  /// missed match claims a directory that must not be claimed; a spurious one
  /// only withholds directory-wide settings from a directory whose artifacts
  /// are protected individually regardless. The comparison is therefore
  /// allowed to be generous, and every fallback below is written to fail in
  /// that direction.
  private static func sameDirectory(_ lhs: URL, _ rhs: URL) -> Bool {
    lhs.standardizedFileURL.path == rhs.standardizedFileURL.path
      || canonicalDirectoryPath(lhs) == canonicalDirectoryPath(rhs)
  }

  /// A directory's canonical path, resolved as far as the filesystem allows.
  ///
  /// `realpath` needs every component to exist, and the directory being asked
  /// about may be the one that does not yet — that is the whole question. So
  /// the *parent* is resolved, which does exist by the time this is asked, and
  /// the last component is appended verbatim: every symlink above the leaf is
  /// gone, and the leaf is either a directory `mkdir` has just created or the
  /// name being decided about, neither of which is a link.
  ///
  /// A parent that will not resolve falls back to the standardized spelling,
  /// which `sameDirectory` compares as well — so an unreadable ancestor cannot
  /// turn a conventional directory into a claimed one by making the canonical
  /// forms disagree.
  private static func canonicalDirectoryPath(_ url: URL) -> String {
    let standardized = url.standardizedFileURL
    let parent = standardized.deletingLastPathComponent()
    guard let resolved = realpath(parent.path, nil) else { return standardized.path }
    defer { free(resolved) }
    return URL(fileURLWithPath: String(cString: resolved))
      .appendingPathComponent(standardized.lastPathComponent).path
  }

  /// Creates `url` and every missing parent as owner-only directories.
  ///
  /// **A directory this call did not create is inspected, never changed.** The
  /// log path is caller-supplied and nothing constrains it to a directory this
  /// package owns — `<Documents>/app.log` is a perfectly ordinary thing to ask
  /// for, and `Documents` belongs to the host app. Every one of the three
  /// protections is a property of the *directory* and outlives this sink:
  ///
  /// - the backup exclusion is persistent and directory-wide, so claiming it
  ///   silently takes the app's whole `Documents` tree out of iCloud backup;
  /// - the protection class is inherited by every file created in there
  ///   afterwards, including files this package never writes;
  /// - even the mode is not ours. `0700` looks like harmless tightening, but it
  ///   strips group and other access from a directory that may be deliberately
  ///   shared — an app group, an extension, a helper process — and the app has
  ///   no way to know we did it.
  ///
  /// So a pre-existing directory keeps its own policy and a loose mode comes
  /// back as `permissions`, which the writer surfaces as a `protection`
  /// degradation for the app to act on. Report rather than mutate is the rule
  /// the rest of this writer already follows, and the reason the app is told at
  /// all: a world-readable `Logs` left behind by an upgrade or a restored
  /// backup is real, it just is not ours to silently reconfigure.
  ///
  /// A directory this call *creates* gets all three — at every level, not just
  /// the leaf — with one exception, decided per level rather than per call: a
  /// directory whose *name* is a platform convention gets the mode alone, since
  /// creating `<Library>/Logs` first is not the same as owning it. See
  /// `LogDirectoryClaim` and `isConventional`. See also
  /// `createIntermediates(below:)`, which
  /// is also where the asymmetry is written down: a pre-existing **leaf** is
  /// inspected and a loose mode reported, a pre-existing **ancestor** is not
  /// looked at, because `Library` and the container root are `0755` by design
  /// and reporting them would light the degradation bit on every launch.
  ///
  /// **Ownership is decided by `mkdir` itself, not by a check before it.** A
  /// `lstat` that says "nothing here" is a statement about the past by the time
  /// the directory is created, and the gap between the two is long enough for
  /// another process to put a directory — or a symlink to one — in the way.
  /// Losing that race means claiming somebody else's directory, which is the
  /// whole thing this is here to prevent. `mkdir` cannot be raced: it either
  /// creates the leaf, in which case it is ours, or it returns `EEXIST`, in
  /// which case it is not, and the kernel decides which with no window in
  /// between. It does not follow symlinks either, so a link already at the path
  /// is `EEXIST` and is inspected rather than claimed through.
  @discardableResult
  static func createDirectory(at url: URL) throws -> Shortfall {
    // The leaf first, the ancestors only on a miss. Nearly every call finds
    // the directory already there — this runs twice per open and once per
    // rotation, under the registry lock — and the ancestor walk costs ~156 µs
    // of which ~134 µs is pure URL manipulation before any syscall. Both
    // outcomes of this first `mkdir` make the walk unnecessary: success means
    // the parent necessarily existed, and `EEXIST` means the leaf does, and a
    // leaf cannot exist without its ancestors.
    //
    // Subject to the umask, which is why `secure` re-asserts the mode and
    // reads it back rather than trusting this argument.
    var shortfall = Shortfall()
    if mkdir(url.path, mode_t(directoryMode)) == 0 {
      shortfall.formUnion(secure(createdDirectory: url))
      return shortfall
    }
    var failure = errno

    if failure != EEXIST {
      // Anything else — a missing parent, a file where a parent should be, a
      // permissions wall — is the walk's to diagnose: it reports the precise
      // ancestor and errno rather than this leaf-level guess. Parents first,
      // and by the same `mkdir` rule as the leaf, so "did this call create
      // it" is answered by the kernel for every level rather than only the
      // last one. Then the leaf again, exactly as before the reorder.
      shortfall = try createIntermediates(below: url)
      if mkdir(url.path, mode_t(directoryMode)) == 0 {
        shortfall.formUnion(secure(createdDirectory: url))
        return shortfall
      }
      failure = errno
    }
    guard failure == EEXIST else { throw posixError(failure, at: url) }

    // `EEXIST` says something is there, not that it is a directory: a regular
    // file, a symlink to one, or a dangling link all answer the same way. That
    // is a configuration error and has to stay one. Reporting it as a mere
    // shortfall would leave the sink to fail on the open a moment later, and a
    // destination that accepts records into a path that can never hold them is
    // worse than one that refuses to start. `stat`, not `lstat` — a symlink to
    // a real directory is a usable directory, and is inspected like any other
    // thing this call did not create.
    var existing = stat()
    if stat(url.path, &existing) != 0 {
      // Its own errno, not a blanket `ENOTDIR`: a dangling link is `ENOENT`, an
      // unreadable parent is `EACCES`, and failing storage is `EIO`. Those want
      // different responses from whoever reads the log about the log.
      let cause = errno
      throw posixError(cause, at: url)
    }
    guard (existing.st_mode & S_IFMT) == S_IFDIR else {
      throw posixError(ENOTDIR, at: url)
    }
    shortfall.formUnion(inspect(url))
    return shortfall
  }

  /// Creates the missing ancestors of `url`, claiming exactly the ones this
  /// call brings into existence.
  ///
  /// `FileManager.createDirectory(withIntermediateDirectories:)` used to do
  /// this, with `.posixPermissions` as its only attribute. That gives a created
  /// intermediate the mode and nothing else: no protection class, no backup
  /// exclusion, and no read-back to say whether even the mode stuck — while the
  /// comment above promises all three to any directory this call creates. A
  /// `Logs` directory whose parent this call also created was the ordinary way
  /// to get one, so the gap was not exotic.
  ///
  /// Shallowest first, one `mkdir` each, for the reason the leaf uses `mkdir`:
  /// ownership is decided by the kernel with no window. A pre-scan for "which
  /// of these are missing" followed by a bulk create would be a statement about
  /// the past, and losing that race means applying this package's policy —
  /// including a persistent, directory-wide backup exclusion — to a directory
  /// somebody else created a moment earlier.
  ///
  /// A directory that is already there is left entirely alone, and unlike the
  /// leaf it is not even inspected. The leaf is the one directory the log files
  /// sit in and a loose mode there is worth reporting; an ancestor is
  /// `Library`, or the container root, or `/var` — app-owned or system-owned,
  /// `0755` by design, and reporting each of them as a shortfall would light
  /// the `protection` degradation bit on every launch for a condition no app
  /// can act on.
  private static func createIntermediates(below url: URL) throws -> Shortfall {
    var chain: [URL] = []
    var current = url.deletingLastPathComponent().standardizedFileURL
    while current.path != "/" && !current.path.isEmpty {
      chain.append(current)
      let parent = current.deletingLastPathComponent().standardizedFileURL
      // A URL whose parent is itself — "/" reached by another spelling, or a
      // relative path that has run out of components. Either way there is
      // nothing above this to create.
      if parent.path == current.path { break }
      current = parent
    }

    var shortfall = Shortfall()
    for directory in chain.reversed() {
      if mkdir(directory.path, mode_t(directoryMode)) == 0 {
        shortfall.formUnion(secure(createdDirectory: directory))
        continue
      }
      let failure = errno
      // Anything else — `ENOTDIR` from a plain file in the way, `EACCES`,
      // failing storage — is thrown rather than left for the leaf's `mkdir` to
      // report as a less specific error about a different path.
      guard failure == EEXIST else { throw posixError(failure, at: directory) }
    }
    return shortfall
  }

  /// The path is safe to carry here: this error is consumed inside the writer —
  /// `attemptReopen` discards it, and the Nitro adapter replaces every open
  /// failure with a payload-free message before anything crosses into
  /// JavaScript, precisely because a path is the kind of string that carries a
  /// username.
  private static func posixError(_ code: Int32, at url: URL) -> NSError {
    NSError(domain: NSPOSIXErrorDomain, code: Int(code),
            userInfo: [NSFilePathErrorKey: url.path])
  }

  /// What a directory we did not create falls short of, changing nothing.
  ///
  /// Only the mode is reportable. Whether the app excluded its own directory
  /// from backup, or what protection class it chose, are its decisions and not
  /// shortfalls — the writer is not entitled to an opinion on either.
  private static func inspect(_ url: URL) -> Shortfall {
    hasExpectedMode(url, isDirectory: true) ? [] : .permissions
  }

  /// Applies the protections to an artifact that already exists — an archive
  /// just moved into place, a gzip staging file, a directory.
  ///
  /// Called after every `moveItem` as well as after every create: a move
  /// preserves the source's attributes on the same volume, but says nothing
  /// about a destination created by some other means, and the whole point is
  /// that no artifact is exempt.
  ///
  /// Only ever called on an artifact this writer owns. `createDirectory`
  /// decides that question for directories and does not call this when the
  /// answer is no.
  @discardableResult
  static func secure(_ url: URL, isDirectory: Bool = false) -> Shortfall {
    var shortfall = Shortfall()
    let wanted = mode_t(isDirectory ? directoryMode : fileMode)

    if chmod(url.path, wanted) != 0 { shortfall.insert(.permissions) }
    if currentMode(of: url, followingLinks: isDirectory) != wanted {
      shortfall.insert(.permissions)
    }

    shortfall.formUnion(protect(url, isDirectory: isDirectory))
    return shortfall
  }

  /// The same for a directory this call has just created, bound to the inode
  /// rather than to the name.
  ///
  /// `mkdir` returning 0 proves this process created it. It does not prove the
  /// name still leads there a microsecond later — and every step after it used
  /// to be path-based. Rename the new directory away, drop a symlink at the
  /// name it had, and a path `chmod` follows the link: the mode lands on the
  /// target, and the path read-back follows the same link and agrees. The
  /// comment on `currentMode` used to describe following links for directories
  /// as simply matching what `chmod` did, which is true and is not the same as
  /// safe.
  ///
  /// Opening `O_DIRECTORY | O_NOFOLLOW` immediately after the `mkdir` takes the
  /// name out of every step that follows: `O_NOFOLLOW` refuses outright if a
  /// link is sitting at the name, and from there `fchmod` and `fstat` carry no
  /// name at all, so there is nothing left to redirect.
  ///
  /// **What that does not establish**, stated because the version of this
  /// comment that did not state it is the finding this method came from: a
  /// successful open does not prove this is the inode `mkdir` created. A rename
  /// away and a *real* directory left at the name is not a symlink, and
  /// `O_NOFOLLOW` has no opinion about it — so a replacement that lands in the
  /// gap between the `mkdir` and the `open` is neither refused nor noticed.
  /// This call then holds a descriptor for the replacement, every check below
  /// agrees about it, and it reports success about a directory this process did
  /// not create. Nothing here detects that, and it is worth being exact about
  /// which window is which:
  ///
  /// - a symlink at the name **when this opens** is refused, by `O_NOFOLLOW`;
  /// - a replacement **after the descriptor is acquired** is detected, because
  ///   the protection class and the backup exclusion have no descriptor-based
  ///   setter and so still go out by name, but what they did is read back
  ///   **through the descriptor** — landing on another inode comes back as
  ///   `.protection`, and the app is told its logs are degraded rather than
  ///   told they are fine;
  /// - a replacement **between the `mkdir` and the `open`** is neither.
  ///
  /// All three need write access to the parent, which inside app-private
  /// storage means code already running as this app: the attacker PRIVACY.md's
  /// threat model excludes, and one that can read the log files directly, which
  /// is what these protections are for. `secure(descriptor:at:)` makes the same
  /// argument for files and says why an inode comparison would be weaker.
  @discardableResult
  static func secure(createdDirectory url: URL) -> Shortfall {
    let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      // A symlink is sitting at the name, or it no longer opens as a directory
      // at all. Either way this call cannot reach what it made, and must not
      // apply the claim to whatever is there instead.
      return [.permissions, .protection]
    }
    defer { close(descriptor) }
    return secure(directoryDescriptor: descriptor, at: url)
  }

  /// The same, given a descriptor the caller already holds.
  ///
  /// Split out so the mismatch this reports on can be handed to it directly: a
  /// descriptor for one directory and the name of another is exactly the state
  /// a swap leaves behind, and there is no other way to arrange it from a test
  /// — the window it lives in is inside this call.
  @discardableResult
  static func secure(directoryDescriptor descriptor: Int32, at url: URL) -> Shortfall {
    var shortfall = Shortfall()
    let wanted = mode_t(directoryMode)
    if fchmod(descriptor, wanted) != 0 { shortfall.insert(.permissions) }
    var opened = stat()
    guard fstat(descriptor, &opened) == 0 else { return [.permissions, .protection] }
    if (opened.st_mode & 0o7777) != wanted { shortfall.insert(.permissions) }

    // A conventional directory gets the mode and stops there — see
    // `LogDirectoryClaim`. Not a shortfall: nothing failed, and nothing was
    // supposed to happen. Reporting one would light the degradation bit on
    // every launch for a decision this package made on purpose.
    guard !isConventional(url) else { return shortfall }

    shortfall.formUnion(protect(url, isDirectory: true))
    if !isProtected(descriptor: descriptor) { shortfall.insert(.protection) }
    return shortfall
  }

  /// The same, through an open descriptor.
  ///
  /// `fchmod` cannot be redirected: it acts on the file the caller already
  /// holds, so nothing can swap a symlink in between deciding on a path and
  /// changing its mode. Preferred wherever a descriptor is available, which is
  /// everywhere the active log file is concerned.
  ///
  /// The protection class and backup exclusion have no descriptor-based
  /// *setter*, so they still go through the path — but what they did is then
  /// **read back through the descriptor**, never through the name.
  ///
  /// Comparing inodes after the fact is not enough, and that is the whole
  /// reason this is written the long way. `lstat(path)` matching the descriptor
  /// proves only that the name points here *now*. A rename away, a decoy
  /// created under the name, the protections landing on the decoy, and a rename
  /// back leaves every inode comparison agreeing while this app's file has no
  /// protection at all. Asking the descriptor whether the xattr and the
  /// protection class are actually on it has no such window: there is no name
  /// in the question, so there is nothing to swap.
  @discardableResult
  static func secure(descriptor: Int32, at url: URL) -> Shortfall {
    var shortfall = Shortfall()
    let wanted = mode_t(fileMode)

    if fchmod(descriptor, wanted) != 0 { shortfall.insert(.permissions) }
    var opened = stat()
    guard fstat(descriptor, &opened) == 0 else { return [.permissions, .protection] }
    if (opened.st_mode & 0o7777) != wanted { shortfall.insert(.permissions) }

    shortfall.formUnion(protect(url, isDirectory: false))
    if !isProtected(descriptor: descriptor) { shortfall.insert(.protection) }
    return shortfall
  }

  /// Whether `url` still names the inode described by `info`.
  ///
  /// A point-in-time answer, and only ever used as one: it tells the writer
  /// whether the descriptor it just opened is still reachable under the path
  /// that rotation and purge will address it by. It is *not* evidence about
  /// protections — see `secure(descriptor:at:)` for why.
  static func namesSameFile(_ url: URL, as info: stat) -> Bool {
    var onDisk = stat()
    guard lstat(url.path, &onDisk) == 0 else { return false }
    return onDisk.st_dev == info.st_dev && onDisk.st_ino == info.st_ino
  }

  /// The extended attribute `isExcludedFromBackup` writes. Reading it back is
  /// the only way to ask the *file* — rather than a path — whether exclusion
  /// stuck.
  private static let backupExclusionKey = "com.apple.metadata:com_apple_backup_excludeItem"

  /// From `<sys/fcntl.h>`. Spelled out rather than imported: these macros are
  /// not surfaced to Swift consistently across SDKs, and a missing symbol would
  /// fail the build over a check that exists to be belt-and-braces.
  private static let getProtectionClassCommand: Int32 = 63
  private static let protectionClassCompleteUntilFirstAuth: Int32 = 3

  /// Whether the protections are on the file this descriptor holds.
  static func isProtected(descriptor: Int32) -> Bool {
    guard fgetxattr(descriptor, backupExclusionKey, nil, 0, 0, 0) >= 0 else { return false }

    #if os(iOS) || os(tvOS) || os(watchOS)
    // Only iOS-family filesystems carry a protection class; asking elsewhere
    // returns an error that would be read as a shortfall on every single file.
    let assigned = fcntl(descriptor, getProtectionClassCommand)
    guard assigned == protectionClassCompleteUntilFirstAuth else { return false }
    #endif

    return true
  }

  /// Test seam: forced into `protect`'s result, **for directories only** and
  /// **only under an injected root**.
  ///
  /// The directory restriction is load-bearing, not tidiness. `protect` also
  /// runs for the log file, whose shortfall the writer folds into the same
  /// `.protection` flag — so a fault that applied to both would light that flag
  /// by the file route no matter what the directory route did, and a test
  /// asserting the flag would pass with the directory shortfall discarded. That
  /// is the exact defect being pinned, so the seam must not be able to supply
  /// the answer.
  ///
  /// The root scoping and the lock keep the seam honest under parallel test
  /// execution: this state is process-wide, and an unscoped fault set by one
  /// test would degrade whatever directory another test happens to create
  /// while it is set. Each test injects under its own unique temp root and
  /// clears only that root in teardown, so tests can neither poison nor
  /// un-poison each other.
  ///
  /// A seam is needed because the failure it stands in for cannot be arranged
  /// from a test. `protect` fails when the system refuses the protection class
  /// or the backup exclusion — the first is compiled out on macOS, where these
  /// tests run, and the second succeeds on any directory `mkdir` just created.
  /// Making it fail for real would take an immutable flag applied in the gap
  /// between `mkdir` and this call, and there is no such gap.
  ///
  /// That matters because this is the *only* branch that reports `.protection`
  /// on a directory: a directory found already there goes to `inspect`, which
  /// reports the mode alone. So without this, the one shortfall the registry
  /// can observe and the writer must be told about is also the one no test can
  /// produce — which is how it came to be discarded unnoticed in the first
  /// place.
  /// Shared by both seams below, and named for that rather than for either.
  private static let seamLock = NSLock()
  private static var directoryProtectionFaults: [String: Shortfall] = [:]

  /// Test seam: further directories to treat as platform conventions.
  ///
  /// The real one is `<Library>/Logs`, which on the test host is the
  /// developer's own — a test may not create it and must not touch its backup
  /// policy. So the rule is exercised against a directory under the test's own
  /// root, declared conventional here, and `isConventional` compares it by the
  /// same identity rule it applies to the real one.
  ///
  /// What this replaced is why it exists. The claim used to be a parameter the
  /// caller passed, so a test could hand `.modeOnly` straight to the securing
  /// call — which pinned the plumbing and left the decision itself, the part
  /// that was wrong, unexercised.
  ///
  /// Scoped and cleared per test, for the reason the fault map above is: the
  /// state is process-wide, and a directory left declared conventional by one
  /// test would silently withhold the claim from another test's directory.
  private static var conventionalDirectoriesForTesting: Set<URL> = []

  static func addConventionalDirectoryForTesting(_ url: URL) {
    seamLock.lock()
    conventionalDirectoriesForTesting.insert(url)
    seamLock.unlock()
  }

  static func removeConventionalDirectoryForTesting(_ url: URL) {
    seamLock.lock()
    conventionalDirectoriesForTesting.remove(url)
    seamLock.unlock()
  }

  static func injectDirectoryProtectionFaultForTesting(_ shortfall: Shortfall, under root: URL) {
    seamLock.lock()
    directoryProtectionFaults[root.path] = shortfall
    seamLock.unlock()
  }

  static func clearDirectoryProtectionFaultsForTesting(under root: URL) {
    seamLock.lock()
    directoryProtectionFaults.removeValue(forKey: root.path)
    seamLock.unlock()
  }

  /// The file twin, and deliberately a *separate* map rather than dropping the
  /// `isDirectory` guard above.
  ///
  /// Widening the directory seam to cover both would have destroyed the reason
  /// it is restricted: a fault reaching the file route lights `.protection` no
  /// matter what the directory route decides, so the four directory tests
  /// would start passing with the decision they exist to pin discarded. Two
  /// maps keep each seam unable to answer for the other.
  ///
  /// This exists because the file-mode branch had no working statement at all.
  /// `testWriterFlagsProtectionWhenAModeCannotBeApplied` tried to arrange the
  /// fault with `UF_IMMUTABLE`, which denies `open(O_RDWR)` with `EPERM` for
  /// any uid — so `try? makeHandle()` returned nil, the `if let` never bound,
  /// and the test executed zero assertions on every run since it was written.
  /// `XCTUnwrap` would not have fixed it: the open genuinely cannot succeed,
  /// so it would have been always-red rather than always-vacuous.
  private static var fileProtectionFaults: [String: Shortfall] = [:]

  static func injectFileProtectionFaultForTesting(_ shortfall: Shortfall, under root: URL) {
    seamLock.lock()
    fileProtectionFaults[root.path] = shortfall
    seamLock.unlock()
  }

  static func clearFileProtectionFaultsForTesting(under root: URL) {
    seamLock.lock()
    fileProtectionFaults.removeValue(forKey: root.path)
    seamLock.unlock()
  }

  /// Path-boundary prefix match: `/a/b` covers `/a/b` and `/a/b/c`, and does
  /// NOT cover `/a/bc` — a bare `hasPrefix` would, and the UUID roots only make
  /// that collision unlikely, not impossible.
  private static func injectedFault(for url: URL, isDirectory: Bool) -> Shortfall {
    seamLock.lock()
    defer { seamLock.unlock() }
    let faults = isDirectory ? directoryProtectionFaults : fileProtectionFaults
    var result = Shortfall()
    for (root, fault) in faults
    where url.path == root || url.path.hasPrefix(root + "/") {
      result.formUnion(fault)
    }
    return result
  }

  /// Data protection plus backup exclusion, reported rather than thrown.
  private static func protect(_ url: URL, isDirectory: Bool) -> Shortfall {
    var shortfall = injectedFault(for: url, isDirectory: isDirectory)

    #if os(iOS) || os(tvOS) || os(watchOS)
    // Directories carry a protection class too, and it is what newly created
    // children inherit — setting it only on files leaves anything the system
    // creates in there unprotected.
    do {
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: url.path
      )
    } catch {
      shortfall.insert(.protection)
    }
    #endif

    var resource = URLResourceValues()
    resource.isExcludedFromBackup = true
    var mutable = url
    do {
      try mutable.setResourceValues(resource)
    } catch {
      shortfall.insert(.protection)
    }

    _ = isDirectory
    return shortfall
  }

  /// The mode actually on disk, by name.
  ///
  /// Following links has to match what `chmod` just did, or the check
  /// contradicts the change. A log *directory* reached through a symlink is
  /// supported — the registry resolves it, and `chmod` follows it — so
  /// verifying that one with `lstat` would read the link's own `0755` and
  /// report a shortfall against a target that is correctly `0700`. A log
  /// *file*, by contrast, must never be a link at all, so there `lstat` is the
  /// point: the mode of the link itself is exactly what we want to see.
  ///
  /// **A path read-back agrees with a path write, including when both were
  /// redirected.** That is the limit of what this can say, and it used to be
  /// the only thing said about it. If something replaces the name between the
  /// `chmod` and this call, both follow the replacement and both report
  /// success about an inode this process never made. Nothing here can detect
  /// that, because there is a name in the question.
  ///
  /// Which is why the directory this call creates no longer comes through here
  /// at all — `secure(createdDirectory:)` holds a descriptor from immediately
  /// after the `mkdir` and asks `fstat`, where there is no name to redirect.
  /// This remains for the artifacts reached by name and nothing else: a
  /// pre-existing directory, which is inspected rather than changed, and the
  /// path-based file `secure`, whose callers have no descriptor.
  static func currentMode(of url: URL, followingLinks: Bool) -> mode_t? {
    var info = stat()
    let ok = followingLinks ? stat(url.path, &info) == 0 : lstat(url.path, &info) == 0
    guard ok else { return nil }
    return info.st_mode & 0o7777
  }

  /// Whether `url`'s POSIX mode is exactly what this type should have.
  static func hasExpectedMode(_ url: URL, isDirectory: Bool) -> Bool {
    currentMode(of: url, followingLinks: isDirectory)
      == mode_t(isDirectory ? directoryMode : fileMode)
  }
}
