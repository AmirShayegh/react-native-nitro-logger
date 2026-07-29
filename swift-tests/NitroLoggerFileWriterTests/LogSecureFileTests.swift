import Foundation
import XCTest
@testable import NitroLoggerFileWriter

/// The protections are only worth anything if they hold on *every* artifact.
/// An archive that inherits default permissions is exactly as readable as the
/// log it was rotated from, so each of these asserts the mode that is actually
/// on disk rather than the one that was requested.
final class LogSecureFileTests: LogWriterTestCase {

  private func mode(of url: URL) -> Int? {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
          let permissions = attributes[.posixPermissions] as? NSNumber else { return nil }
    return permissions.intValue
  }

  private func isExcludedFromBackup(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup ?? false
  }

  // MARK: - Types get their own modes

  /// A directory needs the execute bit or nothing inside it can be reached by
  /// path; a file must not have it. `0700` on a file is the kind of thing that
  /// gets copied into the next project.
  func testDirectoryAndFileGetTypeSpecificModes() throws {
    _ = try makeHandle()
    XCTAssertEqual(mode(of: logsDirectory), 0o700)
    XCTAssertEqual(mode(of: logURL), 0o600)
    XCTAssertTrue(LogSecureFile.hasExpectedMode(logsDirectory, isDirectory: true))
    XCTAssertTrue(LogSecureFile.hasExpectedMode(logURL, isDirectory: false))
  }

  /// The execute bit is not decoration: without it the file below cannot be
  /// opened by path at all.
  func testOwnerOnlyDirectoryIsStillTraversable() throws {
    let nested = logsDirectory.appendingPathComponent("a/b/c")
    let handle = try makeHandle(at: nested.appendingPathComponent("app.log"))
    write(handle, "reachable\n")
    XCTAssertTrue(handle.flush(deadlineMs: 1000).durable)

    for level in [logsDirectory,
                  logsDirectory.appendingPathComponent("a"),
                  logsDirectory.appendingPathComponent("a/b"),
                  nested] {
      XCTAssertEqual(mode(of: level), 0o700, "\(level.lastPathComponent) is not owner-only")
    }
    XCTAssertEqual(contents(of: nested.appendingPathComponent("app.log")), "reachable\n")
  }

  /// An app upgrade or a restored backup can leave a directory someone else's
  /// code made world-readable. The writer reports that and does not fix it:
  /// the log path is caller-supplied, so a directory that was already there
  /// belongs to the app, and `0700` would strip access from an app group or an
  /// extension that was deliberately given it. The app is told instead.
  func testPreExistingLooseDirectoryIsReportedNotTightened() throws {
    try FileManager.default.createDirectory(
      at: logsDirectory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o777])

    let shortfall = try LogSecureFile.createDirectory(at: logsDirectory)

    XCTAssertEqual(mode(of: logsDirectory), 0o777, "a directory we did not create is not changed")
    XCTAssertTrue(shortfall.contains(.permissions), "but the app is told it is loose")
  }

  /// The same directory, reached through the writer: the loose mode surfaces
  /// as a `protection` degradation rather than being silently corrected.
  func testALooseHostDirectoryDegradesTheWriter() throws {
    try FileManager.default.createDirectory(
      at: logsDirectory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o777])

    let handle = try makeHandle()

    XCTAssertNotEqual(handle.status().degraded & LogDegradation.protection.rawValue, 0,
                      "a directory the app left loose is reported, not repaired")
    XCTAssertEqual(mode(of: logURL), 0o600, "the writer's own file is still locked down")
  }

  /// A pre-existing directory keeps its own mode; one this call creates gets
  /// the full treatment. Both halves in one place, because the rule is the
  /// boundary between them.
  func testACreatedDirectoryIsSecuredOutright() throws {
    let shortfall = try LogSecureFile.createDirectory(at: logsDirectory)

    XCTAssertEqual(mode(of: logsDirectory), 0o700)
    XCTAssertTrue(isExcludedFromBackup(logsDirectory))
    XCTAssertTrue(shortfall.isEmpty)
  }

  /// The case that defeats a naive "is it already a directory" check.
  ///
  /// `createDirectory` accepts a symlink that resolves to a directory, and
  /// `lstat` reports the *link* — not a directory — so asking `S_IFDIR` would
  /// answer "nothing here, this one is mine" about the one path where the
  /// target is most obviously somebody else's. Nothing about the target may
  /// change: not its mode, not its backup policy.
  func testASymlinkedDirectoryIsNeverClaimed() throws {
    let target = root.appendingPathComponent("someone-elses")
    try FileManager.default.createDirectory(
      at: target, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o755])
    try FileManager.default.createSymbolicLink(at: logsDirectory, withDestinationURL: target)

    _ = try LogSecureFile.createDirectory(at: logsDirectory)

    XCTAssertEqual(mode(of: target), 0o755, "the link's target keeps its mode")
    XCTAssertFalse(isExcludedFromBackup(target), "and its backup policy")
  }

  /// Missing parents are created and the leaf is still judged on its own.
  ///
  /// The parent chain has to be built before the leaf `mkdir` can land, so this
  /// pins that building it does not accidentally create — and therefore claim —
  /// the leaf as well.
  func testAMissingLeafUnderMissingParentsIsCreatedAndClaimed() throws {
    let leaf = logsDirectory.appendingPathComponent("a/b/c")

    let shortfall = try LogSecureFile.createDirectory(at: leaf)

    XCTAssertTrue(shortfall.isEmpty)
    XCTAssertEqual(mode(of: leaf), 0o700)
    XCTAssertTrue(isExcludedFromBackup(leaf))
  }

  /// A leaf that is not a directory at all fails the call outright.
  ///
  /// `mkdir` answers `EEXIST` for a plain file exactly as it does for a
  /// directory, so the two have to be told apart afterwards. This one is a
  /// configuration error and stays one: reporting it as a shortfall would let
  /// the sink open, accept records, and only fail on a path that can never hold
  /// them. And the file is still not touched on the way out.
  func testAFileSittingWhereTheDirectoryShouldBeIsRejected() throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: logsDirectory.path, contents: Data("x".utf8),
                                   attributes: [.posixPermissions: 0o644])

    XCTAssertThrowsError(try LogSecureFile.createDirectory(at: logsDirectory)) { error in
      XCTAssertEqual((error as NSError).code, Int(ENOTDIR))
    }
    XCTAssertEqual(mode(of: logsDirectory), 0o644, "not ours, so not changed")
    XCTAssertEqual(contents(of: logsDirectory), "x", "and not truncated")
  }

  /// A dangling symlink is rejected too — `EEXIST` from `mkdir`, nothing behind
  /// it — but it reports `ENOENT` rather than `ENOTDIR`.
  ///
  /// The distinction is the point: "the path points at nothing" and "the path
  /// points at something that is not a directory" call for different fixes, and
  /// flattening every `stat` failure into one code would also have swallowed
  /// `EACCES` on an unreadable parent and `EIO` on failing storage.
  func testADanglingSymlinkAtTheDirectoryPathIsRejected() throws {
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(
      at: logsDirectory, withDestinationURL: root.appendingPathComponent("nowhere"))

    XCTAssertThrowsError(try LogSecureFile.createDirectory(at: logsDirectory)) { error in
      XCTAssertEqual((error as NSError).code, Int(ENOENT))
    }
  }

  /// The backup exclusion is the most costly of the three to get wrong: it is
  /// persistent and directory-wide, so claiming `<Documents>` takes the host
  /// app's entire document tree out of iCloud backup, and nothing in the app
  /// would ever report that it happened.
  func testAPreExistingDirectoryIsNotExcludedFromBackup() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)

    _ = try makeHandle()

    XCTAssertFalse(isExcludedFromBackup(logsDirectory),
                   "a directory the host app owns must keep its own backup policy")
    XCTAssertTrue(isExcludedFromBackup(logURL),
                  "the log file is this writer's artifact whoever made the directory")
  }

  /// The other half of the same rule, and the reason it is not simply "never
  /// touch directories": an intermediate directory the writer creates *is*
  /// its own, however deep, and gets the full treatment.
  func testDirectoriesTheWriterCreatesAreExcludedFromBackup() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    let nested = logsDirectory.appendingPathComponent("nested")

    _ = try makeHandle(at: nested.appendingPathComponent("app.log"))

    XCTAssertFalse(isExcludedFromBackup(logsDirectory))
    XCTAssertTrue(isExcludedFromBackup(nested))
  }

  func testPreExistingLooseFileIsTightened() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    FileManager.default.createFile(
      atPath: logURL.path, contents: Data("old\n".utf8),
      attributes: [.posixPermissions: 0o644])
    XCTAssertEqual(mode(of: logURL), 0o644)

    _ = try makeHandle()
    XCTAssertEqual(mode(of: logURL), 0o600)
    XCTAssertEqual(contents(), "old\n", "tightening does not truncate")
  }

  // MARK: - The modes survive every transition

  func testArchiveKeepsOwnerOnlyMode() throws {
    let policy = LogRotationPolicy(maxFileSizeBytes: 64, maxArchivedFilesCount: 100)
    let handle = try makeHandle(policy: policy)
    let record = String(repeating: "x", count: 39) + "\n"
    write(handle, record)
    write(handle, record)

    let archive = try XCTUnwrap(archiveNames().first)
    XCTAssertEqual(mode(of: logsDirectory.appendingPathComponent(archive)), 0o600)
    XCTAssertEqual(mode(of: logURL), 0o600, "and the fresh file too")
  }

  func testCompressedArchiveKeepsOwnerOnlyMode() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 64, maxArchivedFilesCount: 100, compressArchives: true)
    let handle = try makeHandle(policy: policy)
    let record = String(repeating: "x", count: 39) + "\n"
    write(handle, record)
    write(handle, record)

    let archive = try XCTUnwrap(archiveNames().first)
    XCTAssertTrue(archive.hasSuffix(".gz"))
    XCTAssertEqual(mode(of: logsDirectory.appendingPathComponent(archive)), 0o600)
  }

  /// The plaintext original is what survives a failed compression, so its mode
  /// is the one that matters in exactly the case nobody tests.
  func testArchiveKeepsOwnerOnlyModeWhenCompressionFails() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 64, maxArchivedFilesCount: 100, compressArchives: true)
    let handle = try makeHandle(policy: policy, compressor: { _, _ in false })
    let record = String(repeating: "x", count: 39) + "\n"
    write(handle, record)
    write(handle, record)

    let archive = try XCTUnwrap(archiveNames().first)
    XCTAssertFalse(archive.hasSuffix(".gz"))
    XCTAssertEqual(mode(of: logsDirectory.appendingPathComponent(archive)), 0o600)
  }

  func testFileRecreatedAfterAnExternalDeleteKeepsOwnerOnlyMode() throws {
    let handle = try makeHandle()
    write(handle, "before\n")
    try FileManager.default.removeItem(at: logURL)
    for index in 0..<12 { write(handle, "after-\(index)\n") }

    XCTAssertTrue(FileManager.default.fileExists(atPath: logURL.path))
    XCTAssertEqual(mode(of: logURL), 0o600, "a recreated file is not a less protected one")
  }

  func testFileRecreatedAfterAPurgeKeepsOwnerOnlyMode() throws {
    let handle = try makeHandle()
    write(handle, "before\n")
    XCTAssertTrue(handle.clearLogs(deadlineMs: 2000).durable)

    XCTAssertEqual(mode(of: logURL), 0o600)
    XCTAssertEqual(mode(of: logsDirectory), 0o700)
  }

  // MARK: - Backup exclusion

  /// Logs must not ride an iCloud or iTunes backup off the device.
  func testEveryArtifactIsExcludedFromBackup() throws {
    let policy = LogRotationPolicy(maxFileSizeBytes: 64, maxArchivedFilesCount: 100)
    let handle = try makeHandle(policy: policy)
    let record = String(repeating: "x", count: 39) + "\n"
    write(handle, record)
    write(handle, record)

    XCTAssertTrue(isExcludedFromBackup(logsDirectory))
    XCTAssertTrue(isExcludedFromBackup(logURL))
    for archive in archiveNames() {
      XCTAssertTrue(isExcludedFromBackup(logsDirectory.appendingPathComponent(archive)),
                    "\(archive) would ride a backup off the device")
    }
  }

  // MARK: - Reporting

  /// Failures are reported rather than thrown: a log file that exists with the
  /// wrong protection class is a problem the app should know about, but a log
  /// file that could not be created at all is a worse one.
  func testShortfallIsEmptyOnAHealthyDirectory() throws {
    let shortfall = try LogSecureFile.createDirectory(at: logsDirectory)
    XCTAssertTrue(shortfall.isEmpty)
  }

  /// Asking for `0600` and assuming it took is how a world-readable file gets
  /// treated as protected. The mode that matters is the one on disk after.
  func testAModeThatCouldNotBeAppliedIsReported() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: logURL.path, contents: nil,
                                   attributes: [.posixPermissions: 0o644])
    // Immutable: `chmod` now fails, so the 0644 stands.
    TestFlags.makeImmutable(logURL)
    defer { chflags(logURL.path, 0) }

    let shortfall = LogSecureFile.secure(logURL)
    XCTAssertTrue(shortfall.contains(.permissions),
                  "a mode that did not stick must be reported, not assumed")
    XCTAssertFalse(LogSecureFile.hasExpectedMode(logURL, isDirectory: false))
  }

  func testWriterFlagsProtectionWhenAModeCannotBeApplied() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: logURL.path, contents: nil,
                                   attributes: [.posixPermissions: 0o644])
    TestFlags.makeImmutable(logURL)
    defer { chflags(logURL.path, 0) }

    // The file opens (it exists and is writable through an existing
    // descriptor), but the mode cannot be corrected — which the caller learns
    // from the degradation mask rather than from silence.
    if let handle = try? makeHandle() {
      XCTAssertNotEqual(handle.status().degraded & LogDegradation.protection.rawValue, 0)
    }
  }

  func testWriterRefusesToOpenWhereItCannotCreate() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    // Not `chmod`: the owner can always chmod their own directory back, and the
    // re-assertion in `createDirectory` does exactly that. An immutable flag is
    // a fault the writer cannot undo by accident.
    TestFlags.makeImmutable(logsDirectory)
    defer { chflags(logsDirectory.path, 0) }

    XCTAssertThrowsError(try makeHandle()) { error in
      XCTAssertEqual(error as? LogWriterError, .openFailed("could not open the log file"))
    }
  }

  /// Following a symlink at the final component would put the app's log
  /// wherever the link points. The check has to be part of the open, not a
  /// separate `lstat` something can race.
  func testOpenRefusesToFollowASymlinkAtTheFinalComponent() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    let elsewhere = root.appendingPathComponent("elsewhere.log")
    try Data().write(to: elsewhere)
    try FileManager.default.createSymbolicLink(at: logURL, withDestinationURL: elsewhere)

    XCTAssertThrowsError(try makeHandle())
    XCTAssertEqual(try Data(contentsOf: elsewhere).count, 0,
                   "the link target must not have been written to")
  }

  /// A FIFO left at the log path would block the writer forever on open.
  func testOpenRefusesAnythingThatIsNotARegularFile() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    XCTAssertEqual(mkfifo(logURL.path, 0o600), 0)
    defer { try? FileManager.default.removeItem(at: logURL) }

    XCTAssertThrowsError(try makeHandle())
  }

  // MARK: - Protections are verified through the descriptor

  /// The check must be able to tell a protected file from an unprotected one at
  /// all — otherwise everything below is vacuous.
  func testAnUnsecuredDescriptorIsNotReportedAsProtected() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    let plain = logsDirectory.appendingPathComponent("plain.txt")
    try Data("x".utf8).write(to: plain)

    let fd = open(plain.path, O_RDWR)
    XCTAssertGreaterThanOrEqual(fd, 0)
    defer { close(fd) }

    XCTAssertFalse(LogSecureFile.isProtected(descriptor: fd))
    XCTAssertTrue(LogSecureFile.secure(descriptor: fd, at: plain).isEmpty)
    XCTAssertTrue(LogSecureFile.isProtected(descriptor: fd))
  }

  /// The answer follows the inode, not the name — which is the whole reason the
  /// verification moved onto the descriptor.
  ///
  /// Comparing inodes after applying protections by path proves only that the
  /// name points here *now*. Rename the file away, let a decoy take the name,
  /// apply the protections to the decoy, rename back, and every inode
  /// comparison agrees while this app's file has none. Asking the descriptor
  /// has no such window: there is no name in the question.
  func testProtectionIsReportedForTheFileHeldNotTheNameItHad() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    let original = logsDirectory.appendingPathComponent("held.txt")
    try Data("x".utf8).write(to: original)

    let fd = open(original.path, O_RDWR)
    XCTAssertGreaterThanOrEqual(fd, 0)
    defer { close(fd) }
    XCTAssertTrue(LogSecureFile.secure(descriptor: fd, at: original).isEmpty)

    // A decoy takes the name. Path-based verification would now be answering
    // about the decoy; the descriptor keeps answering about the real file.
    let parked = logsDirectory.appendingPathComponent("parked.txt")
    try FileManager.default.moveItem(at: original, to: parked)
    try Data("decoy".utf8).write(to: original)

    XCTAssertTrue(LogSecureFile.isProtected(descriptor: fd),
                  "the protected file is still protected, whatever holds its old name")

    let decoy = open(original.path, O_RDWR)
    XCTAssertGreaterThanOrEqual(decoy, 0)
    defer { close(decoy) }
    XCTAssertFalse(LogSecureFile.isProtected(descriptor: decoy),
                   "and the impostor is not protected just because it wears the name")
  }
}
