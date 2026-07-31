import Foundation
import XCTest
@testable import NitroLoggerFileWriter

final class LogRotationTests: LogWriterTestCase {

  private func sizePolicy(
    bytes: Double = 64,
    keep: Double = 5,
    compress: Bool = false,
    archiveAge: Double? = nil,
    totalBytes: Double? = nil
  ) -> LogRotationPolicy {
    LogRotationPolicy(
      maxFileSizeBytes: bytes,
      maxArchivedFilesCount: keep,
      compressArchives: compress,
      maxArchiveAgeSeconds: archiveAge,
      maxTotalLogBytes: totalBytes
    )
  }

  private let record = String(repeating: "x", count: 39) + "\n" // 40 bytes

  // MARK: - Triggers

  func testRotatesOnSize() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64))
    write(handle, record)
    XCTAssertEqual(archiveNames().count, 0, "one record is under the threshold")

    write(handle, record)
    XCTAssertEqual(archiveNames().count, 1, "crossing 64 bytes rotates")
    XCTAssertEqual(contents(), "", "the fresh file starts empty")
  }

  func testRotatesOnAge() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 10_000_000,
      maxArchivedFilesCount: 5,
      maxFileAgeSeconds: 0.05
    )
    let clock = WallClock()
    let handle = try makeHandle(policy: policy, clock: { clock.now })
    write(handle, "young\n")
    XCTAssertEqual(archiveNames().count, 0)

    clock.advance(5)
    write(handle, "old enough\n")
    XCTAssertEqual(archiveNames().count, 1, "age rotates a file that never reached the size cap")
  }

  /// The file a rotation opens is new, and its age restarts — measured on the
  /// clock the writer is actually using.
  ///
  /// The bug this pins is a mixed timebase, and it is invisible in
  /// `testRotatesOnAge` because that test stops after the first rotation.
  /// Rotation renames the old file away and opens a fresh one; if the fresh
  /// file's age comes from the *filesystem* while the check compares against an
  /// injected clock standing five seconds ahead, the new file is born five
  /// seconds old. It is over the threshold before a byte reaches it, so the
  /// next write rotates, and the one after that, until pruning has eaten every
  /// archive holding real records.
  ///
  /// So the assertion is about what does *not* happen: no advance after the
  /// first rotation, ten more writes, and still exactly one archive.
  func testAFileOpenedByARotationIsNotBornExpired() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 10_000_000,
      maxArchivedFilesCount: 50,
      maxFileAgeSeconds: 0.05
    )
    let clock = WallClock()
    let handle = try makeHandle(policy: policy, clock: { clock.now })
    write(handle, "young\n")

    clock.advance(5)
    write(handle, "old enough\n")
    XCTAssertEqual(archiveNames().count, 1)

    // The clock does not move again, so nothing here is old enough to rotate.
    for index in 0..<10 { write(handle, "after \(index)\n") }

    XCTAssertEqual(
      archiveNames().count, 1,
      "the file the rotation opened restarted its age; only the first rotation happened"
    )
    XCTAssertEqual(
      contents(),
      (0..<10).map { "after \($0)\n" }.joined(),
      "every later record is still in the live file, not scattered across archives"
    )
  }

  /// Rotation must only ever produce names the purge recognises. A file the
  /// sweep cannot see is a file a compliance purge leaves behind.
  func testEveryArchiveNameIsRecognisedByThePurgePredicate() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, compress: true))
    for _ in 0..<6 { write(handle, record) }

    let archives = archiveNames()
    XCTAssertFalse(archives.isEmpty)
    for name in archives {
      XCTAssertTrue(
        LogWriter.isArtifactName(name, baseName: "app.log"),
        "\(name) would survive a purge"
      )
      XCTAssertTrue(
        LogWriter.isArchiveName(name, baseName: "app.log"),
        "\(name) should also be prunable"
      )
    }
  }

  // MARK: - Maintenance without a write

  /// The whole reason `maintain` exists. Rotation runs from `performWrite` and
  /// nowhere else, so a sink nobody is logging to never age-rotates however
  /// long it sits there.
  func testMaintainAgeRotatesAFileNothingIsWritingTo() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 10_000_000,
      maxArchivedFilesCount: 5,
      maxFileAgeSeconds: 0.05
    )
    let clock = WallClock()
    let handle = try makeHandle(policy: policy, clock: { clock.now })
    write(handle, "young\n")

    clock.advance(5)

    // The control, and the point: the file is old enough to rotate and stays
    // put, because nothing has written to it. Without this assertion the one
    // below would pass against a writer that rotated on its own.
    XCTAssertEqual(archiveNames().count, 0, "an unwritten file does not rotate itself")

    _ = handle.maintain(deadlineMs: 1000)

    XCTAssertEqual(archiveNames().count, 1, "the sweep rotates it with no record to carry")
    XCTAssertEqual(contents(), "", "the fresh file starts empty")
  }

  /// The other half: an archive that expired while the app sat idle.
  func testMaintainPrunesAnExpiredArchiveWithNoWrites() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, keep: 100, archiveAge: 0.1))
    write(handle, record)
    write(handle, record) // rotation
    XCTAssertEqual(archiveNames().count, 1)

    try backdateArchives(by: 5)
    XCTAssertEqual(archiveNames().count, 1, "retention does not sweep itself either")

    _ = handle.maintain(deadlineMs: 1000)

    XCTAssertEqual(archiveNames().count, 0, "the expired archive goes without a record arriving")
  }

  /// A flush is not a sweep. Both take a deadline and both go on the writer's
  /// queue, which is exactly why someone would reach for the wrong one.
  func testFlushDoesNotStandInForMaintain() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 10_000_000,
      maxArchivedFilesCount: 5,
      maxFileAgeSeconds: 0.05
    )
    let clock = WallClock()
    let handle = try makeHandle(policy: policy, clock: { clock.now })
    write(handle, "young\n")

    clock.advance(5)
    XCTAssertTrue(handle.flush(deadlineMs: 1000).durable)

    XCTAssertEqual(archiveNames().count, 0, "flush drains the queue and moves no files")
  }

  /// The status has to describe what this call found, not what the last append
  /// left behind — a destination nobody writes to has no next append.
  func testMaintainReportsWhatTheSweepItselfBroke() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 10_000_000,
      maxArchivedFilesCount: 5,
      maxFileAgeSeconds: 0.05,
      compressArchives: true
    )
    let clock = WallClock()
    let handle = try makeHandle(
      policy: policy, compressor: { _, _ in false }, clock: { clock.now })
    write(handle, "young\n")
    XCTAssertEqual(handle.status().degraded & LogDegradation.gzip.rawValue, 0)

    clock.advance(5)
    let status = handle.maintain(deadlineMs: 1000)

    XCTAssertNotEqual(
      status.degraded & LogDegradation.gzip.rawValue, 0,
      "the compression this sweep failed is in the status this sweep returned"
    )
  }

  /// Same rule as every other entry point: a released handle must not move
  /// files a live handle owns.
  func testAReleasedHandleMaintainsNothing() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 10_000_000,
      maxArchivedFilesCount: 5,
      maxFileAgeSeconds: 0.05
    )
    let clock = WallClock()
    // Only the first call builds the writer, so only the first clock is the one
    // in force — the second handle shares it, as it shares everything else.
    let keeper = try makeHandle(policy: policy, clock: { clock.now })
    let released = try makeHandle(policy: policy)
    write(keeper, "young\n")

    _ = released.close(deadlineMs: 1000)
    clock.advance(5)

    let status = released.maintain(deadlineMs: 1000)
    XCTAssertEqual(status.degraded, 0)
    XCTAssertEqual(archiveNames().count, 0, "the writer the keeper holds is untouched")

    // And the live handle can still do it.
    _ = keeper.maintain(deadlineMs: 1000)
    XCTAssertEqual(archiveNames().count, 1)
  }

  /// A terminated writer no longer owns the path, and the retention sweep is
  /// the half of maintenance that needs no stream to do damage: it works off a
  /// directory listing, so it would happily delete archives under whichever
  /// writer holds the path now, using a policy that writer never agreed to.
  func testMaintainAfterTerminationSweepsNothing() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, keep: 100, archiveAge: 0.1))
    let writer = handle.writerForTesting
    write(handle, record)
    write(handle, record) // rotation
    XCTAssertEqual(archiveNames().count, 1)

    try backdateArchives(by: 5)
    _ = handle.close(deadlineMs: 1000)

    // Straight at the writer: the handle refuses on its own, and the guard
    // under test is the one beneath it.
    _ = writer.maintain(handleID: 0, deadlineMs: 1000)

    XCTAssertEqual(
      archiveNames().count, 1,
      "an archive this writer no longer owns is not its to expire"
    )
    XCTAssertTrue(FileManager.default.fileExists(atPath: logURL.path))
  }

  // MARK: - Retention

  func testPrunesByCount() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, keep: 2))
    for _ in 0..<10 { write(handle, record) }
    XCTAssertEqual(archiveNames().count, 2)
  }

  func testKeepingZeroArchivesDeletesEveryRotation() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, keep: 0))
    for _ in 0..<6 { write(handle, record) }
    XCTAssertEqual(archiveNames().count, 0)
    XCTAssertTrue(FileManager.default.fileExists(atPath: logURL.path))
  }

  func testPrunesByArchiveAge() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, keep: 100, archiveAge: 0.1))
    write(handle, record)
    write(handle, record) // rotation 1
    XCTAssertEqual(archiveNames().count, 1)

    // The first archive ages; the one rotation 2 is about to create does not.
    try backdateArchives(by: 5)
    write(handle, record)
    write(handle, record) // rotation 2 sweeps the now-expired first archive

    XCTAssertEqual(archiveNames().count, 1, "the expired archive goes even though the count cap allows it")
  }

  func testPrunesByTotalBytes() throws {
    // 40-byte records, rotating every 64 bytes, so each archive is ~80 bytes.
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, keep: 100, totalBytes: 200))
    for _ in 0..<12 { write(handle, record) }

    let total = archiveNames().reduce(UInt64(0)) { sum, name in
      let url = logsDirectory.appendingPathComponent(name)
      let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? UInt64) ?? 0
      return sum + (size ?? 0)
    }
    XCTAssertLessThanOrEqual(total, 200)
    XCTAssertGreaterThan(archiveNames().count, 0, "the cap sheds the oldest, it does not empty the directory")
  }

  /// The name's timestamp has one-second resolution, so a burst of rotations
  /// inside the same second shares it and only the random suffix differs.
  /// Sorting by name would keep an arbitrary subset and delete newer archives
  /// than it kept.
  func testArchivesAreOrderedByModificationDateNotByName() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)

    let older = logsDirectory.appendingPathComponent("app.log.20260101T000000Z_00000000")
    let newer = logsDirectory.appendingPathComponent("app.log.20260101T000000Z_ffffffff")
    try Data("a".utf8).write(to: older)
    try Data("b".utf8).write(to: newer)

    // Names sort ffffffff after 00000000; modification dates say the opposite.
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 2_000_000)], ofItemAtPath: older.path)
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSince1970: 1_000_000)], ofItemAtPath: newer.path)

    let archives = LogWriter.archives(in: logsDirectory, baseName: "app.log")
    XCTAssertEqual(archives.map(\.url.lastPathComponent),
                   ["app.log.20260101T000000Z_00000000", "app.log.20260101T000000Z_ffffffff"],
                   "newest first, by modification date")
  }

  // MARK: - Compression

  func testCompressedArchiveIsAValidGzipOfTheOriginal() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, compress: true))
    let first = "alpha " + String(repeating: "a", count: 33) + "\n"
    let second = "beta " + String(repeating: "b", count: 34) + "\n"
    write(handle, first)
    write(handle, second)

    let archives = archiveNames()
    XCTAssertEqual(archives.count, 1)
    let archive = try XCTUnwrap(archives.first)
    XCTAssertTrue(archive.hasSuffix(".gz"))

    let gz = try Data(contentsOf: logsDirectory.appendingPathComponent(archive))
    let restored = try XCTUnwrap(GzipCheck.inflate(gz), "the archive must be a readable gzip stream")
    XCTAssertEqual(String(decoding: restored, as: UTF8.self), first + second)
  }

  /// A bigger archive beats a lost one.
  func testGzipFailureKeepsThePlaintextArchiveAndReportsDegradation() throws {
    let handle = try makeHandle(
      policy: sizePolicy(bytes: 64, compress: true),
      compressor: { _, _ in false }
    )
    write(handle, record)
    write(handle, record)

    let archives = archiveNames()
    XCTAssertEqual(archives.count, 1)
    XCTAssertFalse(try XCTUnwrap(archives.first).hasSuffix(".gz"), "the original survives")
    XCTAssertNotEqual(handle.status().degraded & LogDegradation.gzip.rawValue, 0)
  }

  func testLoggingContinuesThroughSustainedGzipFailure() throws {
    let handle = try makeHandle(
      policy: sizePolicy(bytes: 64, keep: 100, compress: true),
      compressor: { _, _ in false }
    )
    for _ in 0..<10 { write(handle, record) }

    XCTAssertGreaterThanOrEqual(archiveNames().count, 4)
    XCTAssertTrue(handle.flush(deadlineMs: 1000).durable)
    XCTAssertEqual(handle.status().lostEntries, 0, "a failed compression is not a lost record")
  }

  /// A staging file is a compression nothing will ever finish. It must not
  /// occupy a retention slot, must not be handed to anyone collecting logs, and
  /// must not outlive the next sweep.
  func testOrphanStagingFileIsNotAnArchiveAndIsSweptAway() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    let orphan = logsDirectory.appendingPathComponent("app.log.20260101T000000Z_deadbeef.gz.part")
    try Data("truncated".utf8).write(to: orphan)

    XCTAssertFalse(LogWriter.isArchiveName(orphan.lastPathComponent, baseName: "app.log"))
    XCTAssertTrue(LogWriter.isArtifactName(orphan.lastPathComponent, baseName: "app.log"))

    // The sweep is submitted at open and runs on the writer's queue, so the
    // assertions below have to cross a settle barrier rather than assuming it
    // finished before `acquire` returned. It deliberately does not — see
    // `LogWriter.init`.
    let handle = try makeHandle(policy: sizePolicy())
    handle.writerForTesting.settleForTesting()
    XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path))
    XCTAssertFalse(handle.logFilePaths().contains(orphan.path))
  }

  // MARK: - Degradation

  /// A rotation that fails on every write would otherwise retry on every
  /// batch, turning a degraded log into a busy one.
  func testFailedRotationBacksOffAndLoggingContinues() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64))
    write(handle, record)

    // An immutable directory blocks the archive move — an entry cannot be
    // removed from it — while appends to the already-open file still work.
    // `chmod` would not do: the writer re-asserts the directory's mode on
    // reopen, and as owner it would simply undo the fault.
    TestFlags.makeImmutable(logsDirectory)
    defer { chflags(logsDirectory.path, 0) }

    for _ in 0..<20 { write(handle, record) }

    XCTAssertNotEqual(handle.status().degraded & LogDegradation.rotation.rawValue, 0)
    XCTAssertEqual(handle.writerForTesting.rotationAttemptsForTesting, 1,
                   "the backoff window should have absorbed the other 19")
    XCTAssertEqual(archiveNames().count, 0, "and the fault really was still in force")
    XCTAssertEqual(handle.status().lostEntries, 0, "records still land in the un-rotated file")
    XCTAssertTrue(contents().count > 64, "and the file keeps growing")
  }

  /// The backoff window above is measured on the monotonic clock, and this is
  /// the test that says so.
  ///
  /// Its sibling proves the window exists; nothing proved *which clock* bounds
  /// it. Replacing the monotonic source with `Date()` left every Swift test
  /// green — Android had both the injection and a clock test, iOS had neither,
  /// and that asymmetry is what this closes. A backoff asks "has enough time
  /// passed since the last failure", and an NTP correction stepping the wall
  /// clock back an hour must never re-answer it: rotation would wedge for the
  /// hour, on a file that is already oversized and failing to rotate.
  ///
  /// What it does not prove: the wall clock is not injectable on this platform,
  /// so this pins that the backoff *follows the seam* rather than demonstrating
  /// a real backwards NTP step. File age still reads `Date` deliberately — it
  /// is measured against a creation time from a previous run — and no
  /// assertion here covers that path.
  func testTheRotationBackoffIsMeasuredOnTheInjectedMonotonicClock() throws {
    let clock = SteadyClock()
    let handle = try makeHandle(policy: sizePolicy(bytes: 64), steady: { clock.now })
    write(handle, record)

    TestFlags.makeImmutable(logsDirectory)
    defer { chflags(logsDirectory.path, 0) }

    for _ in 0..<10 { write(handle, record) }
    let attempts = handle.writerForTesting.rotationAttemptsForTesting
    XCTAssertEqual(attempts, 1, "the first failure opened the backoff window")

    // Real time passes while these run. The window is not measured in it, so
    // it does not move.
    for _ in 0..<10 { write(handle, record) }
    XCTAssertEqual(handle.writerForTesting.rotationAttemptsForTesting, 1,
                   "a clock that has not moved leaves the window shut")

    // Past the window on the only clock that counts. Nothing else changed: the
    // fault is still in force and the file is still over its threshold.
    clock.advance(5_001)
    write(handle, record)

    XCTAssertEqual(handle.writerForTesting.rotationAttemptsForTesting, 2,
                   "past the window, rotation is tried again")
    XCTAssertEqual(archiveNames().count, 0, "and the fault really was still in force")
  }

  func testFailedPruneReportsDegradation() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, keep: 1))
    write(handle, record)
    write(handle, record) // rotation 1

    let stubborn = try XCTUnwrap(archiveNames().first)
    TestFlags.makeImmutable(logsDirectory.appendingPathComponent(stubborn))

    write(handle, record)
    write(handle, record) // rotation 2 tries to prune the immutable archive

    XCTAssertNotEqual(handle.status().degraded & LogDegradation.prune.rawValue, 0)
    XCTAssertEqual(handle.status().lostEntries, 0, "a prune failure is not a lost record")
  }

  func testDegradationFlagsAreIndependent() {
    var flags = LogDegradation()
    flags.insert(.gzip)
    flags.insert(.prune)
    XCTAssertTrue(flags.contains(.gzip))
    XCTAssertTrue(flags.contains(.prune))
    XCTAssertFalse(flags.contains(.rotation))
    XCTAssertFalse(flags.contains(.protection))
    XCTAssertFalse(flags.contains(.sidecar))
  }

  // MARK: - Listing

  func testLogFilePathsListsTheActiveFileAndArchivesNewestFirst() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, keep: 100))
    for _ in 0..<6 { write(handle, record) }

    let paths = handle.logFilePaths()
    XCTAssertEqual(paths.first, logURL.path)
    XCTAssertEqual(paths.count, 1 + archiveNames().count)
    for path in paths.dropFirst() {
      XCTAssertTrue(FileManager.default.fileExists(atPath: path))
    }
  }

  /// The same list with the writer gone — what a sink that has been closed
  /// answers. Closing releases a handle; it does not delete files, and a
  /// support collector needs their names either way.
  func testArtifactPathsListsTheSameFilesWithNoLiveWriter() throws {
    let handle = try makeHandle(policy: sizePolicy(bytes: 64, keep: 100))
    for _ in 0..<6 { write(handle, record) }
    let live = handle.logFilePaths()
    _ = handle.close(deadlineMs: 1000)

    let dead = LogWriter.artifactPaths(at: logURL)

    XCTAssertEqual(Set(dead), Set(live),
                   "the files did not move when the writer went away")
    XCTAssertGreaterThan(dead.count, 1, "no archives rotated, so this compared almost nothing")
  }

  /// The one case that answers with nothing: a path where no file was ever
  /// written. The active name is included only when it is really there, so a
  /// collector is never sent to open a file that does not exist.
  func testArtifactPathsAtAnUntouchedPathIsEmpty() {
    XCTAssertEqual(
      LogWriter.artifactPaths(at: logsDirectory.appendingPathComponent("never-opened.log")), [])
  }
}

// MARK: - Gzip verification

/// Decodes a gzip container far enough to prove the writer produced one that a
/// standard tool could read: magic, DEFLATE payload, and a trailer whose CRC
/// and length actually match the bytes inside.
enum GzipCheck {
  static func inflate(_ gzip: Data) -> Data? {
    let bytes = [UInt8](gzip)
    guard bytes.count > 18, bytes[0] == 0x1f, bytes[1] == 0x8b, bytes[2] == 0x08 else { return nil }

    let payload = Data(bytes[10..<(bytes.count - 8)])
    let trailer = Array(bytes.suffix(8))
    let expectedCRC = UInt32(trailer[0]) | UInt32(trailer[1]) << 8
      | UInt32(trailer[2]) << 16 | UInt32(trailer[3]) << 24
    let expectedSize = UInt32(trailer[4]) | UInt32(trailer[5]) << 8
      | UInt32(trailer[6]) << 16 | UInt32(trailer[7]) << 24

    guard let restored = rawInflate(payload, hint: Int(expectedSize)) else { return nil }
    guard restored.count == Int(expectedSize) else { return nil }
    guard Gzip.crc32(restored) == expectedCRC else { return nil }
    return restored
  }

  private static func rawInflate(_ deflated: Data, hint: Int) -> Data? {
    #if canImport(Compression)
    let capacity = max(hint * 2, 64 * 1024)
    let destination = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
    defer { destination.deallocate() }

    let written = deflated.withUnsafeBytes { raw -> Int in
      guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
      return compression_decode_buffer(
        destination, capacity, base, deflated.count, nil, COMPRESSION_ZLIB
      )
    }
    guard written > 0 else { return nil }
    return Data(bytes: destination, count: written)
    #else
    return nil
    #endif
  }
}

#if canImport(Compression)
import Compression
#endif
