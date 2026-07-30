import Foundation
import XCTest
@testable import NitroLoggerFileWriter

/// The support bundle.
///
/// The claim under test is not "a file appeared" but "`gunzip` on it gives you
/// the whole log, in order" — so these decompress with the actual `gzip`
/// binary rather than with a helper written alongside the writer. A
/// reimplementation that agreed with a mistake in the producer would prove
/// nothing, and the tool a support engineer reaches for is the specification.
final class LogCollectTests: LogWriterTestCase {

  private let record = String(repeating: "x", count: 39) + "\n" // 40 bytes

  /// A 40-byte record that says which one it is, so a bundle can be checked
  /// for both content and order. Padded to a fixed width because rotation is
  /// by size and these tests want it to fire predictably.
  private func line(_ index: Int) -> String {
    let head = "line\(index)"
    return head + String(repeating: "x", count: 39 - head.count) + "\n"
  }

  private func policy(
    bytes: Double = 64,
    keep: Double = 10,
    compress: Bool = false
  ) -> LogRotationPolicy {
    LogRotationPolicy(
      maxFileSizeBytes: bytes,
      maxArchivedFilesCount: keep,
      compressArchives: compress
    )
  }

  private var bundleURL: URL {
    logsDirectory.appendingPathComponent(LogWriter.supportName("app.log"))
  }

  /// Writes `count` records, giving every archive rotation produces a distinct
  /// modification time in the order it was created.
  ///
  /// Archives are ordered by mtime; the name only breaks exact ties, and its
  /// stamp has one-second resolution with a random suffix after it. Records
  /// this small are written microseconds apart and land in the same
  /// millisecond, so without this the order of two archives is the order of
  /// two random hex strings — and a test of "the bundle is chronological"
  /// would pass or fail on that. Production rotations are megabytes apart and
  /// get the separation for free; a test has to buy it.
  ///
  /// What this does not prove: how the writer orders two archives that really
  /// do share a modification time. Nothing does — `LogWriter.archives` says so
  /// — and a bundle built from those two is in an arbitrary order between
  /// them.
  private func writeRotating(_ handle: LogFileHandle, count: Int) {
    var stamped: Set<String> = []
    var stamp = Date(timeIntervalSince1970: 1_700_000_000)
    for index in 0..<count {
      write(handle, line(index))
      let fresh = names()
        .filter { LogWriter.isArchiveName($0, baseName: "app.log") }
        .filter { stamped.insert($0).inserted }
        .sorted()
      for name in fresh {
        stamp.addTimeInterval(10)
        try? FileManager.default.setAttributes(
          [.modificationDate: stamp],
          ofItemAtPath: logsDirectory.appendingPathComponent(name).path)
      }
    }
  }

  /// `gzip -dc`, the way somebody handed a bundle would open it.
  private func gunzip(_ url: URL) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["gzip", "-dc", url.path]
    let out = Pipe()
    process.standardOutput = out
    process.standardError = Pipe()
    try process.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0, "gzip refused the bundle")
    return String(decoding: data, as: UTF8.self)
  }

  // MARK: - The bundle is the log

  /// The whole point: concatenated gzip members decompress as one stream, so a
  /// bundle of copied-in archives and a compressed-in active file comes back
  /// out as the log.
  func testTheBundleGunzipsToTheWholeLogInOrder() throws {
    let handle = try makeHandle(policy: policy(bytes: 64, compress: true))
    writeRotating(handle, count: 6)
    XCTAssertGreaterThan(archiveNames().count, 0, "the test needs something rotated")

    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)
    XCTAssertTrue(outcome.complete)
    XCTAssertFalse(outcome.truncated)
    XCTAssertEqual(outcome.path, bundleURL.path)
    XCTAssertGreaterThan(outcome.byteCount, 0)

    let restored = try gunzip(bundleURL)
    // Chronological, and every record exactly once. Selection runs newest
    // first and writing runs oldest first; getting that backwards would give a
    // support engineer the log in reverse blocks, which reads as corruption.
    XCTAssertEqual(
      restored,
      (0..<6).map { line($0) }.joined(),
      "the bundle is not the log in the order it happened"
    )
  }

  /// Plaintext archives — compression off — take the other branch: each is
  /// compressed on the way in rather than copied.
  func testAPlaintextArchiveIsCompressedIntoTheBundle() throws {
    let handle = try makeHandle(policy: policy(bytes: 64, compress: false))
    writeRotating(handle, count: 6)
    XCTAssertTrue(archiveNames().allSatisfy { !$0.hasSuffix(".gz") })

    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)
    XCTAssertTrue(outcome.complete)
    XCTAssertEqual(try gunzip(bundleURL), (0..<6).map { line($0) }.joined())
  }

  func testCollectingTwiceReplacesTheBundleRatherThanGrowingIt() throws {
    let handle = try makeHandle(policy: policy(bytes: 10_000_000))
    write(handle, "first\n")
    _ = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)

    write(handle, "second\n")
    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)

    XCTAssertTrue(outcome.complete)
    XCTAssertEqual(try gunzip(bundleURL), "first\nsecond\n")
    // One bundle, not two, and no staging file left over.
    XCTAssertEqual(
      names().filter { $0.hasPrefix("app.log.support") },
      [LogWriter.supportName("app.log")]
    )
  }

  /// Real gzip for rotation, a refusal for the scratch file a collect
  /// compresses a plaintext source into.
  ///
  /// `LogWriter` has one compressor and this test needs both: rotation's use of
  /// it has to work so there are archives to pack, and the collect's use of it
  /// has to fail so there is a member that does not go in.
  private func compressorRefusingMembers() -> LogWriter.Compressor {
    { source, destination in
      if destination.lastPathComponent.hasSuffix(".member") { return false }
      return Self.realGzip(source, destination)
    }
  }

  /// Real gzip, so an injected compressor produces a file the rest of the
  /// collect can actually read.
  ///
  /// A stub that returns `true` without writing anything looks like a working
  /// compressor and is not one: every member then fails to copy, the collect
  /// bails on "nothing was written", and a test aimed at some later step never
  /// reaches it.
  private static func realGzip(_ source: URL, _ destination: URL) -> Bool {
    guard FileManager.default.createFile(atPath: destination.path, contents: nil),
          let out = try? FileHandle(forWritingTo: destination) else { return false }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    process.arguments = ["gzip", "-c", source.path]
    process.standardOutput = out
    process.standardError = Pipe()
    do { try process.run() } catch { return false }
    process.waitUntilExit()
    try? out.close()
    return process.terminationStatus == 0
  }

  /// A member that cannot be written must leave the bundle a bundle.
  ///
  /// This is the failure that has to not corrupt anything: the sources are
  /// written one after another into one stream, so a member abandoned halfway
  /// would sit in front of the next one and the result would not be gzip at
  /// all. What comes back has to still gunzip, and the records that did go in
  /// have to still be in order.
  func testAMemberThatFailsLeavesTheRestReadable() throws {
    let handle = try makeHandle(
      policy: policy(bytes: 64, compress: true),
      compressor: compressorRefusingMembers())
    // An ODD count, so the active file still holds a record when the collect
    // starts. Rotation empties it on every even one, and an empty active file
    // is not a source — there would be no plaintext member to fail.
    writeRotating(handle, count: 7)
    XCTAssertGreaterThan(archiveNames().count, 1, "the test needs archives to keep")

    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)

    // The active file is the plaintext one, so it is the member that failed.
    XCTAssertTrue(outcome.truncated, "a dropped member is a truncated bundle")
    XCTAssertTrue(outcome.complete, "the rest of the bundle was still written")
    XCTAssertGreaterThan(outcome.sourceFileCount, 0)

    let restored = try gunzip(bundleURL)
    XCTAssertFalse(restored.isEmpty, "gzip read the bundle but it held nothing")
    // In order, and with no fragment of the member that failed. The archived
    // records are the oldest ones.
    XCTAssertEqual(
      restored,
      (0..<Int(outcome.sourceFileCount) * 2).map { line($0) }.joined(),
      "the bundle is not the records that went in, in order")
  }

  // MARK: - The ceiling

  func testTheCeilingLeavesTheOLDESTOut() throws {
    let handle = try makeHandle(policy: policy(bytes: 64))
    writeRotating(handle, count: 6)
    // Files with something in them, newest first — an empty active file is not
    // a source, so it is not what a ceiling has to make room for either.
    let sizes = handle.logFilePaths().map { path -> UInt64 in
      let attributes = try? FileManager.default.attributesOfItem(atPath: path)
      return (attributes?[.size] as? UInt64) ?? 0
    }.filter { $0 > 0 }
    XCTAssertGreaterThan(sizes.count, 2, "the ceiling has to cut something")

    // Room for the two newest, no more.
    let cap = Double(sizes[0] + sizes[1])

    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: cap)
    XCTAssertTrue(outcome.complete, "a ceiling that cuts the log is still a finished collect")
    XCTAssertTrue(outcome.truncated)
    XCTAssertEqual(outcome.sourceFileCount, 2)

    // And what survived is the NEWEST end. A bundle that kept the oldest
    // records would be the half nobody is asking about.
    let restored = try gunzip(bundleURL)
    XCTAssertTrue(restored.contains(line(5)), "the newest record is missing")
    XCTAssertFalse(restored.contains(line(0)), "the oldest record should have been cut")
  }

  func testACeilingOfZeroProducesNoBundle() throws {
    let handle = try makeHandle(policy: policy(bytes: 10_000_000))
    write(handle, "secret\n")

    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 0)

    XCTAssertEqual(outcome.path, "")
    XCTAssertEqual(outcome.sourceFileCount, 0)
    XCTAssertTrue(outcome.truncated, "everything was left out")
    XCTAssertTrue(outcome.complete, "and it finished doing that")
    XCTAssertFalse(FileManager.default.fileExists(atPath: bundleURL.path))
  }

  /// The direction a broken number has to fail in. `NaN` reaching here means
  /// some arithmetic upstream went wrong, and reading that as "no ceiling"
  /// would send the whole log.
  func testANonNumericCeilingSendsNothing() throws {
    let handle = try makeHandle(policy: policy(bytes: 10_000_000))
    write(handle, "secret\n")

    // `.infinity` belongs here more than any of the others: it is what a
    // division by zero produces, and it is the one value a `!isNaN` check
    // would wave through as "no ceiling".
    for ceiling in [Double.nan, Double(-1), -Double.infinity, Double.infinity] {
      let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: ceiling)
      XCTAssertEqual(outcome.path, "", "\(ceiling) produced a bundle")
      XCTAssertFalse(FileManager.default.fileExists(atPath: bundleURL.path))
    }
  }

  /// A ceiling of zero on a sink that has written nothing must still produce
  /// no bundle. An empty active file measures zero bytes and would otherwise
  /// slip under any ceiling, including one that means "send nothing".
  func testACeilingOfZeroOnAnEmptyLogProducesNoBundle() throws {
    let handle = try makeHandle(policy: policy(bytes: 10_000_000))

    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 0)

    XCTAssertEqual(outcome.path, "")
    XCTAssertTrue(outcome.complete)
    XCTAssertFalse(outcome.truncated, "nothing was left out of a log with nothing in it")
    XCTAssertFalse(FileManager.default.fileExists(atPath: bundleURL.path))
  }

  /// The active file is plaintext whatever it is called. A writer that decided
  /// otherwise from the extension would copy raw JSON Lines into the bundle
  /// and hand back a `.gz` that no tool can open.
  func testAnActiveFileNamedGzIsStillCompressedIn() throws {
    let url = logsDirectory.appendingPathComponent("app.gz")
    let handle = try makeHandle(at: url, policy: policy(bytes: 10_000_000))
    _ = handle.appendBatch("plain text\n", entryCount: 1)
    handle.writerForTesting.settleForTesting()

    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)
    XCTAssertTrue(outcome.complete)

    let bundle = logsDirectory.appendingPathComponent(LogWriter.supportName("app.gz"))
    XCTAssertEqual(outcome.path, bundle.path)
    XCTAssertEqual(try gunzip(bundle), "plain text\n")
  }

  // MARK: - Where the bundle sits in the naming scheme

  func testTheBundleIsNeitherAnArchiveNorALogFilePath() throws {
    let handle = try makeHandle(policy: policy(bytes: 64))
    writeRotating(handle, count: 6)
    _ = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)

    let bundle = LogWriter.supportName("app.log")
    XCTAssertTrue(FileManager.default.fileExists(atPath: bundleURL.path))

    // Not an archive: retention must not count it toward a cap or prune it in
    // place of a real one.
    XCTAssertFalse(LogWriter.isArchiveName(bundle, baseName: "app.log"))
    // Not a log file: a collector handed this path would be uploading a bundle
    // of the logs as if it were one of them.
    XCTAssertFalse(handle.logFilePaths().contains(bundleURL.path))
    // But an artifact, which is what makes the purge below correct.
    XCTAssertTrue(LogWriter.isArtifactName(bundle, baseName: "app.log"))
  }

  /// A compliance purge that left a gzipped copy of the whole log next to the
  /// files it deleted would not be a purge.
  func testAPurgeDeletesTheBundle() throws {
    let handle = try makeHandle(policy: policy(bytes: 64))
    writeRotating(handle, count: 6)
    _ = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)
    XCTAssertTrue(FileManager.default.fileExists(atPath: bundleURL.path))

    let outcome = handle.clearLogs(deadlineMs: 5000)

    XCTAssertTrue(outcome.durable)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: bundleURL.path),
      "the purge reported durable with a copy of the log still on disk"
    )
  }

  /// A collect that died mid-write leaves two kinds of leftover, and both hold
  /// log bytes: the half-written bundle, and the scratch file a plaintext
  /// source was being compressed into. Neither will ever be finished.
  func testAnAbandonedStagingBundleIsSweptAway() throws {
    try FileManager.default.createDirectory(
      at: logsDirectory, withIntermediateDirectories: true)
    let orphans = [
      LogWriter.supportStagingName("app.log"),
      LogWriter.supportMemberName("app.log"),
    ].map { logsDirectory.appendingPathComponent($0) }
    for orphan in orphans {
      try Data("truncated".utf8).write(to: orphan)
      // An artifact, so a purge would take it too. A leftover the purge did
      // not know about would survive a compliance deletion holding a
      // compressed copy of the log.
      XCTAssertTrue(
        LogWriter.isArtifactName(orphan.lastPathComponent, baseName: "app.log"),
        "\(orphan.lastPathComponent) is not an artifact")
    }

    // The sweep runs at open.
    let handle = try makeHandle(policy: policy())

    for orphan in orphans {
      XCTAssertFalse(
        FileManager.default.fileExists(atPath: orphan.path),
        "\(orphan.lastPathComponent) survived the sweep")
      XCTAssertFalse(handle.logFilePaths().contains(orphan.path))
    }
  }

  /// The finished bundle is NOT swept. It is something the caller asked for
  /// and may not have uploaded yet; deleting it on the next rotation would
  /// make `collectLogs` a race.
  func testAFinishedBundleSurvivesTheRetentionSweep() throws {
    let handle = try makeHandle(policy: policy(bytes: 64, keep: 1))
    write(handle, record)
    _ = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)
    XCTAssertTrue(FileManager.default.fileExists(atPath: bundleURL.path))

    // Enough rotations to run the sweep several times and to blow past the
    // one-archive cap.
    for _ in 0..<6 { write(handle, record) }
    XCTAssertEqual(archiveNames().filter { $0 != LogWriter.supportName("app.log") }.count, 1)

    XCTAssertTrue(FileManager.default.fileExists(atPath: bundleURL.path))
  }

  // MARK: - The deadline

  /**
   A collect the caller stopped waiting for must not publish afterwards.

   The build cannot be cancelled mid-copy — nothing cancels a queued block —
   so the only thing that can be stopped is the rename. Without that barrier
   this call reports "no bundle" and a complete copy of the whole log lands
   beside the log seconds later: outside the retention budget the app
   configured, invisible to `getLogFilePaths()`, and deliberately skipped by
   the orphan sweep because a FINISHED bundle is one somebody may be about to
   upload.
   */
  func testACollectThatOverranPublishesNothing() throws {
    // Real gzip behind the sleep, so the build that overruns is a build that
    // would otherwise have succeeded — which is the only version of it that
    // could publish anything.
    let slow: LogWriter.Compressor = { source, destination in
      Thread.sleep(forTimeInterval: 0.5)
      return Self.realGzip(source, destination)
    }
    let handle = try makeHandle(policy: policy(bytes: 10_000_000), compressor: slow)
    write(handle, "precious\n")

    let outcome = handle.collectLogs(deadlineMs: 50, maxTotalBytes: 10_000_000)
    XCTAssertFalse(outcome.complete, "the wait was 50ms and the build takes 500")
    XCTAssertEqual(outcome.path, "")

    // Let the build run to the end it would have reached anyway.
    handle.writerForTesting.settleForTesting()

    XCTAssertFalse(
      FileManager.default.fileExists(atPath: bundleURL.path),
      "a bundle appeared for a collect that reported none")
    XCTAssertEqual(
      names().filter { $0.hasPrefix("app.log.support") }, [],
      "the abandoned build left its temporaries behind")
  }

  /// Two collects that both overran, and neither publishes.
  ///
  /// The interesting order is the second one: the first build is still copying
  /// when the second collect gives up, so if "abandoned" were one flag on the
  /// writer rather than one per collect, the second timeout would overwrite the
  /// first — and the first build, arriving at its barrier last, would find
  /// itself un-abandoned and publish a bundle for a call that reported none.
  func testTwoOverrunCollectsPublishNothing() throws {
    let slow: LogWriter.Compressor = { source, destination in
      Thread.sleep(forTimeInterval: 0.5)
      return Self.realGzip(source, destination)
    }
    let handle = try makeHandle(policy: policy(bytes: 10_000_000), compressor: slow)
    write(handle, "precious\n")

    // Both enqueue onto the one queue and both give up while the first is
    // still inside its compressor.
    let first = handle.collectLogs(deadlineMs: 50, maxTotalBytes: 10_000_000)
    let second = handle.collectLogs(deadlineMs: 50, maxTotalBytes: 10_000_000)
    XCTAssertFalse(first.complete)
    XCTAssertFalse(second.complete)

    handle.writerForTesting.settleForTesting()

    XCTAssertFalse(
      FileManager.default.fileExists(atPath: bundleURL.path),
      "an abandoned build published anyway")
    XCTAssertEqual(names().filter { $0.hasPrefix("app.log.support") }, [])
  }

  /// One collect giving up must not poison the next one.
  ///
  /// The other half of keeping abandonment per collect. A flag on the writer
  /// would be sticky: once anything had timed out, every later collect would
  /// find itself abandoned at the barrier and this destination would never
  /// produce a bundle again.
  func testACollectAfterAnOverrunOneStillPublishes() throws {
    let slowUntilTold = SlowCompressor()
    let handle = try makeHandle(
      policy: policy(bytes: 10_000_000), compressor: slowUntilTold.compress)
    write(handle, "precious\n")

    XCTAssertFalse(handle.collectLogs(deadlineMs: 50, maxTotalBytes: 10_000_000).complete)
    handle.writerForTesting.settleForTesting()
    XCTAssertFalse(FileManager.default.fileExists(atPath: bundleURL.path))

    slowUntilTold.slow = false
    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)

    XCTAssertTrue(outcome.complete, "a timed-out collect disabled every one after it")
    XCTAssertEqual(try gunzip(bundleURL), "precious\n")
  }

  /// A compressor that can be made fast again, so one test can have both a
  /// collect that overruns and a collect that finishes.
  private final class SlowCompressor: @unchecked Sendable {
    var slow = true
    func compress(_ source: URL, _ destination: URL) -> Bool {
      if slow { Thread.sleep(forTimeInterval: 0.5) }
      return LogCollectTests.realGzip(source, destination)
    }
  }

  // MARK: - Lifecycle

  func testAReleasedHandleCollectsNothing() throws {
    let keeper = try makeHandle(policy: policy(bytes: 10_000_000))
    let released = try makeHandle(policy: policy(bytes: 10_000_000))
    write(keeper, "precious\n")

    _ = released.close(deadlineMs: 1000)
    let outcome = released.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)

    XCTAssertEqual(outcome.path, "")
    XCTAssertFalse(outcome.complete)
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: bundleURL.path),
      "a released handle wrote into a directory a live handle owns"
    )

    // And the live one still can.
    XCTAssertTrue(keeper.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000).complete)
  }

  /// Records still in the queue when a collect starts have to be in it. A
  /// bundle missing the last few seconds is missing the part somebody is
  /// asking about.
  func testTheBundleIncludesRecordsThatWereStillBuffered() throws {
    let handle = try makeHandle(policy: policy(bytes: 10_000_000))
    // Not `write`, which settles the queue: this one has to still be in flight.
    _ = handle.appendBatch("in flight\n", entryCount: 1)

    let outcome = handle.collectLogs(deadlineMs: 5000, maxTotalBytes: 10_000_000)

    XCTAssertTrue(outcome.complete)
    XCTAssertEqual(try gunzip(bundleURL), "in flight\n")
  }
}
