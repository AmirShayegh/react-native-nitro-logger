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
    XCTAssertEqual(
      names(), ["app.log", LogWriter.lockName("app.log")],
      "only the freshly reopened file remains — the exclusion file survives on purpose: it holds no log bytes, and unlinking it while this writer holds the lock would let the next process lock a fresh file and append alongside it")
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
    XCTAssertEqual(names(), ["app.log", LogWriter.lockName("app.log")])
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

  /// `failedPaths` means "still there, as far as this call can tell". A refusal
  /// deleted nothing, so the log file qualifies — and this level used to say
  /// otherwise while the writer's own refusals (`clearLogs` on purge-lock
  /// contention, and on a blown deadline) already named the path. Android named
  /// it at both levels; iOS disagreed with itself.
  func testARefusedPurgeNamesTheFileItDidNotDelete() throws {
    let handle = try makeHandle()
    _ = handle.close(deadlineMs: 1000)

    let outcome = handle.clearLogs(deadlineMs: 1000)
    XCTAssertFalse(outcome.durable)
    XCTAssertEqual(outcome.deletedCount, 0)
    XCTAssertEqual(outcome.failedPaths, [logURL.path])
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
                      batch: Data("queued\n".utf8), entryCount: 1)

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

  /// The directory verdict survives two acquires racing to create the same log.
  ///
  /// `resolve` runs *outside* the registry lock, and it is `resolve` that
  /// creates the directory. So on a fresh path the two halves of the evidence
  /// can land on different threads: whichever acquire wins the `mkdir` is the
  /// only one that ever learns the backup exclusion failed, while the other one
  /// can win the lock and publish the writer with nothing to report. The winner
  /// then arrives at the reuse branch holding the only verdict there is.
  ///
  /// Folding it in only through the constructor loses it in exactly that
  /// interleaving — which is the same reporting gap C11 fixed for the
  /// single-acquirer case, reappearing under concurrency.
  ///
  /// Deterministic, not timing-hopeful: `afterResolveForTesting` parks the
  /// mkdir winner in the gap between resolving and locking, and it is only
  /// released once the other acquire has published a writer.
  func testADirectoryVerdictSurvivesTwoAcquiresRacingToCreateTheLog() throws {
    LogSecureFile.injectDirectoryProtectionFaultForTesting(.protection, under: root)

    let registry = LogWriterRegistry.isolated()
    let parked = DispatchSemaphore(value: 0)
    let mayProceed = DispatchSemaphore(value: 0)

    // Only the first acquire through — the mkdir winner — is parked. The
    // second must run to completion while the first is held, or there is no
    // race to test.
    var parkedOnce = false
    let parkLock = NSLock()
    registry.afterResolveForTesting = {
      parkLock.lock()
      let shouldPark = !parkedOnce
      parkedOnce = true
      parkLock.unlock()
      guard shouldPark else { return }
      parked.signal()
      mayProceed.wait()
    }

    var winner: LogFileHandle?
    let winnerDone = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      winner = try? registry.acquire(
        path: self.logURL.path, policy: LogRotationPolicy(), lineFramed: true)
      winnerDone.signal()
    }

    XCTAssertEqual(parked.wait(timeout: .now() + .seconds(5)), .success,
                   "the first acquire never reached the gap after resolve")

    // Second acquire: the directory now exists, so its `createDirectory` hits
    // EEXIST and it has nothing to report. It publishes the writer.
    let publisher = try registry.acquire(
      path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)

    mayProceed.signal()
    XCTAssertEqual(winnerDone.wait(timeout: .now() + .seconds(5)), .success)

    let winningHandle = try XCTUnwrap(winner)
    XCTAssertTrue(winningHandle.writerForTesting === publisher.writerForTesting,
                  "both acquires must share one writer, or this tests nothing")

    let flag = LogDegradation.protection.rawValue
    XCTAssertNotEqual(winningHandle.status().degraded & flag, 0,
                      "the acquire that won the mkdir lost its own verdict")
    // Same writer, so the publisher sees it too — which is the point: the app
    // is told regardless of which destination it asks.
    XCTAssertNotEqual(publisher.status().degraded & flag, 0,
                      "the verdict must reach every handle on the writer")

    _ = winningHandle.close(deadlineMs: 1000)
    _ = publisher.close(deadlineMs: 1000)
  }

  /// And it survives even when the acquire carrying it is turned away.
  ///
  /// The mkdir winner can lose the publication race to a caller wanting a
  /// *different* policy. It is then rejected with `configConflict` — but it
  /// still created the directory, and what it learned about that directory is
  /// true whatever policy it asked for. Folding the verdict in only after the
  /// configuration guard drops it on exactly the path where this acquire never
  /// returns, and the live writer is the last thing left that could report it.
  func testADirectoryVerdictSurvivesAnAcquireThatIsRejectedForItsPolicy() throws {
    LogSecureFile.injectDirectoryProtectionFaultForTesting(.protection, under: root)

    let registry = LogWriterRegistry.isolated()
    let parked = DispatchSemaphore(value: 0)
    let mayProceed = DispatchSemaphore(value: 0)

    var parkedOnce = false
    let parkLock = NSLock()
    registry.afterResolveForTesting = {
      parkLock.lock()
      let shouldPark = !parkedOnce
      parkedOnce = true
      parkLock.unlock()
      guard shouldPark else { return }
      parked.signal()
      mayProceed.wait()
    }

    // The winner asks for a policy the publisher will not agree to.
    var winnerError: Error?
    let winnerDone = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      do {
        _ = try registry.acquire(
          path: self.logURL.path,
          policy: LogRotationPolicy(maxFileSizeBytes: 4096),
          lineFramed: true)
      } catch {
        winnerError = error
      }
      winnerDone.signal()
    }

    XCTAssertEqual(parked.wait(timeout: .now() + .seconds(5)), .success)

    let publisher = try registry.acquire(
      path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)

    mayProceed.signal()
    XCTAssertEqual(winnerDone.wait(timeout: .now() + .seconds(5)), .success)

    XCTAssertEqual(winnerError as? LogWriterError, .configConflict,
                   "the mismatched policy must still be refused")
    XCTAssertNotEqual(
      publisher.status().degraded & LogDegradation.protection.rawValue, 0,
      "the rejected acquire took the directory's only verdict with it")

    _ = publisher.close(deadlineMs: 1000)
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

  // MARK: - One process at a time

  /// The boundary this exists to enforce.
  ///
  /// Two processes appending to one log file interleave mid-record and run two
  /// rotation schedules over the same names — the collision the registry
  /// prevents inside one process, arriving from outside it, where a registry
  /// cannot see it. Nothing here makes cross-process *writing* work; it makes
  /// the second writer fail loudly instead of quietly corrupting the first
  /// one's file.
  ///
  /// A second registry in this process is the stand-in for a second process:
  /// `flock` belongs to the open file description, not to the process, so a
  /// second `open` of the same path is refused here exactly as it would be
  /// across a process boundary.
  func testASecondWriterOnTheSameFileIsRefused() throws {
    _ = try makeHandle()

    let rival = LogWriterRegistry.isolated()
    XCTAssertThrowsError(try rival.acquire(path: logURL.path, policy: LogRotationPolicy(),
                                           lineFramed: true)) { error in
      XCTAssertEqual(error as? LogWriterError, .locked)
    }
  }

  func testTheFileCanBeTakenAgainOnceTheFirstWriterLetsGo() throws {
    let first = try makeHandle()
    _ = first.close(deadlineMs: 1000)

    // Not just "does not throw": the replacement has to be able to write.
    let rival = LogWriterRegistry.isolated()
    let second = try rival.acquire(path: logURL.path, policy: LogRotationPolicy(),
                                   lineFramed: true)
    XCTAssertTrue(second.appendBatch("after\n", entryCount: 1).accepted)
    _ = second.close(deadlineMs: 1000)
  }

  /// The lock lives on a file of its own, and that is load-bearing.
  ///
  /// `flock` follows the inode. Held on the active log file it would ride the
  /// rename into the archive at the first rotation and leave the live file
  /// unguarded — so the exclusion would silently stop excluding at exactly the
  /// moment the file is busiest.
  func testRotationDoesNotCarryTheLockAwayWithTheArchivedFile() throws {
    let handle = try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 64, maxArchivedFilesCount: 5))
    for _ in 0..<6 { write(handle, String(repeating: "x", count: 40) + "\n") }
    XCTAssertFalse(archiveNames().isEmpty, "nothing rotated, so this asserted nothing")

    let rival = LogWriterRegistry.isolated()
    XCTAssertThrowsError(try rival.acquire(path: logURL.path, policy: LogRotationPolicy(maxFileSizeBytes: 64, maxArchivedFilesCount: 5),
                                           lineFramed: true)) { error in
      XCTAssertEqual(error as? LogWriterError, .locked)
    }
  }

  /// A purge deletes every log byte and leaves the lock, which holds none.
  ///
  /// Unlinking it would be worse than useless: `flock` lives on the inode, so
  /// removing the name while a writer holds it lets the next process create a
  /// fresh file, lock that one, and append alongside the first.
  func testAPurgeLeavesTheExclusionInPlaceAndInForce() throws {
    let handle = try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 64, maxArchivedFilesCount: 5))
    for _ in 0..<6 { write(handle, String(repeating: "x", count: 40) + "\n") }

    XCTAssertTrue(handle.clearLogs(deadlineMs: 2000).durable)

    let lock = logsDirectory.appendingPathComponent(LogWriter.lockName("app.log"))
    XCTAssertTrue(FileManager.default.fileExists(atPath: lock.path),
                  "the purge took the exclusion file with it")
    XCTAssertEqual((try? Data(contentsOf: lock))?.count, 0,
                   "and it must never have held a byte of log data")

    let rival = LogWriterRegistry.isolated()
    XCTAssertThrowsError(try rival.acquire(path: logURL.path, policy: LogRotationPolicy(maxFileSizeBytes: 64, maxArchivedFilesCount: 5),
                                           lineFramed: true)) { error in
      XCTAssertEqual(error as? LogWriterError, .locked, "the purge dropped the exclusion")
    }
  }

  func testTheLockFileIsNotOfferedToAnyoneCollectingLogs() throws {
    let handle = try makeHandle()
    write(handle, "hello\n")

    let name = LogWriter.lockName("app.log")
    XCTAssertTrue(names().contains(name), "the lock file was never created")
    XCTAssertFalse(handle.logFilePaths().contains { $0.hasSuffix(name) },
                   "a collector would try to read an empty exclusion file")
    XCTAssertFalse(LogWriter.isArchiveName(name, baseName: "app.log"))
    XCTAssertFalse(LogWriter.isArtifactName(name, baseName: "app.log"),
                   "a purge would delete it")
  }

  /// A writer that never finished being built must not keep the file locked.
  ///
  /// The lock is taken before the append open, so an open that fails leaves a
  /// descriptor with nothing to release it — and a log file locked for the life
  /// of the process by a writer that does not exist is the worst outcome this
  /// whole feature could produce.
  ///
  /// **What this does not prove:** which of the two releases satisfied it. A
  /// class whose `init` throws after full initialization does get a `deinit`,
  /// and removing the explicit `defer` leaves this green — measured, not
  /// assumed. The `defer` is there so the property stops depending on that: one
  /// stored `let` added below the lock acquisition and `deinit` would no longer
  /// run, and this test would keep passing right up until it did not.
  func testAWriterThatFailsToOpenGivesTheLockBack() throws {
    // A directory where the log file goes. Resolution is happy with it — it is
    // not a symlink — and the append open is not.
    try FileManager.default.createDirectory(at: logURL, withIntermediateDirectories: true)

    XCTAssertThrowsError(try makeHandle())

    switch LogWriter.takeExclusiveLock(for: logURL) {
    case .acquired(let fd, _):
      flock(fd, LOCK_UN)
      Darwin.close(fd)
    case .taken:
      XCTFail("the failed writer is still holding the lock")
    case .impossible:
      XCTFail("the lock could not be taken at all, so this asserted nothing")
    }
  }

  /// A symlink where the lock file goes is not followed.
  ///
  /// Following it would put the lock — and the mode the writer applies — on a
  /// file nobody chose, and could quietly make two unrelated paths exclude each
  /// other. The answer is no exclusion rather than the wrong exclusion.
  func testASymlinkedLockPathIsNotFollowed() throws {
    let target = root.appendingPathComponent("elsewhere")
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(
      at: logsDirectory.appendingPathComponent(LogWriter.lockName("app.log")),
      withDestinationURL: target)

    let handle = try makeHandle()

    XCTAssertTrue(write(handle, "still here\n").accepted, "logging must keep working")
    XCTAssertTrue(LogDegradation(rawValue: handle.status().degraded).contains(.exclusivity))
    XCTAssertFalse(FileManager.default.fileExists(atPath: target.path),
                   "the writer created the symlink's target instead of refusing")
  }

  /// A filesystem that will not lock is a degradation, not a failure.
  ///
  /// Refusing to log because the storage cannot exclude would be a far worse
  /// answer than logging without the guarantee — so the bit goes up, the caller
  /// can read it, and the writer carries on. Reached here by putting a
  /// *directory* where the lock file goes, which is a real filesystem refusing a
  /// real open; the other route to the same decision is a mount whose `flock`
  /// answers `EOPNOTSUPP`, which no local temp directory will do.
  func testAFileThatCannotBeLockedDegradesRatherThanRefusingToLog() throws {
    try FileManager.default.createDirectory(
      at: logsDirectory.appendingPathComponent(LogWriter.lockName("app.log")),
      withIntermediateDirectories: true)

    let handle = try makeHandle()

    XCTAssertTrue(write(handle, "still here\n").accepted, "logging must keep working")
    XCTAssertTrue(LogDegradation(rawValue: handle.status().degraded).contains(.exclusivity),
                  "and the caller has to be able to find out")
  }

  /// Acquiring returns without waiting for the retention sweep, and the
  /// registry lock is free while that sweep runs.
  ///
  /// The sweep is unbounded directory I/O — it lists, prunes by age, by count
  /// and by total size — and it used to run inline inside `init`, which the
  /// registry calls **with its lock held**. So opening one file with a large
  /// backlog to prune stalled every other file's acquire and release, including
  /// a close with a deadline it had promised to keep.
  ///
  /// Both halves are asserted here rather than in two tests, because on iOS
  /// they were always the same fact: the sweep ran on the acquiring thread, so
  /// "the open waited" and "the lock was held" were one event.
  ///
  /// The gated acquire runs on its **own thread**, and that is load-bearing
  /// rather than tidy. Measuring a second acquire after the first has returned
  /// proves nothing about the lock: a first acquire that waited would simply
  /// have finished waiting by then. The second acquire has to be attempted
  /// while the first is still inside `registry.acquire`, which needs two
  /// threads. It is also what keeps the inline-sweep mutation from deadlocking
  /// the suite — with the sweep back on the acquiring thread, that thread is
  /// this test's own, and it could never reach the release below.
  ///
  /// What this does not prove: that the sweep *completes* before the first
  /// append lands. That follows from the queue being serial, which is a
  /// construction argument rather than a tested one.
  func testAcquireDoesNotWaitForTheOpenSweep() throws {
    let held = Latch()
    defer { held.release() }
    let inSweep = DispatchSemaphore(value: 0)
    let acquired = AcquireOutcome()
    let registry: LogWriterRegistry = self.registry
    let slowPath = logsDirectory.appendingPathComponent("slow.log").path

    DispatchQueue.global().async {
      let began = Date()
      let handle = try? registry.acquire(
        path: slowPath,
        policy: LogRotationPolicy(),
        lineFramed: true,
        openSweepGate: {
          inSweep.signal()
          held.wait()
        }
      )
      acquired.finish(handle: handle, elapsed: Date().timeIntervalSince(began))
    }

    XCTAssertEqual(inSweep.wait(timeout: .now() + 10), .success, "the sweep never reached its gate")
    // Insurance against the mutation: with the sweep awaited inline again, the
    // thread above is stuck inside `acquire` holding the lock, and the acquire
    // below never returns — this turns that hang into a red run.
    held.releaseAfter(3)

    // The sweep is provably still running — it is sitting in the gate — and the
    // lock it would have held is free: a different path opens and closes.
    let otherBegan = Date()
    let other = try registry.acquire(
      path: logsDirectory.appendingPathComponent("other.log").path,
      policy: LogRotationPolicy(),
      lineFramed: true
    )
    _ = other.close(deadlineMs: 1000)
    XCTAssertLessThan(
      Date().timeIntervalSince(otherBegan), 2.0,
      "a gated sweep on one file held the registry lock against another")

    held.release()
    XCTAssertEqual(acquired.done.wait(timeout: .now() + 10), .success,
                   "the gated acquire never returned")
    let outcome = acquired.read()
    XCTAssertLessThan(outcome.elapsed, 2.0, "acquire waited for the retention sweep")
    // Not `makeHandle`, because this needed the gate — so the close here is
    // what `makeHandle`'s teardown would have done.
    if let slow = outcome.handle { _ = slow.close(deadlineMs: 1000) }
  }

  /// Moving the sweep off the acquiring thread changed an externally visible
  /// contract, so the new contract gets pinned rather than left implied.
  ///
  /// Open used to guarantee the sweep had *finished*. It now guarantees only
  /// that it is queued, which means a `getStatus()` taken right after opening
  /// can legitimately report the state from before the sweep ran — a caller
  /// that opens and immediately checks `degraded` may see a clean status and a
  /// degraded one a moment later, with nothing having gone wrong in between.
  /// That is worth a test because it is the kind of difference that otherwise
  /// gets discovered as a flake in somebody else's suite.
  ///
  /// The sweep is made to *fail* here, because a sweep that succeeds leaves no
  /// mark on the status and the two moments would be indistinguishable.
  ///
  /// What this does not prove: that the window is short. There is no bound on
  /// how long the queued sweep takes to reach the front — that is the cost the
  /// change deliberately accepts in exchange for not paying it inside the
  /// registry lock.
  func testStatusRightAfterOpenCanPredateTheSweep() throws {
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    // An orphaned compression that cannot be deleted. The sweep will try, fail,
    // and record `.prune` — which is the observable the two moments differ on.
    let orphan = logsDirectory.appendingPathComponent(
      LogWriter.supportStagingName("app.log"))
    try Data("truncated".utf8).write(to: orphan)
    TestFlags.makeImmutable(orphan)

    let held = Latch()
    defer { held.release() }
    let inSweep = DispatchSemaphore(value: 0)
    // Insurance against a revert to the inline sweep: that would block the
    // acquire below on this test's own thread, and the gate would never open.
    // Opening it on a timer makes that a failed assertion instead of a hang.
    held.releaseAfter(3)

    let handle = try registry.acquire(
      path: logURL.path,
      policy: LogRotationPolicy(),
      lineFramed: true,
      openSweepGate: {
        inSweep.signal()
        held.wait()
      }
    )
    addTeardownBlock { _ = handle.close(deadlineMs: 1000) }

    XCTAssertEqual(inSweep.wait(timeout: .now() + 10), .success, "the sweep never reached its gate")
    XCTAssertFalse(
      LogDegradation(rawValue: handle.status().degraded).contains(.prune),
      "the sweep is still sitting in its gate — it cannot have reported a failure yet")

    held.release()
    handle.writerForTesting.settleForTesting()
    XCTAssertTrue(
      LogDegradation(rawValue: handle.status().degraded).contains(.prune),
      "once the sweep runs, the deletion it could not do is on the status")
  }

  /// Carries a gated acquire's result back from the thread that ran it.
  private final class AcquireOutcome: @unchecked Sendable {
    let done = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var handle: LogFileHandle?
    private var elapsed: TimeInterval = 0

    func finish(handle: LogFileHandle?, elapsed: TimeInterval) {
      lock.lock()
      self.handle = handle
      self.elapsed = elapsed
      lock.unlock()
      done.signal()
    }

    func read() -> (handle: LogFileHandle?, elapsed: TimeInterval) {
      lock.lock()
      defer { lock.unlock() }
      return (handle, elapsed)
    }
  }

  /// A gate that latches open, so a second `release()` is harmless and the
  /// number of waiters need not be known in advance.
  private final class Latch: @unchecked Sendable {
    private let condition = NSCondition()
    private var open = false

    func wait() {
      condition.lock()
      while !open { condition.wait() }
      condition.unlock()
    }

    func release() {
      condition.lock()
      open = true
      condition.broadcast()
      condition.unlock()
    }

    /// Opens the gate after `seconds`, so a test that would otherwise hang on a
    /// regression fails instead.
    func releaseAfter(_ seconds: TimeInterval) {
      DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { [self] in release() }
    }
  }

  /// A purge that arrives after the close barrier still deletes, and does not
  /// reopen.
  ///
  /// **A parity anchor, not a fix.** iOS has always behaved this way: the block
  /// is enqueued on the serial queue, so it lands *behind* the terminate
  /// barrier and runs after it rather than being refused by it. Android, whose
  /// executor refuses submissions once shut down, caught that refusal in a
  /// blanket handler and through 0.2.0 deleted nothing while reporting
  /// `durable: false`.
  ///
  /// So this pins the answer Android has now been changed to give, on the side
  /// that already gave it — which is the half of a parity claim that otherwise
  /// nobody checks. Deliberately reaches the writer directly: the handle is
  /// closed by this point and refuses on its own, which is a different rule
  /// tested elsewhere.
  func testAPurgeAfterTheCloseBarrierStillDeletes() throws {
    let handle = try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 64))
    let writer = handle.writerForTesting
    for _ in 0..<6 { write(handle, String(repeating: "x", count: 39) + "\n") }
    XCTAssertFalse(archiveNames().isEmpty, "the test needs artifacts to delete")

    _ = handle.close(deadlineMs: 1000)

    let (outcome, _) = writer.clearLogs(deadlineMs: 2000)

    XCTAssertTrue(outcome.durable, "a post-close purge deleted nothing")
    XCTAssertGreaterThan(outcome.deletedCount, 0)
    XCTAssertEqual(outcome.failedPaths, [])
    XCTAssertFalse(
      outcome.rebound, "a purge after the barrier must not reopen the file it just deleted")
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: logURL.path),
      "the purge reopened the file it had just deleted")
    XCTAssertEqual(
      names().filter { LogWriter.isArtifactName($0, baseName: "app.log") }, [],
      "artifacts survived a purge that reported durable")
  }
}
