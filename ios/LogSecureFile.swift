import Foundation

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
  /// A directory this call *creates* is unambiguously ours and gets all three —
  /// at every level, not just the leaf. See `createIntermediates(below:)`, which
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
    // Parents first, so the leaf `mkdir` has somewhere to land — and by the
    // same `mkdir` rule as the leaf, so "did this call create it" is answered
    // by the kernel for every level rather than only for the last one.
    var shortfall = try createIntermediates(below: url)

    // Subject to the umask, which is why `secure` re-asserts the mode and reads
    // it back rather than trusting this argument.
    if mkdir(url.path, mode_t(directoryMode)) == 0 {
      shortfall.formUnion(secure(url, isDirectory: true))
      return shortfall
    }
    let failure = errno
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
        shortfall.formUnion(secure(directory, isDirectory: true))
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
  private static let faultLock = NSLock()
  private static var directoryProtectionFaults: [String: Shortfall] = [:]

  static func injectDirectoryProtectionFaultForTesting(_ shortfall: Shortfall, under root: URL) {
    faultLock.lock()
    directoryProtectionFaults[root.path] = shortfall
    faultLock.unlock()
  }

  static func clearDirectoryProtectionFaultsForTesting(under root: URL) {
    faultLock.lock()
    directoryProtectionFaults.removeValue(forKey: root.path)
    faultLock.unlock()
  }

  /// Path-boundary prefix match: `/a/b` covers `/a/b` and `/a/b/c`, and does
  /// NOT cover `/a/bc` — a bare `hasPrefix` would, and the UUID roots only make
  /// that collision unlikely, not impossible.
  private static func injectedFault(for url: URL) -> Shortfall {
    faultLock.lock()
    defer { faultLock.unlock() }
    var result = Shortfall()
    for (root, fault) in directoryProtectionFaults
    where url.path == root || url.path.hasPrefix(root + "/") {
      result.formUnion(fault)
    }
    return result
  }

  /// Data protection plus backup exclusion, reported rather than thrown.
  private static func protect(_ url: URL, isDirectory: Bool) -> Shortfall {
    var shortfall = isDirectory ? injectedFault(for: url) : Shortfall()

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

  /// The mode actually on disk.
  ///
  /// Following links has to match what `chmod` just did, or the check
  /// contradicts the change. A log *directory* reached through a symlink is
  /// supported — the registry resolves it, and `chmod` follows it — so
  /// verifying that one with `lstat` would read the link's own `0755` and
  /// report a shortfall against a target that is correctly `0700`. A log
  /// *file*, by contrast, must never be a link at all, so there `lstat` is the
  /// point: the mode of the link itself is exactly what we want to see.
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
