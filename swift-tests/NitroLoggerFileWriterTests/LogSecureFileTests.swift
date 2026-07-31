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
  ///
  /// With a control, because `.protection` is a folded bit with twelve
  /// contributors — the directory, the log file, the sidecar, every archive
  /// and every staging file. "Some route set it" is not the claim; "this
  /// directory set it" is, and only a writer over a directory this test did
  /// not loosen can tell those apart.
  func testALooseHostDirectoryDegradesTheWriter() throws {
    let control = try makeHandle(at: root.appendingPathComponent("control/app.log"))
    XCTAssertEqual(
      control.status().degraded & LogDegradation.protection.rawValue, 0,
      "a directory the writer made itself is not a protection shortfall, "
        + "so the assertion below would be satisfied by something else")
    _ = control.close(deadlineMs: 1000)

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

  /// A protection failure on the log directory reaches the app.
  ///
  /// This is the shortfall that is easiest to lose, because exactly one call
  /// can see it. `createDirectory` evaluates the backup exclusion and the
  /// protection class only where its own `mkdir` won; anything that finds the
  /// directory already there is answered by `inspect`, which reports the mode
  /// and nothing else. The registry resolves the path before building the
  /// writer, and resolving must create the directory first because `realpath`
  /// only answers for things that exist — so the registry always wins that
  /// `mkdir` and the writer's own call always lands on `EEXIST`.
  ///
  /// The writer therefore cannot rediscover this for itself. If the registry
  /// drops what it saw, a directory whose backup exclusion silently failed is
  /// indistinguishable from one where it held, for the life of the process —
  /// and "this log is excluded from backup" is exactly the kind of claim a
  /// privacy review relies on.
  func testADirectoryProtectionFailureReachesTheWriter() throws {
    LogSecureFile.injectDirectoryProtectionFaultForTesting(.protection, under: root)

    let handle = try makeHandle()

    XCTAssertNotEqual(
      handle.status().degraded & LogDegradation.protection.rawValue, 0,
      "the only call that can see a directory protection failure discarded it")
    // The directory is otherwise fine: this is not a mode problem wearing a
    // protection label, which is what asserting `degraded != 0` alone would
    // have allowed.
    XCTAssertEqual(mode(of: logsDirectory), 0o700)
    XCTAssertEqual(mode(of: logURL), 0o600)
  }

  /// The registry is where that shortfall is observed, so pin it there too —
  /// otherwise the test above passes on any route that happens to set the flag,
  /// including the writer's own `EEXIST` call reporting something unrelated.
  func testResolveCarriesTheShortfallItObserved() throws {
    LogSecureFile.injectDirectoryProtectionFaultForTesting(.protection, under: root)

    let resolved = try LogWriterRegistry.resolve(path: logURL.path)

    XCTAssertTrue(resolved.shortfall.contains(.protection),
                  "resolve won the mkdir and must hand on what securing found")

    // And the second call — the one the writer makes — genuinely cannot see it,
    // which is what makes carrying it the only way.
    LogSecureFile.clearDirectoryProtectionFaultsForTesting(under: root)
    let second = try LogSecureFile.createDirectory(at: logsDirectory)
    XCTAssertFalse(second.contains(.protection),
                   "a directory it did not create is inspected, not re-secured")
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
  ///
  /// And every level this call *did* create gets all three protections, not
  /// just the leaf. Building the chain with `withIntermediateDirectories` gave
  /// the intermediates the mode alone — no protection class, no backup
  /// exclusion, no read-back — while the promise on `createDirectory` is made
  /// about any directory this call creates. `<Logs>/a/b` is an ordinary way to
  /// reach that gap, not an exotic one.
  func testAMissingLeafUnderMissingParentsIsCreatedAndClaimed() throws {
    let leaf = logsDirectory.appendingPathComponent("a/b/c")

    let shortfall = try LogSecureFile.createDirectory(at: leaf)

    XCTAssertTrue(shortfall.isEmpty)
    for level in [logsDirectory,
                  logsDirectory.appendingPathComponent("a"),
                  logsDirectory.appendingPathComponent("a/b"),
                  leaf] {
      XCTAssertEqual(mode(of: level), 0o700, "\(level.lastPathComponent) is not owner-only")
      XCTAssertTrue(isExcludedFromBackup(level),
                    "\(level.lastPathComponent) was created here and left in backup")
    }
  }

  /// The other half of the same rule: an ancestor that was already there is
  /// neither changed nor judged.
  ///
  /// Not judged is the part worth pinning. A real ancestor is `Library`, or the
  /// container root — app-owned, `0755` by design — so inspecting them the way
  /// the leaf is inspected would report a shortfall on every launch for a
  /// condition no app can act on, and the writer folds that into the same
  /// `protection` degradation bit an app is meant to react to.
  func testAPreExistingAncestorIsNeitherClaimedNorJudged() throws {
    let shared = logsDirectory.appendingPathComponent("shared")
    try FileManager.default.createDirectory(
      at: shared, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o755])
    let leaf = shared.appendingPathComponent("logs")

    let shortfall = try LogSecureFile.createDirectory(at: leaf)

    XCTAssertTrue(shortfall.isEmpty, "an ancestor's mode is not this call's business")
    XCTAssertEqual(mode(of: shared), 0o755, "not ours, so not changed")
    XCTAssertFalse(isExcludedFromBackup(shared), "and its backup policy is not ours either")
    XCTAssertEqual(mode(of: leaf), 0o700)
    XCTAssertTrue(isExcludedFromBackup(leaf))
  }

  /// A conventional directory this call creates gets the mode and stops there.
  ///
  /// `<Library>/Logs` is where an iOS app is expected to put logs, so the host
  /// app and any other library in the process may use it. On a fresh container
  /// the first `open` wins the `mkdir`, and winning that race is not ownership:
  /// the two *directory-wide* protections outlive this sink and are invisible
  /// to the app — the backup exclusion silently takes everything anyone later
  /// puts in `Logs` out of iCloud backup, and the protection class is inherited
  /// by files this package never writes.
  ///
  /// The mode is applied anyway, and that asymmetry is the point: `0700` on a
  /// directory that did not exist a moment ago takes nothing from anyone.
  /// The real conventional directory is `<Library>/Logs`, which on this host is
  /// the developer's own — a test may not create it and must not touch its
  /// backup policy — so the rule is pointed at a directory under this test's
  /// root instead. What it exercises is the decision itself: the claim used to
  /// be a parameter, and a test that passed `.modeOnly` in pinned the plumbing
  /// while leaving the part that was wrong — which directory that is —
  /// unexercised.
  func testAConventionalDirectoryIsCreatedButNotClaimed() throws {
    // Directly under `root`, which nothing has claimed. Under `logsDirectory`
    // the assertion could not isolate the leaf: the exclusion on a directory
    // reads back as set on everything inside it, so a claimed parent answers
    // for its children and the test would pass whatever this call did.
    let leaf = root.appendingPathComponent("conventional")
    declareConventional(leaf)

    let shortfall = try LogSecureFile.createDirectory(at: leaf)

    XCTAssertTrue(shortfall.isEmpty,
                  "nothing failed; the claim was withheld on purpose, which is not a shortfall")
    XCTAssertEqual(mode(of: leaf), 0o700, "the mode is still ours to set")
    XCTAssertFalse(isExcludedFromBackup(leaf),
                   "a directory-wide backup exclusion would cover files this package never writes")
  }

  /// The same directory reached by another name is the same directory.
  ///
  /// This decision used to be made in the Nitro adapter, comparing the caller's
  /// string against the default directory before anything resolved either — and
  /// a second spelling of one path defeats that: `/var` against `/private/var`,
  /// a container reached through a link, a relative path. The comment there
  /// claimed getting it wrong could only claim *less*. It was the other way
  /// round, on the one directory that must not be claimed at all.
  func testTheConventionalDirectoryIsRecognizedThroughAnotherSpelling() throws {
    let container = root.appendingPathComponent("container")
    try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    let link = root.appendingPathComponent("link")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: container)

    // Declared under its resolved name; asked for under the link's.
    let canonical = container.appendingPathComponent("Logs")
    declareConventional(canonical)

    try LogSecureFile.createDirectory(at: link.appendingPathComponent("Logs"))

    XCTAssertEqual(mode(of: canonical), 0o700)
    XCTAssertFalse(isExcludedFromBackup(canonical),
                   "a spelling the comparison did not recognize would have claimed it in full")
  }

  /// And the decision is per directory, not per call.
  ///
  /// A caller asking for `<Library>/Logs/mine` gets `Logs` created on the way
  /// past, as an intermediate. That is the same conventional directory it would
  /// have been as a leaf, and it was being claimed in full — a claim threaded
  /// down from the caller can only ever describe the last component.
  func testAConventionalDirectoryCreatedAsAnIntermediateIsNotClaimedEither() throws {
    let conventional = root.appendingPathComponent("conventional")
    declareConventional(conventional)
    let leaf = conventional.appendingPathComponent("mine")

    try LogSecureFile.createDirectory(at: leaf)

    XCTAssertEqual(mode(of: conventional), 0o700)
    XCTAssertFalse(isExcludedFromBackup(conventional),
                   "created on the way past, and no more ours for that")
    XCTAssertTrue(isExcludedFromBackup(leaf),
                  "the name the caller chose is claimed as fully as ever")
  }

  /// And the artifacts inside it lose nothing, which is what makes the above
  /// safe rather than merely polite.
  ///
  /// The directory-wide settings were never what protected the log files: every
  /// artifact is secured through its own descriptor when it is created.
  func testArtifactsInAnUnclaimedDirectoryStillGetEverything() throws {
    let leaf = root.appendingPathComponent("conventional")
    declareConventional(leaf)
    try LogSecureFile.createDirectory(at: leaf)
    let file = leaf.appendingPathComponent("app.log")

    let handle = try makeHandle(at: file)
    write(handle, "record\n")

    XCTAssertEqual(mode(of: file), 0o600)
    XCTAssertTrue(isExcludedFromBackup(file),
                  "the file carries its own exclusion, directory or no directory")
  }

  /// The claim on a created directory is bound to the inode, not to the name.
  ///
  /// `createDirectory` only reaches this straight after its own `mkdir`, so in
  /// production the name really does lead to the directory this process made —
  /// but "leads there now" is precisely what a path-based `chmod` assumes and
  /// cannot check. Rename the new directory away, drop a link at the name, and
  /// `chmod` follows it; so does a path read-back, so the two agree about an
  /// inode nobody here created.
  ///
  /// Handed a symlink, the descriptor path refuses outright rather than
  /// applying this package's policy — a persistent, directory-wide backup
  /// exclusion, and a protection class every later child inherits — to a
  /// directory somebody else owns.
  func testSecuringACreatedDirectoryRefusesToFollowASymlink() throws {
    let target = root.appendingPathComponent("someone-elses")
    try FileManager.default.createDirectory(
      at: target, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o755])
    let link = root.appendingPathComponent("link")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

    let shortfall = LogSecureFile.secure(createdDirectory: link)

    XCTAssertTrue(shortfall.contains(.permissions))
    XCTAssertTrue(shortfall.contains(.protection))
    XCTAssertEqual(mode(of: target), 0o755,
                   "the directory behind the link keeps its own mode")
    XCTAssertFalse(isExcludedFromBackup(target),
                   "and its backup policy is still its own")
  }

  /// A directory that is no longer at the name is reported, never called
  /// secured.
  ///
  /// `O_NOFOLLOW` refuses a *symlink* sitting at the name when the securing
  /// call opens it, which is the case above. This is the other window: a
  /// replacement arriving once the descriptor is already held. The protection
  /// class and the backup exclusion have no descriptor-based setter, so they go
  /// out through the path, and the only reason that is acceptable is that what
  /// they did is read back through the descriptor — so they are reported as
  /// missing rather than applied.
  ///
  /// Not every window is covered, and this test does not pretend otherwise: a
  /// real directory swapped in between the `mkdir` and the `open` is neither
  /// refused nor detected, because the descriptor is then the replacement and
  /// everything below agrees about it. All of these need write access to the
  /// parent — code already running as this app, which can read the log files
  /// anyway. See `secure(createdDirectory:)`.
  ///
  /// A descriptor for one directory and the name of another is exactly the
  /// state that swap leaves behind, so it is handed over directly — the window
  /// it lives in is inside the call, and there is no other way to be in it.
  func testSecuringADirectoryTheNameNoLongerLeadsToIsReportedAsAShortfall() throws {
    let held = root.appendingPathComponent("held")
    try FileManager.default.createDirectory(at: held, withIntermediateDirectories: true)
    let decoy = root.appendingPathComponent("decoy")
    try FileManager.default.createDirectory(at: decoy, withIntermediateDirectories: true)

    let descriptor = open(held.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    XCTAssertGreaterThanOrEqual(descriptor, 0)
    defer { close(descriptor) }

    let shortfall = LogSecureFile.secure(directoryDescriptor: descriptor, at: decoy)

    XCTAssertTrue(shortfall.contains(.protection),
                  "the protections went to the name, and the name is not this directory")
    XCTAssertFalse(isExcludedFromBackup(held),
                   "which the descriptor read-back is the only way to notice")
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

  /// A protection shortfall on the *file* is reported rather than swallowed.
  ///
  /// This test used to arrange the fault with `UF_IMMUTABLE` and guard its
  /// assertion behind `if let handle = try? makeHandle()`. The immutable flag
  /// denies `open(O_RDWR)` with `EPERM` for any uid, root included, so the
  /// optional never bound and the body never ran: **zero assertions on every
  /// run since it was written**, reported as a pass each time. `XCTUnwrap`
  /// would not have fixed it — the open genuinely cannot succeed under that
  /// flag, so it would have become always-red rather than always-vacuous.
  ///
  /// It also asserted on the wrong thing. The writer folds the directory's
  /// shortfall and the file's into one `.protection` bit, and on macOS the
  /// directory's backup exclusion fails for an ordinary temporary directory —
  /// so `status().degraded` already carries that bit before the file is
  /// considered at all. Measured: the handle's mask is 16 with nothing wrong,
  /// while `secure(file)` returns an empty shortfall. Any assertion about the
  /// file route made through the aggregate mask is therefore satisfied by the
  /// directory route and says nothing.
  ///
  /// So this asks the file call directly, where the answer is the file's own.
  func testAFileProtectionShortfallIsReported() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    LogSecureFile.injectFileProtectionFaultForTesting(.protection, under: root)
    defer { LogSecureFile.clearFileProtectionFaultsForTesting(under: root) }

    let shortfall = LogSecureFile.secure(logURL, isDirectory: false)

    XCTAssertTrue(shortfall.contains(.protection),
                  "a protection the file did not receive must be reported")
  }

  /// The positive control, and the reason the test above is not vacuous.
  ///
  /// Without it, a `secure` that reported `.protection` unconditionally would
  /// satisfy the assertion — which is exactly the state the aggregate mask is
  /// in on this platform. An empty shortfall here is what makes the flag above
  /// attributable to the injected fault.
  func testAFileWithNoInjectedFaultReportsNothing() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: logURL.path, contents: nil)

    XCTAssertEqual(LogSecureFile.secure(logURL, isDirectory: false), [],
                   "nothing was wrong with this file; nothing may be reported")
  }

  /// The seams are separate, and this is the statement that keeps them so.
  ///
  /// A single map covering both would let a directory test's injected fault
  /// reach the file route, lighting `.protection` there regardless of what the
  /// directory decided — which is the defect the directory seam's own comment
  /// warns about, and the reason widening it was the wrong fix.
  func testTheDirectorySeamDoesNotReachTheFileRoute() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: logURL.path, contents: nil)
    LogSecureFile.injectDirectoryProtectionFaultForTesting(.protection, under: root)
    defer { LogSecureFile.clearDirectoryProtectionFaultsForTesting(under: root) }

    XCTAssertEqual(LogSecureFile.secure(logURL, isDirectory: false), [],
                   "a directory fault must not answer for a file")
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
    //
    // The decoy is built elsewhere and *renamed* into place rather than written
    // at the path directly. That is what a real name-swap does, and it is also
    // the only version of this that is not flaky: creating a file at a path a
    // protected file just vacated let it intermittently come up carrying the
    // backup-exclusion xattr, which is metadata this test exists to prove it
    // does not have. A rename brings the decoy's own metadata with it.
    let parked = logsDirectory.appendingPathComponent("parked.txt")
    try FileManager.default.moveItem(at: original, to: parked)
    let impostor = logsDirectory.appendingPathComponent("impostor.txt")
    try Data("decoy".utf8).write(to: impostor)
    try FileManager.default.moveItem(at: impostor, to: original)

    XCTAssertTrue(LogSecureFile.isProtected(descriptor: fd),
                  "the protected file is still protected, whatever holds its old name")

    let decoy = open(original.path, O_RDWR)
    XCTAssertGreaterThanOrEqual(decoy, 0)
    defer { close(decoy) }
    XCTAssertFalse(LogSecureFile.isProtected(descriptor: decoy),
                   "and the impostor is not protected just because it wears the name")
  }
}
