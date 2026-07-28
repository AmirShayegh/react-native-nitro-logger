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
  /// `withIntermediateDirectories` applies the attributes to directories it
  /// creates, but says nothing about ones that already exist — an app upgrade
  /// or a restored backup can leave a `Logs` directory someone else's code
  /// made world-readable. So the mode is asserted afterwards either way, and
  /// then read back.
  @discardableResult
  static func createDirectory(at url: URL) throws -> Shortfall {
    try FileManager.default.createDirectory(
      at: url,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: directoryMode]
    )
    return secure(url, isDirectory: true)
  }

  /// Applies the protections to an artifact that already exists — an archive
  /// just moved into place, a gzip staging file, a directory.
  ///
  /// Called after every `moveItem` as well as after every create: a move
  /// preserves the source's attributes on the same volume, but says nothing
  /// about a destination created by some other means, and the whole point is
  /// that no artifact is exempt.
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

  /// Data protection plus backup exclusion, reported rather than thrown.
  private static func protect(_ url: URL, isDirectory: Bool) -> Shortfall {
    var shortfall = Shortfall()

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
