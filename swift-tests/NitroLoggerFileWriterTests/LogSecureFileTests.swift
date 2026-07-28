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
  /// code made world-readable, and `withIntermediateDirectories` says nothing
  /// about directories that already exist.
  func testPreExistingLooseDirectoryIsTightened() throws {
    try FileManager.default.createDirectory(
      at: logsDirectory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o777])
    XCTAssertEqual(mode(of: logsDirectory), 0o777)

    _ = try makeHandle()
    XCTAssertEqual(mode(of: logsDirectory), 0o700, "an existing loose directory is re-secured")
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
