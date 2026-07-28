import Foundation
import XCTest
@testable import NitroLoggerFileWriter

final class LogFileWriterTests: LogWriterTestCase {

  // MARK: - Appending

  func testAppendedBytesReachTheFile() throws {
    let handle = try makeHandle()
    write(handle, "first\n")
    write(handle, "second\n")
    XCTAssertTrue(handle.flush(deadlineMs: 1000).durable)
    XCTAssertEqual(contents(), "first\nsecond\n")
  }

  func testEmptyBatchIsAcceptedAndWritesNothing() throws {
    let handle = try makeHandle()
    let result = write(handle, "", entries: 0)
    XCTAssertTrue(result.accepted)
    XCTAssertEqual(contents(), "")
  }

  /// An entry count that disagrees with the payload makes every loss number
  /// downstream a guess, so it is refused before anything is reserved.
  func testEntryCountMustAgreeWithThePayload() throws {
    let handle = try makeHandle()

    let noEntries = handle.appendBatch("text\n", entryCount: 0)
    XCTAssertFalse(noEntries.accepted)
    XCTAssertEqual(noEntries.rejectReason, .failed)

    let noBytes = handle.appendBatch("", entryCount: 3)
    XCTAssertFalse(noBytes.accepted)
    XCTAssertEqual(noBytes.rejectReason, .failed)

    let negative = handle.appendBatch("text\n", entryCount: -1)
    XCTAssertFalse(negative.accepted)
    XCTAssertEqual(negative.rejectReason, .failed)

    let absurd = handle.appendBatch("text\n", entryCount: 5_000_000)
    XCTAssertFalse(absurd.accepted)
    XCTAssertEqual(absurd.rejectReason, .failed)

    handle.writerForTesting.settleForTesting()
    XCTAssertEqual(contents(), "", "a rejected batch must not reach the file")
  }

  // MARK: - Write integrity

  /// `write(2)` may write less than it was asked for. Treating that as success
  /// is how a record loses its second half.
  func testShortWritesStillDeliverEveryByte() throws {
    let faults = WriteFaults()
    faults.writeShort(3)
    let handle = try makeHandle(rawWrite: faults.raw)

    let record = "the quick brown fox jumps over the lazy dog\n"
    write(handle, record)

    XCTAssertEqual(contents(), record)
    XCTAssertGreaterThan(faults.callCount, 1, "the retry loop should have been exercised")
    XCTAssertEqual(handle.status().lostEntries, 0)
  }

  /// A batch that fails partway must leave the file on the boundary it started
  /// at. A half-written record makes everything after it unparseable, so the
  /// loss would spread from one batch to the whole tail of the file.
  func testTerminalFailureRollsBackToTheRecordBoundary() throws {
    let faults = WriteFaults()
    let handle = try makeHandle(rawWrite: faults.raw)

    write(handle, "good\n")
    XCTAssertEqual(contents(), "good\n")

    faults.failAfter(4) // let four bytes of the next batch land, then fail
    write(handle, "0123456789\n")

    XCTAssertEqual(contents(), "good\n", "the partial batch must be truncated away")
    XCTAssertEqual(handle.status().lostEntries, 1)
    XCTAssertEqual(handle.status().lostBytes, 11)

    faults.recover()
    write(handle, "after\n")
    XCTAssertEqual(contents(), "good\nafter\n", "the writer keeps working after a failed batch")
  }

  func testLossIsAttributedToTheHandleThatLostIt() throws {
    let faults = WriteFaults()
    let first = try makeHandle(rawWrite: faults.raw)
    let second = try makeHandle(rawWrite: faults.raw)
    XCTAssertTrue(first.writerForTesting === second.writerForTesting)

    faults.failAfter(0)
    write(first, "doomed\n")
    faults.recover()

    XCTAssertEqual(first.status().lostEntries, 1)
    XCTAssertEqual(second.status().lostEntries, 0, "one handle's loss is not another's")
  }

  // MARK: - The byte reservation

  /// The cap is on bytes in flight, not bytes enqueued: a burst must not be
  /// able to queue a gigabyte behind a slow disk just because each batch fits.
  func testAcceptedBytesStayReservedUntilTheWriteCompletes() throws {
    let handle = try makeHandle()
    let release = stall(handle)

    let chunk = String(repeating: "a", count: 256 * 1024)
    for index in 0..<4 {
      XCTAssertTrue(handle.appendBatch(chunk, entryCount: 1).accepted, "chunk \(index)")
    }
    XCTAssertEqual(handle.status().queuedBytes, LogWriter.hardCapBytes)

    let overflow = handle.appendBatch(chunk, entryCount: 1)
    XCTAssertFalse(overflow.accepted)
    XCTAssertEqual(overflow.rejectReason, .full)

    release()
    XCTAssertTrue(handle.flush(deadlineMs: 5000).durable)
    XCTAssertEqual(handle.status().queuedBytes, 0, "reservations are released on completion")
  }

  /// The JavaScript backpressure loop polls `getStatus()` precisely when the
  /// writer is stuck. If that call queued behind the writer it would block the
  /// runtime at the worst possible moment.
  func testStatusAnswersWhileTheWriterIsBlocked() throws {
    let handle = try makeHandle()
    let release = stall(handle)
    XCTAssertTrue(handle.appendBatch("queued\n", entryCount: 1).accepted)

    let started = Date()
    let status = handle.status()
    let elapsed = Date().timeIntervalSince(started)

    XCTAssertLessThan(elapsed, 0.5, "getStatus must not wait behind writer I/O")
    XCTAssertEqual(status.queuedBytes, 7)
    release()
  }

  // MARK: - Deadlines

  func testFlushTimesOutAgainstAHungWriter() throws {
    let handle = try makeHandle()
    let release = stall(handle)
    XCTAssertTrue(handle.appendBatch("queued\n", entryCount: 1).accepted)

    let started = Date()
    let outcome = handle.flush(deadlineMs: 100)
    let elapsed = Date().timeIntervalSince(started)

    XCTAssertTrue(outcome.timedOut)
    XCTAssertFalse(outcome.durable)
    XCTAssertEqual(outcome.pendingBytes, 7)
    XCTAssertLessThan(elapsed, 2.0, "the deadline is wall-clock, not best-effort")
    release()
  }

  func testCloseIsDeadlineBoundedToo() throws {
    let handle = try makeHandle()
    let release = stall(handle)
    XCTAssertTrue(handle.appendBatch("queued\n", entryCount: 1).accepted)

    let started = Date()
    let outcome = handle.close(deadlineMs: 100)
    XCTAssertLessThan(Date().timeIntervalSince(started), 2.0)
    XCTAssertTrue(outcome.timedOut)
    release()
  }

  /// A close is supposed to get the accepted records onto disk. Cancelling
  /// queued work the moment `close` is entered would discard exactly what the
  /// flush exists to save.
  func testAnOrdinaryCloseFlushesQueuedBatchesRatherThanDroppingThem() throws {
    let handle = try makeHandle()
    let release = stall(handle)

    for index in 0..<20 {
      XCTAssertTrue(handle.appendBatch("record-\(index)\n", entryCount: 1).accepted)
    }
    // Everything is queued behind the stall when the close begins.
    release()

    let outcome = handle.close(deadlineMs: 5000)
    XCTAssertTrue(outcome.durable)
    XCTAssertEqual(outcome.status.lostEntries, 0, "a close must not discard what it can flush")

    let lines = contents().split(separator: "\n")
    XCTAssertEqual(lines.count, 20)
    XCTAssertEqual(lines.last, "record-19")
  }

  func testClosedWriterRefusesFurtherAppends() throws {
    let handle = try makeHandle()
    write(handle, "before\n")
    _ = handle.close(deadlineMs: 1000)

    let rejected = handle.appendBatch("after\n", entryCount: 1)
    XCTAssertFalse(rejected.accepted)
    XCTAssertEqual(rejected.rejectReason, .closed)
    XCTAssertEqual(contents(), "before\n")
  }

  // MARK: - Liveness

  /// Writes to an unlinked inode succeed forever and land nowhere, with no
  /// error to notice. Without the liveness check an externally deleted log file
  /// means silent loss for the rest of the process's life.
  func testExternallyDeletedFileIsDetectedAndReopened() throws {
    let handle = try makeHandle()
    write(handle, "before\n")

    try FileManager.default.removeItem(at: logURL)

    // The check runs every few successful writes, not on every one.
    for index in 0..<12 {
      write(handle, "after-\(index)\n")
    }
    XCTAssertTrue(handle.flush(deadlineMs: 1000).durable)

    XCTAssertTrue(FileManager.default.fileExists(atPath: logURL.path))
    XCTAssertTrue(handle.writerForTesting.hasLiveHandleForTesting)
    XCTAssertTrue(contents().contains("after-11\n"), "later writes reach the recreated file")
  }

  func testWritesResumeAfterTheDescriptorIsLost() throws {
    let handle = try makeHandle()
    write(handle, "before\n")
    handle.writerForTesting.closeHandleForTesting()

    write(handle, "after\n")
    XCTAssertTrue(handle.flush(deadlineMs: 1000).durable)
    XCTAssertEqual(contents(), "before\nafter\n")
  }

  // MARK: - Crash-tail recovery

  func testTornTailIsTrimmedWhenRecordsAreLineFramed() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    try Data("complete\nalso complete\nhalf writ".utf8).write(to: logURL)

    let handle = try makeHandle(lineFramed: true)
    XCTAssertEqual(contents(), "complete\nalso complete\n")

    write(handle, "fresh\n")
    XCTAssertEqual(contents(), "complete\nalso complete\nfresh\n")
  }

  /// Without a declared framing contract the trailing bytes are
  /// indistinguishable from a record that simply contains newlines, so
  /// trimming would eat good data to tidy up after a crash that may not have
  /// happened.
  func testTornTailIsLeftAloneWithoutAFramingContract() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    try Data("complete\nhalf writ".utf8).write(to: logURL)

    _ = try makeHandle(lineFramed: false)
    XCTAssertEqual(contents(), "complete\nhalf writ")
  }

  /// Under a *declared* framing contract there is no ambiguity: every record
  /// ends in a newline, so a file containing none contains no complete record
  /// and all of it is torn.
  func testFileWithNoRecordBoundaryAtAllIsEntirelyTorn() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    try Data("one unfinished record".utf8).write(to: logURL)

    let handle = try makeHandle(lineFramed: true)
    XCTAssertEqual(contents(), "")

    write(handle, "fresh\n")
    XCTAssertEqual(contents(), "fresh\n")
  }

  /// A record bigger than one scan window hides the boundary that precedes it.
  /// Stopping after a single window would leave the torn tail in place.
  func testTornTailIsFoundBeyondASingleScanWindow() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    let complete = "complete\n"
    let enormous = String(repeating: "x", count: (1 << 20) + 4096) // > tailScanWindow
    try Data((complete + enormous).utf8).write(to: logURL)

    _ = try makeHandle(lineFramed: true)
    XCTAssertEqual(contents(), complete,
                   "the scan has to keep walking back until it finds a boundary")
  }

  func testAlreadyCleanTailIsUntouched() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    try Data("complete\n".utf8).write(to: logURL)

    _ = try makeHandle(lineFramed: true)
    XCTAssertEqual(contents(), "complete\n")
  }

  // MARK: - Config clamping

  /// These numbers arrive from JavaScript, where `NaN`, `Infinity`, and `-1`
  /// are ordinary values and an unchecked cast into a Swift integer takes the
  /// app down from inside the logger.
  func testHostileRotationNumbersAreClamped() {
    let nonsense = LogRotationPolicy(
      maxFileSizeBytes: .nan,
      maxArchivedFilesCount: -5,
      maxFileAgeSeconds: .nan,
      compressArchives: true,
      maxArchiveAgeSeconds: -1,
      maxTotalLogBytes: .nan
    )
    XCTAssertEqual(nonsense.maxFileSizeBytes, 10_485_760, "NaN carries no intent — use the default")
    XCTAssertEqual(nonsense.maxArchivedFilesCount, 0)
    XCTAssertNil(nonsense.maxFileAgeSeconds)
    XCTAssertNil(nonsense.maxArchiveAgeSeconds)
    XCTAssertNil(nonsense.maxTotalLogBytes)
  }

  /// `Infinity` means "never rotate". Folding it into the default would turn a
  /// request for no rotation into rotation every 10 MB, and folding it into
  /// zero would delete every archive.
  func testInfinityMeansNoLimitRatherThanNoRoom() {
    let unlimited = LogRotationPolicy(
      maxFileSizeBytes: .infinity,
      maxArchivedFilesCount: .infinity,
      maxFileAgeSeconds: .infinity,
      maxArchiveAgeSeconds: .infinity,
      maxTotalLogBytes: .infinity
    )
    XCTAssertGreaterThan(unlimited.maxFileSizeBytes, 1_000_000_000)
    XCTAssertEqual(unlimited.maxArchivedFilesCount, 10_000)
    XCTAssertNil(unlimited.maxFileAgeSeconds, "an absent optional limit is how nil spells 'no cap'")
    XCTAssertNil(unlimited.maxArchiveAgeSeconds)
    XCTAssertNil(unlimited.maxTotalLogBytes)
  }

  func testHostileDeadlinesDoNotTrap() throws {
    let handle = try makeHandle()
    write(handle, "x\n")
    XCTAssertFalse(handle.flush(deadlineMs: .nan).durable, "a nonsense deadline means no budget")
    XCTAssertTrue(handle.flush(deadlineMs: .infinity).durable, "and is clamped, not cast")
  }
}
