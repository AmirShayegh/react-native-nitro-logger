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

  /// The rollback target is measured at the moment of failure rather than
  /// tracked from before the write, and this is the case where the two differ:
  /// something appended to the same file behind this writer's back — a second
  /// process, or this one through a handle it does not own. Truncating to the
  /// tracked offset would delete those bytes instead of this batch's.
  ///
  /// Without this the whole of S5 is unpinned. Every other rollback test keeps
  /// the tracked counter and the true end of file in agreement, so rolling
  /// back to either one passes.
  func testARollbackRemovesThisBatchAndNotWhatSomebodyElseAppended() throws {
    let faults = WriteFaults()
    let handle = try makeHandle(rawWrite: faults.raw)

    write(handle, "good\n")
    XCTAssertEqual(contents(), "good\n")

    let outside = try FileHandle(forWritingTo: logURL)
    outside.seekToEndOfFile()
    outside.write(Data("other\n".utf8))
    try outside.close()
    XCTAssertEqual(contents(), "good\nother\n")

    faults.failAfter(4) // four bytes of the next batch land, then it fails
    write(handle, "0123456789\n")

    XCTAssertEqual(
      contents(),
      "good\nother\n",
      "the rollback must remove what this batch wrote and nothing else"
    )
    XCTAssertEqual(handle.status().lostEntries, 1)

    faults.recover()
    write(handle, "after\n")
    XCTAssertEqual(contents(), "good\nother\nafter\n")
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

  /// A flush that reaches the writer after the close barrier must not open a
  /// descriptor nothing will ever close.
  ///
  /// `syncNow` asks for a handle with `ignoringBackoff: true` — deliberately,
  /// because a flush is someone asking for durability now. Without a
  /// `terminated` check that unconditionally called `attemptReopen()`, so a
  /// flush landing behind the barrier opened a fresh descriptor on a writer the
  /// caller had finished with. Nothing holds it and nothing will close it: it
  /// leaks for the lifetime of the process, and the flush reports success by
  /// resurrection.
  ///
  /// **Why this calls the writer rather than `handle.flush`.** It is reproducing
  /// one specific interleaving, and going through the handle cannot reach it:
  ///
  ///   * `LogFileHandle.flush` checks `liveGeneration()`, drops the lock, and
  ///     only then calls `writer.flush(handleID:)`. In that window a concurrent
  ///     `close()` can run to completion — `state = .closing`, its own flush,
  ///     `releaseNow`, the writer's barrier setting `terminated`. The first
  ///     thread then resumes and enqueues `syncNow` *behind* that barrier.
  ///     `handle.flush` called after `close()` returns is refused by the
  ///     generation check, so it proves nothing about this path.
  ///   * Nothing enqueued before the barrier can reach it either: the write
  ///     queue is serial, so everything queued ahead of the barrier runs while
  ///     `terminated` is still false — including a flush whose deadline expired
  ///     with its block still pending.
  ///
  /// So the only way in is the one the racing thread takes: a handle ID that
  /// already passed the generation check, handed to `writer.flush` after
  /// termination. That is what this does, and it is the sole reason the guard
  /// lives in `writableHandle` rather than at the call sites.
  func testFlushReachingTheWriterAfterTerminationDoesNotReopen() throws {
    let handle = try makeHandle()
    write(handle, "before\n")

    // Single handle, so this drives the writer's refcount to zero: the registry
    // closes it and the barrier sets `terminated`.
    _ = handle.close(deadlineMs: 1000)
    let writer = handle.writerForTesting
    XCTAssertTrue(writer.isClosed, "the writer must really be terminated for this to test anything")

    // Pin the baseline at zero rather than comparing before with after: if
    // `close()` itself leaked, a flush that merely reused that descriptor would
    // satisfy before == after and the test would pass with the leak intact.
    XCTAssertEqual(openDescriptorCount(), 0, "close left a descriptor open on the log")

    let outcome = writer.flush(handleID: handle.id, deadlineMs: 1000)

    XCTAssertFalse(outcome.durable, "a terminated writer cannot sync anything")
    XCTAssertEqual(
      openDescriptorCount(), 0,
      "flush after termination opened a descriptor that nothing will ever close")
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

  /// A flush must not be refused by a backoff that exists to protect ordinary
  /// writes.
  ///
  /// The reopen backoff stops a dead descriptor from being retried on every
  /// single append. But `flush` is the caller saying "put it on storage now",
  /// and for the crash and terminate paths there is no later attempt coming —
  /// so honouring the backoff there gives up on exactly the records that
  /// explain the shutdown. SwiftLogger has carried `ignoringBackoff` for this
  /// since the crash-path work; the port dropped it.
  func testFlushReopensInsideTheBackoffWindow() throws {
    let handle = try makeHandle()
    write(handle, "before\n")

    // Arm the backoff with a reopen that genuinely fails. Removing the
    // directory is not enough on its own — a reopen recreates it — so the
    // parent is made immutable too.
    handle.writerForTesting.closeHandleForTesting()
    try FileManager.default.removeItem(at: logsDirectory)
    TestFlags.makeImmutable(root)
    write(handle, "lost\n")
    XCTAssertFalse(
      handle.writerForTesting.hasLiveHandleForTesting,
      "precondition: the failed reopen armed the backoff")

    // Make a reopen possible again, then ask for durability immediately —
    // well inside the one-second window.
    chflags(root.path, 0)

    let outcome = handle.flush(deadlineMs: 1000)

    XCTAssertTrue(outcome.durable, "flush ignores the backoff and reopens")
    XCTAssertTrue(handle.writerForTesting.hasLiveHandleForTesting)
    XCTAssertTrue(FileManager.default.fileExists(atPath: logURL.path))
  }

  /// The other half of the same contract: an ordinary append must still be
  /// held back, or the backoff protects nothing.
  func testAnOrdinaryWriteStillHonoursTheBackoff() throws {
    let handle = try makeHandle()
    handle.writerForTesting.closeHandleForTesting()
    try FileManager.default.removeItem(at: logsDirectory)
    TestFlags.makeImmutable(root)
    write(handle, "lost\n")

    chflags(root.path, 0)

    write(handle, "still within the window\n")
    XCTAssertFalse(
      handle.writerForTesting.hasLiveHandleForTesting,
      "an append inside the window must not retry the reopen")
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
    XCTAssertEqual(
      nonsense.maxArchivedFilesCount, 5,
      "a negative count is not an instruction to delete every archive"
    )
    XCTAssertNil(nonsense.maxFileAgeSeconds)
    XCTAssertNil(nonsense.maxArchiveAgeSeconds)
    XCTAssertNil(nonsense.maxTotalLogBytes)
  }

  /// The distinction the retention limit has to make: zero is an instruction and
  /// `NaN` is not.
  ///
  /// Both used to clamp to zero, which meant one malformed number from
  /// JavaScript deleted every rotated file on the next sweep — the failure mode
  /// the byte limits had always been careful to avoid.
  func testAnExplicitZeroKeepsNoArchivesButNaNDoesNot() {
    let none = LogRotationPolicy(maxArchivedFilesCount: 0)
    XCTAssertEqual(none.maxArchivedFilesCount, 0, "zero is a real request to keep nothing")

    let malformed = LogRotationPolicy(maxArchivedFilesCount: .nan)
    XCTAssertEqual(malformed.maxArchivedFilesCount, 5, "NaN falls back rather than deleting")
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

  /// The clamp is the claim, and it is asserted on the clamp.
  ///
  /// `Int(exactly:)` traps on `NaN` and on `1e30`, so these have to be mapped
  /// rather than cast — that is the defect. What this must **not** assert is
  /// that a zero budget produces `durable: false`: a zero budget bounds the
  /// wait, it does not guarantee one. The queue can drain the barrier before
  /// `group.wait` is even entered, and asserting otherwise made this test fail
  /// spuriously on a loaded machine — a red run that says nothing about the
  /// code is worse than no test.
  func testHostileDeadlinesDoNotTrap() throws {
    XCTAssertEqual(LogWriter.clampDeadline(.nan), 0, "a nonsense deadline means no budget")
    XCTAssertEqual(LogWriter.clampDeadline(-1), 0)
    XCTAssertEqual(LogWriter.clampDeadline(0), 0)
    XCTAssertEqual(LogWriter.clampDeadline(.infinity), LogWriter.MAX_DEADLINE_MS,
                   "'as long as you are allowed to' is the ceiling, not zero")
    XCTAssertEqual(LogWriter.clampDeadline(1e30), LogWriter.MAX_DEADLINE_MS)

    // And the values reach the writer without trapping on the way.
    let handle = try makeHandle()
    write(handle, "x\n")
    _ = handle.flush(deadlineMs: .nan)
    XCTAssertTrue(handle.flush(deadlineMs: .infinity).durable, "and is clamped, not cast")
  }

  // MARK: - Scheduling

  /// Log writes run below the interface, and the calls that block a caller do
  /// not.
  ///
  /// The split is the whole point. An append has already returned to its caller
  /// by the time its block runs, so nothing is waiting and it can yield to the
  /// UI — a log write must never be why a frame is late. A `flush` or a `close`
  /// is the opposite: the JavaScript thread is sitting on it with a deadline,
  /// and demoting it would make the app less responsive rather than more.
  ///
  /// Read from inside the block through the `rawWrite` seam, because the
  /// question is what the work *ran at*, not what was requested. That
  /// distinction is not pedantic here: a `DispatchQueue` created with a QoS
  /// treats it as a ceiling and silently discards `async(qos:)`, so the obvious
  /// implementation — give the queue `.utility` and boost the barriers —
  /// produces a writer where the barriers are quietly demoted instead. This
  /// test fails against that implementation, which is why it reads the running
  /// QoS rather than asserting on the queue.
  ///
  /// ## What this does not prove
  ///
  /// That the scheduler did anything differently. QoS is a request; nothing in
  /// userspace can observe what the kernel made of it. It also does not prove a
  /// barrier is *fast* — a barrier still queues behind appends that are already
  /// in front of it, and those now run at utility.
  func testWritesRunBelowTheCallsThatBlockACaller() throws {
    let appendQoS = QoSProbe()
    let handle = try makeHandle(rawWrite: { fd, buffer, count in
      appendQoS.record()
      return Darwin.write(fd, buffer, count)
    })

    _ = handle.appendBatch("x\n", entryCount: 1)
    handle.writerForTesting.settleForTesting()
    XCTAssertEqual(
      appendQoS.observed(), QOS_CLASS_UTILITY,
      "an append that nobody is waiting for should not run at the caller's priority")

    // The other half, and the reason this is one test: the demotion above is
    // only safe because the queue has no QoS of its own. A queue built with
    // one treats it as a ceiling — `async(qos:)` on such a queue is silently
    // discarded — so assigning `.utility` to the queue would demote the six
    // deadline-bound barriers along with the appends. `.unspecified` is what
    // keeps `flush`, `close`, `maintain`, `collectLogs`, `clearLogs` and
    // `logFilePaths` running at whatever their blocked caller is running at.
    XCTAssertEqual(
      handle.writerForTesting.queueQoSForTesting, .unspecified,
      "a QoS on the queue would become a ceiling over every deadline-bound barrier")
  }

  /// Records the QoS class the block that touched it was running at.
  private final class QoSProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var seen: qos_class_t?

    func record() {
      lock.lock()
      if seen == nil { seen = qos_class_self() }
      lock.unlock()
    }

    func observed() -> qos_class_t? {
      lock.lock()
      defer { lock.unlock() }
      return seen
    }
  }
}
