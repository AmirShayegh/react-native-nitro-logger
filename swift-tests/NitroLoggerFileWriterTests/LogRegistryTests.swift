import Foundation
import XCTest
@testable import NitroLoggerFileWriter

final class LogRegistryTests: LogWriterTestCase {

  // MARK: - One writer per file

  /// Two `FileHandle`s appending to the same path interleave mid-record, and
  /// two rotation schedules racing over one file archive each other's fresh
  /// output. Different spellings of the same file must land on one writer.
  func testDifferentSpellingsOfOnePathShareAWriter() throws {
    let plain = try makeHandle(at: logURL)
    let roundabout = try makeHandle(
      at: logsDirectory.appendingPathComponent("nested/../app.log")
    )
    XCTAssertTrue(plain.writerForTesting === roundabout.writerForTesting)
    XCTAssertEqual(registry.liveWriterCountForTesting, 1)
  }

  func testSymlinkedDirectoryResolvesToTheSameWriter() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    let alias = root.appendingPathComponent("alias")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: logsDirectory)

    let direct = try makeHandle(at: logURL)
    let viaAlias = try makeHandle(at: alias.appendingPathComponent("app.log"))

    XCTAssertTrue(direct.writerForTesting === viaAlias.writerForTesting)
    XCTAssertEqual(registry.liveWriterCountForTesting, 1)
  }

  /// Following a symlinked log file would write the app's log wherever the link
  /// points — a path the caller never named and the purge would never clean.
  func testSymlinkedLogFileIsRejected() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    let elsewhere = root.appendingPathComponent("elsewhere.log")
    try Data().write(to: elsewhere)
    try FileManager.default.createSymbolicLink(at: logURL, withDestinationURL: elsewhere)

    XCTAssertThrowsError(try makeHandle(at: logURL)) { error in
      XCTAssertEqual(error as? LogWriterError, .symlinkEscape)
    }
  }

  /// A second destination on the same file must agree about how that file is
  /// written, or one of the two silently gets a file that behaves nothing like
  /// what it asked for.
  func testConflictingConfigurationThrows() throws {
    _ = try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 1024))

    XCTAssertThrowsError(
      try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 4096))
    ) { error in
      XCTAssertEqual(error as? LogWriterError, .configConflict)
    }
    XCTAssertThrowsError(
      try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 1024), lineFramed: false)
    ) { error in
      XCTAssertEqual(error as? LogWriterError, .configConflict)
    }
  }

  func testMatchingConfigurationSharesTheWriter() throws {
    let first = try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 1024))
    let second = try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 1024))
    XCTAssertTrue(first.writerForTesting === second.writerForTesting)
  }

  func testDistinctFilesGetDistinctWriters() throws {
    _ = try makeHandle(at: logsDirectory.appendingPathComponent("a.log"))
    _ = try makeHandle(at: logsDirectory.appendingPathComponent("b.log"))
    XCTAssertEqual(registry.liveWriterCountForTesting, 2)
  }

  // MARK: - Lifetime

  func testWriterIsEvictedWhenTheLastHandleGoesAway() throws {
    let registry = LogWriterRegistry.isolated()
    do {
      let first = try registry.acquire(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
      let second = try registry.acquire(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
      XCTAssertEqual(registry.liveWriterCountForTesting, 1)

      _ = first.close(deadlineMs: 500)
      XCTAssertEqual(registry.liveWriterCountForTesting, 1, "the second handle still holds it")
      _ = second.close(deadlineMs: 500)
    }
    XCTAssertEqual(registry.liveWriterCountForTesting, 0)
  }

  /// The Nitro hybrid object holds exactly one handle, so its native finalizer
  /// running is enough to give the descriptor back — no JavaScript has to
  /// execute, which matters because abrupt runtime teardown skips `dispose()`.
  func testHandleDeinitReleasesWithoutAnExplicitClose() throws {
    let registry = LogWriterRegistry.isolated()
    autoreleasepool {
      let handle = try? registry.acquire(
        path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
      XCTAssertNotNil(handle)
      XCTAssertEqual(registry.liveWriterCountForTesting, 1)
    }
    XCTAssertEqual(registry.liveWriterCountForTesting, 0,
                   "the finalizer alone must release the claim")
  }

  func testDoubleCloseIsHarmless() throws {
    let registry = LogWriterRegistry.isolated()
    let handle = try registry.acquire(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    _ = handle.close(deadlineMs: 500)
    _ = handle.close(deadlineMs: 500)
    XCTAssertEqual(registry.liveWriterCountForTesting, 0)
  }

  func testReopeningAfterEverythingClosedWorks() throws {
    let registry = LogWriterRegistry.isolated()
    let first = try registry.acquire(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    _ = first.appendBatch("before\n", entryCount: 1)
    _ = first.close(deadlineMs: 1000)

    let second = try registry.acquire(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    _ = second.appendBatch("after\n", entryCount: 1)
    XCTAssertTrue(second.flush(deadlineMs: 1000).durable)
    _ = second.close(deadlineMs: 1000)

    XCTAssertEqual(contents(), "before\nafter\n", "a reopened file appends rather than truncating")
  }

  // MARK: - Purge and generations

  func testPurgeDeletesEveryArtifact() throws {
    let policy = LogRotationPolicy(maxFileSizeBytes: 64, maxArchivedFilesCount: 100, compressArchives: true)
    let handle = try makeHandle(policy: policy)
    for _ in 0..<8 { write(handle, String(repeating: "x", count: 39) + "\n") }

    // An interrupted compression and a sidecar, neither of which rotation
    // produced in this run but both of which the scheme allows on disk.
    let orphan = logsDirectory.appendingPathComponent("app.log.20260101T000000Z_deadbeef.gz.part")
    let sidecar = logsDirectory.appendingPathComponent("app.log.meta")
    try Data("partial".utf8).write(to: orphan)
    try Data("age=1".utf8).write(to: sidecar)
    XCTAssertGreaterThan(names().count, 3)

    let outcome = handle.clearLogs(deadlineMs: 2000)
    XCTAssertTrue(outcome.durable)
    XCTAssertTrue(outcome.failedPaths.isEmpty)
    XCTAssertGreaterThan(outcome.deletedCount, 3)
    XCTAssertEqual(names(), ["app.log"], "only the freshly reopened file remains")
    XCTAssertEqual(contents(), "")
  }

  func testPurgeLeavesUnrelatedFilesAlone() throws {
    let handle = try makeHandle()
    write(handle, "x\n")
    let bystander = logsDirectory.appendingPathComponent("something-else.txt")
    try Data("keep me".utf8).write(to: bystander)

    _ = handle.clearLogs(deadlineMs: 2000)
    XCTAssertTrue(FileManager.default.fileExists(atPath: bystander.path))
  }

  /// The invoking handle rebinds only after a durable purge; every other handle
  /// stays fenced until it discovers the generation moved.
  func testPurgeFencesOtherHandlesAndRebindsTheInvoker() throws {
    let purger = try makeHandle()
    let bystander = try makeHandle()
    write(purger, "before\n")

    XCTAssertTrue(purger.clearLogs(deadlineMs: 2000).durable)

    let fenced = bystander.appendBatch("stale\n", entryCount: 1)
    XCTAssertFalse(fenced.accepted)
    XCTAssertEqual(fenced.rejectReason, .staleGeneration)

    let rebound = write(purger, "after\n")
    XCTAssertTrue(rebound.accepted, "the invoking handle rebinds on durable success")
    XCTAssertEqual(contents(), "after\n")
  }

  /// Rebinding on a partial deletion would resume writing into a directory
  /// where deletion is still pending or has failed — the records that landed
  /// there would be exactly the ones the purge was supposed to guarantee gone.
  func testHandleStaysFencedWhenThePurgeIsIncomplete() throws {
    let policy = LogRotationPolicy(maxFileSizeBytes: 64, maxArchivedFilesCount: 100)
    let handle = try makeHandle(policy: policy)
    for _ in 0..<4 { write(handle, String(repeating: "x", count: 39) + "\n") }

    let stubborn = try XCTUnwrap(archiveNames().first)
    let stubbornURL = logsDirectory.appendingPathComponent(stubborn)
    TestFlags.makeImmutable(stubbornURL)

    let outcome = handle.clearLogs(deadlineMs: 2000)
    XCTAssertFalse(outcome.durable, "an incomplete purge is reported honestly")
    XCTAssertEqual(outcome.failedPaths, [stubbornURL.path])
    XCTAssertTrue(FileManager.default.fileExists(atPath: stubbornURL.path))

    let rejected = handle.appendBatch("after\n", entryCount: 1)
    XCTAssertFalse(rejected.accepted)
    XCTAssertEqual(rejected.rejectReason, .staleGeneration)
  }

  func testARetriedPurgeSucceedsOnceTheObstacleIsGone() throws {
    let policy = LogRotationPolicy(maxFileSizeBytes: 64, maxArchivedFilesCount: 100)
    let handle = try makeHandle(policy: policy)
    for _ in 0..<4 { write(handle, String(repeating: "x", count: 39) + "\n") }

    let stubbornURL = logsDirectory.appendingPathComponent(try XCTUnwrap(archiveNames().first))
    TestFlags.makeImmutable(stubbornURL)
    XCTAssertFalse(handle.clearLogs(deadlineMs: 2000).durable)

    chflags(stubbornURL.path, 0)
    XCTAssertTrue(handle.clearLogs(deadlineMs: 2000).durable)
    XCTAssertEqual(names(), ["app.log"])
    XCTAssertTrue(write(handle, "after\n").accepted)
  }

  /// A batch accepted before the purge but not yet written belongs to a file
  /// that was deliberately deleted. Writing it into the fresh file would
  /// resurrect pre-purge data; counting it as loss would describe a gap the
  /// user asked for.
  func testInFlightBatchIsDroppedAcrossAPurgeWithoutBeingCountedAsLoss() throws {
    let handle = try makeHandle()
    let release = stall(handle)
    XCTAssertTrue(handle.appendBatch("pre-purge\n", entryCount: 1).accepted)

    let purged = expectation(description: "purge finished")
    var outcome: LogClearOutcome?
    DispatchQueue.global().async {
      outcome = handle.clearLogs(deadlineMs: 5000)
      purged.fulfill()
    }

    // Let the queued write run first; it sees the bumped generation and drops.
    Thread.sleep(forTimeInterval: 0.1)
    release()
    wait(for: [purged], timeout: 5)

    XCTAssertTrue(try XCTUnwrap(outcome).durable)
    XCTAssertEqual(contents(), "", "the in-flight batch never reached the fresh file")
    XCTAssertEqual(handle.status().lostEntries, 0, "a deliberate deletion is not a loss")
    XCTAssertEqual(handle.status().queuedBytes, 0)
  }

  func testPurgeClearsLossAndDegradationCounters() throws {
    let faults = WriteFaults()
    let handle = try makeHandle(rawWrite: faults.raw)
    faults.failAfter(0)
    write(handle, "doomed\n")
    faults.recover()
    XCTAssertGreaterThan(handle.status().lostEntries, 0)

    XCTAssertTrue(handle.clearLogs(deadlineMs: 2000).durable)
    XCTAssertEqual(handle.status().lostEntries, 0, "counters are baselined with the files")
    XCTAssertEqual(handle.status().lostBytes, 0)
    XCTAssertEqual(handle.status().degraded, 0)
  }

  // MARK: - A released handle is not a working handle

  /// Releasing drops this handle's claim, but the writer lives on while any
  /// other handle holds it — so nothing about the writer stops a released
  /// handle from still working. It has to refuse on its own.
  func testAReleasedHandleRefusesEveryOperation() throws {
    let keeper = try makeHandle()
    let released = try makeHandle()
    XCTAssertTrue(keeper.writerForTesting === released.writerForTesting)

    _ = released.close(deadlineMs: 1000)

    let append = released.appendBatch("after\n", entryCount: 1)
    XCTAssertFalse(append.accepted)
    XCTAssertEqual(append.rejectReason, .closed)
    XCTAssertFalse(released.flush(deadlineMs: 500).durable)
    XCTAssertEqual(released.logFilePaths(), [])
    XCTAssertEqual(released.status().queuedBytes, 0)

    // And the writer it shared is untouched.
    XCTAssertTrue(write(keeper, "still working\n").accepted)
    XCTAssertTrue(keeper.flush(deadlineMs: 1000).durable)
    XCTAssertEqual(contents(), "still working\n")
  }

  /// The most dangerous one: a destination disposed minutes ago must not be
  /// able to delete the files that live destinations are writing to.
  func testAReleasedHandleCannotPurge() throws {
    let keeper = try makeHandle()
    let released = try makeHandle()
    write(keeper, "precious\n")

    _ = released.close(deadlineMs: 1000)

    let outcome = released.clearLogs(deadlineMs: 2000)
    XCTAssertFalse(outcome.durable)
    XCTAssertEqual(outcome.deletedCount, 0)
    XCTAssertEqual(contents(), "precious\n", "the live destination's file survives")
    XCTAssertTrue(write(keeper, "and keeps going\n").accepted)
  }

  // MARK: - Ownership across close

  /// Eviction and close are not one atomic step, and between them the map has
  /// no entry for the path. An acquire arriving in that window must not build a
  /// second writer over a file the first is still draining.
  func testAcquireWaitsOutAnInProgressClose() throws {
    let registry = LogWriterRegistry.isolated()
    let first = try registry.acquire(
      path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    let writer = first.writerForTesting

    // Wedge the write queue so the close cannot finish immediately.
    let release = writer.stallForTesting()
    _ = writer.append(handleID: 999, handleGeneration: writer.currentGeneration,
                      batch: "queued\n", entryCount: 1)

    let closing = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      _ = first.close(deadlineMs: 1500)
      closing.signal()
    }

    // Poll rather than sleep a guessed interval: `close` flushes first, and
    // only reaches the eviction step once that flush gives up on the stalled
    // queue. When it does is a function of the deadline, not of this test.
    var claimed = false
    for _ in 0..<400 where !claimed {
      if registry.closingCountForTesting == 1 { claimed = true; break }
      Thread.sleep(forTimeInterval: 0.01)
    }
    XCTAssertTrue(claimed, "the path should be claimed for the duration of the close")

    let acquired = DispatchSemaphore(value: 0)
    var second: LogFileHandle?
    DispatchQueue.global().async {
      second = try? registry.acquire(
        path: self.logURL.path, policy: LogRotationPolicy(), lineFramed: true)
      acquired.signal()
    }

    XCTAssertEqual(acquired.wait(timeout: .now() + .milliseconds(200)), .timedOut,
                   "acquire must not hand out a rival writer mid-close")

    release()
    XCTAssertEqual(closing.wait(timeout: .now() + .seconds(5)), .success)
    XCTAssertEqual(acquired.wait(timeout: .now() + .seconds(5)), .success)

    XCTAssertNotNil(second)
    XCTAssertFalse(second?.writerForTesting === writer, "and then builds a fresh one")
    XCTAssertEqual(registry.closingCountForTesting, 0)
    _ = second?.close(deadlineMs: 1000)
  }

  // MARK: - Purge honesty

  /// A directory that cannot be read is not an empty one. Reporting a durable
  /// purge over an unreadable directory is the worst lie this call can tell.
  func testAnUnreadableDirectoryIsNotReportedAsAPurge() throws {
    let handle = try makeHandle()
    write(handle, "sensitive\n")

    // Search permission removed: the contents cannot be enumerated.
    XCTAssertEqual(chmod(logsDirectory.path, 0o000), 0)
    defer { chmod(logsDirectory.path, 0o700) }

    let outcome = handle.clearLogs(deadlineMs: 2000)
    XCTAssertFalse(outcome.durable, "an unreadable directory must never read as swept")
    XCTAssertEqual(outcome.deletedCount, 0)
    XCTAssertFalse(outcome.failedPaths.isEmpty)

    chmod(logsDirectory.path, 0o700)
    XCTAssertEqual(contents(), "sensitive\n", "and nothing was actually deleted")
  }

  func testAnAbsentDirectoryIsASuccessfulPurge() throws {
    let handle = try makeHandle()
    write(handle, "x\n")
    try FileManager.default.removeItem(at: logsDirectory)

    // Nothing there can have survived, so there is nothing to report as failed.
    let outcome = handle.clearLogs(deadlineMs: 2000)
    XCTAssertTrue(outcome.durable)
    XCTAssertEqual(outcome.deletedCount, 0)
  }

  /// Deletion succeeding and the writer being usable again are separate facts.
  /// Rebinding on the first without the second gives back a handle that accepts
  /// records and then loses them.
  func testAPurgeThatCannotReopenDoesNotRebind() throws {
    let handle = try makeHandle()
    write(handle, "before\n")

    // Remove the log directory first, THEN make its parent immutable. The
    // purge finds nothing left to delete (durably true — nothing survived) and
    // the reopen cannot recreate the directory.
    try FileManager.default.removeItem(at: logsDirectory)
    TestFlags.makeImmutable(root)
    defer { chflags(root.path, 0) }

    let outcome = handle.clearLogs(deadlineMs: 2000)
    XCTAssertTrue(outcome.durable, "the deletion itself is honestly reported")

    let rejected = handle.appendBatch("after\n", entryCount: 1)
    XCTAssertFalse(rejected.accepted)
    XCTAssertEqual(rejected.rejectReason, .staleGeneration,
                   "without a usable writer the handle stays fenced")
  }

  /// A second purge asking for 100 ms must not sit behind another purge's full
  /// budget and still believe it was given 100 ms.
  func testASecondPurgeGetsItsOwnBudgetNotTheFirstOnes() throws {
    let handle = try makeHandle()
    let other = try makeHandle()
    let release = stall(handle)

    // The first purge wedges on the stalled queue for its whole deadline.
    let firstDone = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      _ = handle.clearLogs(deadlineMs: 4000)
      firstDone.signal()
    }
    Thread.sleep(forTimeInterval: 0.1)

    let started = Date()
    let second = other.clearLogs(deadlineMs: 150)
    let waited = Date().timeIntervalSince(started)

    XCTAssertFalse(second.durable)
    XCTAssertLessThan(waited, 2.0, "the budget starts when the call does, not when it wins the lock")

    release()
    _ = firstDone.wait(timeout: .now() + .seconds(10))
  }

  func testPurgeOnAHungWriterRespectsTheDeadline() throws {
    let handle = try makeHandle()
    let release = stall(handle)

    let started = Date()
    let outcome = handle.clearLogs(deadlineMs: 100)
    XCTAssertLessThan(Date().timeIntervalSince(started), 2.0)
    XCTAssertFalse(outcome.durable, "a purge that could not finish never claims it did")

    // Fenced either way: the generation bumps before any deletion is attempted,
    // so a late deletion can never race a fresh write.
    XCTAssertEqual(handle.appendBatch("after\n", entryCount: 1).rejectReason, .staleGeneration)
    release()
  }

  // MARK: - Deletion and rebinding are separate facts

  /// A purge that deletes everything but cannot reopen must say so.
  ///
  /// `durable` answers the compliance question and stays true — the artifacts
  /// really are gone. `rebound` answers the operational one, and a caller that
  /// resumed on `durable` alone would hand every subsequent record to a writer
  /// with no descriptor: accepted, refused as stale, dropped.
  func testAPurgeThatCannotReopenReportsTheDeletionButNotARebind() throws {
    let handle = try makeHandle()
    write(handle, "before\n")
    let writer = handle.writerForTesting

    // Terminating the writer is the reliable way to make the reopen fail while
    // leaving deletion perfectly able to succeed.
    _ = writer.close(handleID: handle.id, deadlineMs: 1000)

    let result = writer.clearLogs(deadlineMs: 2000)
    XCTAssertTrue(result.outcome.durable, "the artifacts were deleted, and that is what durable means")
    XCTAssertFalse(result.outcome.rebound, "a terminated writer must not open a fresh descriptor")
    XCTAssertFalse(FileManager.default.fileExists(atPath: logURL.path),
                   "and it must not leave an empty file where a purge promised none")
  }

  /// The handle adopts the new generation only when both facts hold.
  func testTheHandleStaysFencedWhenTheWriterDidNotComeBack() throws {
    let handle = try makeHandle()
    write(handle, "before\n")
    let fenced = handle.generationForTesting

    _ = handle.writerForTesting.close(handleID: handle.id, deadlineMs: 1000)
    let outcome = handle.clearLogs(deadlineMs: 2000)

    XCTAssertTrue(outcome.durable)
    XCTAssertFalse(outcome.rebound)
    XCTAssertEqual(handle.generationForTesting, fenced,
                   "no rebind without a usable file to rebind onto")
  }

  // MARK: - A purge must not lend its deadline to a close

  /// `close` promises a bound, and an unrelated purge cannot be allowed to
  /// break it.
  ///
  /// The purge can legitimately run for tens of seconds. If closing waited
  /// behind it — which holding one lock across the whole deletion would force —
  /// then a dispose during a purge would block the caller for the *purge's*
  /// deadline, not its own. On the JS side that is an unresponsive app.
  func testCloseKeepsItsOwnDeadlineWhileAPurgeIsInFlight() throws {
    let handle = try makeHandle()
    let release = stall(handle)

    let purgeDone = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      _ = handle.clearLogs(deadlineMs: 20_000)
      purgeDone.signal()
    }
    Thread.sleep(forTimeInterval: 0.1)

    let started = Date()
    _ = handle.close(deadlineMs: 150)
    let waited = Date().timeIntervalSince(started)

    XCTAssertLessThan(waited, 5.0, "close waits out a purge under its own deadline, not the purge's")

    release()
    _ = purgeDone.wait(timeout: .now() + .seconds(30))
  }

  /// The deadline is a total, not a per-step allowance.
  ///
  /// Closing waits three times — out an in-flight purge, through the flush, and
  /// through the writer's teardown. Giving each step the full figure turns the
  /// number the caller passed into a multiple of itself.
  func testCloseSpendsOneBudgetAcrossEveryWaitItDoes() throws {
    let handle = try makeHandle()
    let release = stall(handle)

    let purgeDone = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      _ = handle.clearLogs(deadlineMs: 20_000)
      purgeDone.signal()
    }
    Thread.sleep(forTimeInterval: 0.1)

    // The queue stays wedged throughout, so every one of the three waits runs
    // to its limit and the total is exactly what is being measured.
    let started = Date()
    _ = handle.close(deadlineMs: 600)
    let waited = Date().timeIntervalSince(started)

    XCTAssertLessThan(waited, 1.8, "600 ms asked for, and 600 ms is what all three waits share")

    release()
    _ = purgeDone.wait(timeout: .now() + .seconds(30))
  }

  /// `rebound` describes the handle, not the writer.
  ///
  /// They come apart exactly here: `close` gives up waiting for a slow purge
  /// and shuts the handle, then the purge finishes and reopens the file. The
  /// writer genuinely has a fresh descriptor — and this handle is never going
  /// to adopt it. Handing the writer's answer back would tell the caller to
  /// resume a destination that has already been closed.
  func testAPurgeThatOutlivesItsHandleDoesNotClaimTheHandleRebound() throws {
    let handle = try makeHandle()
    let release = stall(handle)

    let purged = DispatchSemaphore(value: 0)
    var outcome: LogClearOutcome?
    DispatchQueue.global().async {
      outcome = handle.clearLogs(deadlineMs: 20_000)
      purged.signal()
    }
    Thread.sleep(forTimeInterval: 0.1)

    // Closes without waiting the purge out, so the handle is gone by the time
    // the deletion lands.
    _ = handle.close(deadlineMs: 50)

    release()
    XCTAssertEqual(purged.wait(timeout: .now() + .seconds(30)), .success)

    let result = try XCTUnwrap(outcome)
    XCTAssertTrue(result.durable, "the deletion itself still happened")
    XCTAssertFalse(result.rebound, "but this handle did not rebind and never will")
  }

  /// One purge per handle at a time. Two overlapping ones would race the rebind
  /// with nothing to arbitrate which generation wins.
  func testASecondPurgeOnTheSameHandleIsRefusedWhileTheFirstRuns() throws {
    let handle = try makeHandle()
    let release = stall(handle)

    let firstDone = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      _ = handle.clearLogs(deadlineMs: 4000)
      firstDone.signal()
    }
    Thread.sleep(forTimeInterval: 0.1)

    let second = handle.clearLogs(deadlineMs: 4000)
    XCTAssertFalse(second.durable)
    XCTAssertFalse(second.rebound)

    release()
    _ = firstDone.wait(timeout: .now() + .seconds(10))
  }

  // MARK: - The close barrier covers everything it accepted

  /// Every batch this handle accepted has to be on disk when `close` reports
  /// durable.
  ///
  /// Reading the generation and then releasing the handle lock before appending
  /// leaves a window: `close` shuts the door, flushes, and returns — and only
  /// then does the append it never saw reach the writer and get accepted. Those
  /// records are outside the barrier that just promised everything was written.
  func testNothingAcceptedIsLeftOutsideTheCloseBarrier() throws {
    let handle = try makeHandle()
    let accepted = NSMutableSet()
    let acceptedLock = NSLock()

    let writing = DispatchGroup()
    for worker in 0..<4 {
      writing.enter()
      DispatchQueue.global().async {
        defer { writing.leave() }
        for index in 0..<200 {
          let line = "w\(worker)-\(index)"
          if handle.appendBatch(line + "\n", entryCount: 1).accepted {
            acceptedLock.lock(); accepted.add(line); acceptedLock.unlock()
          }
        }
      }
    }

    Thread.sleep(forTimeInterval: 0.02)
    let outcome = handle.close(deadlineMs: 5000)
    writing.wait()

    XCTAssertTrue(outcome.durable, "an unstalled writer should have drained inside the deadline")
    let written = Set(contents().split(separator: "\n").map(String.init))
    acceptedLock.lock()
    let promised = accepted.compactMap { $0 as? String }
    acceptedLock.unlock()

    XCTAssertFalse(promised.isEmpty, "the race is only interesting if something was accepted")
    let missing = promised.filter { !written.contains($0) }
    XCTAssertTrue(missing.isEmpty, "accepted but never written: \(missing.prefix(5))")
  }
}
