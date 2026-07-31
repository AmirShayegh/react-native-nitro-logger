import Foundation
import XCTest

@testable import NitroLoggerFileWriter

/// `FileSinkAnswers` on everything the shared row table cannot ask.
///
/// The table covers the nine spec ops in the two states that produce no handle,
/// and `FileSinkLifecycleRowsTests` drives it against this same object. What is
/// left — and what is here — is the open path, the refusal messages, the
/// argument guards, and the one lifecycle state the table deliberately does not
/// carry: a sink whose `open` threw.
///
/// That third state matters more than its size suggests. The two table modes
/// cannot distinguish `snapshot()` from `artifactSource()` as the source of
/// `deleteSupportBundle`'s answer — a never-opened sink has neither a handle nor
/// a path, and an opened-then-closed sink has a path and `created`, so both
/// readings agree in both modes. The bug that shipped was exactly that
/// substitution, and only a half-failed open tells them apart. See
/// `testASinkWhoseOpenFailedBeforeResolutionCannotVouchForAnything`.
final class FileSinkAnswersTests: LogWriterTestCase {

  private func answers() -> FileSinkAnswers {
    FileSinkAnswers(registry: registry)
  }

  // MARK: - The default directory

  func testTheDefaultDirectoryIsTheOneTheSecuringLayerDeclinesToClaim() {
    // Two spellings of `<Library>/Logs` is how the directory handed out stops
    // being the directory whose claim is declined.
    XCTAssertEqual(answers().defaultLogDirectory, LogSecureFile.conventionalLogDirectory.path)
  }

  // MARK: - Refusing a second open

  func testASecondOpenIsRefusedAsAlreadyOpen() throws {
    let sink = answers()
    try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    defer { _ = sink.close(deadlineMs: 1000) }

    XCTAssertThrowsError(
      try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    ) { error in
      XCTAssertEqual(
        error as? FileSinkOpenRefusal, FileSinkOpenRefusal(message: FileSinkMessages.alreadyOpen))
    }
  }

  func testAnOpenAfterCloseIsAllowed() throws {
    // Closed is not disposed. A destination that purges and rebinds opens the
    // same object again, and refusing that would end the sink at its first
    // compliance purge.
    let sink = answers()
    try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    _ = sink.close(deadlineMs: 1000)

    XCTAssertNoThrow(
      try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true))
    _ = sink.close(deadlineMs: 1000)
  }

  func testADisposedSinkRefusesToOpen() throws {
    let sink = answers()
    sink.releaseHandle()

    XCTAssertThrowsError(
      try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    ) { error in
      XCTAssertEqual(
        error as? FileSinkOpenRefusal, FileSinkOpenRefusal(message: FileSinkMessages.disposed))
    }
  }

  // MARK: - The failure mapper

  /// Every `LogWriterError` maps to its own message, and `nil` maps to the
  /// generic one.
  ///
  /// Driven off the enum directly rather than by provoking each failure through
  /// the registry: `locked` needs a second OS process and `stillClosing` needs a
  /// close held open, and a mapper tested through only the two failures that are
  /// easy to stage is a mapper with untested arms. The end-to-end test below
  /// proves the mapper is actually on the path.
  func testEveryAcquisitionFailureMapsToItsOwnMessage() {
    let expected: [(LogWriterError, String)] = [
      (.configConflict, FileSinkMessages.configConflict),
      (.symlinkEscape, FileSinkMessages.symlinkEscape),
      (.locked, FileSinkMessages.locked),
      (.stillClosing, FileSinkMessages.stillClosing),
    ]
    for (error, message) in expected {
      XCTAssertEqual(FileSinkAnswers.openFailure(error).message, message)
    }

    // Not in the list above because it carries a payload — a path, or an
    // `errno` description that contains one — which is dropped rather than
    // forwarded into a string that ends up wherever the app logs.
    XCTAssertEqual(
      FileSinkAnswers.openFailure(LogWriterError.openFailed("/Users/someone/app.log")).message,
      FileSinkMessages.openFailed)

    // An error from somewhere else is still an open failure, not a crash.
    XCTAssertEqual(
      FileSinkAnswers.openFailure(CocoaError(.fileNoSuchFile)).message,
      FileSinkMessages.openFailed)
  }

  func testTheMapperIsOnTheOpenPath() throws {
    // A second sink on the same path with a different configuration is the one
    // acquisition failure this target can stage directly, and it is enough to
    // prove `open` routes its throw through `openFailure` rather than letting
    // the raw error out.
    let first = answers()
    try first.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    defer { _ = first.close(deadlineMs: 1000) }

    let second = answers()
    XCTAssertThrowsError(
      try second.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: false)
    ) { error in
      XCTAssertEqual(
        error as? FileSinkOpenRefusal,
        FileSinkOpenRefusal(message: FileSinkMessages.configConflict))
    }
  }

  /// A failed open forfeits vacuous success, and does not get it back.
  ///
  /// This is the state the shared table cannot carry, and the only one that
  /// distinguishes the two readings of "is my bundle gone". `acquire` creates
  /// the log directory before it opens the file, so a throw is not evidence
  /// that nothing was written — and a `deleteSupportBundle` that answered from
  /// `artifactSource()` would say `true` here, over a directory it had just
  /// made, and delete the caller's obligation to retry.
  func testASinkWhoseOpenFailedBeforeResolutionCannotVouchForAnything() throws {
    // The failure has to land *before* `onResolve`, which is what makes this
    // the distinguishing case: `resolve` throwing leaves `openedPath` nil while
    // `beginOpen` has already set `created`. A `configConflict` would not do —
    // it is raised after resolution, so both readings answer alike and the
    // substitution survives. (Verified: with the mutant applied, a conflict-
    // based version of this test passed.)
    try FileManager.default.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
    let elsewhere = root.appendingPathComponent("elsewhere.log")
    FileManager.default.createFile(atPath: elsewhere.path, contents: Data())
    try FileManager.default.createSymbolicLink(at: logURL, withDestinationURL: elsewhere)

    let sink = answers()
    XCTAssertThrowsError(
      try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    ) { error in
      XCTAssertEqual(
        error as? FileSinkOpenRefusal,
        FileSinkOpenRefusal(message: FileSinkMessages.symlinkEscape))
    }

    // Nothing resolved, so there is no path to enumerate — and that is exactly
    // why `deleteSupportBundle` must not answer from `artifactSource()`.
    XCTAssertEqual(sink.getLogFilePaths(), [])

    // `acquire` creates the log directory before it opens the file, so a throw
    // is not evidence that nothing was written. Answering `true` here — which
    // is what "no path recorded" would say — deletes the caller's obligation to
    // retry over a directory this sink may have just made.
    XCTAssertFalse(
      sink.deleteSupportBundle(deadlineMs: 1000),
      "no path recorded is not the same as nothing to delete")
    XCTAssertFalse(sink.clearLogs(deadlineMs: 1000).durable)
    XCTAssertFalse(sink.flush(deadlineMs: 1000).durable)
    XCTAssertFalse(sink.close(deadlineMs: 1000).durable)
  }

  // MARK: - Arguments

  func testANonIntegralEntryCountIsRefusedRatherThanRounded() throws {
    let sink = answers()
    try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    defer { _ = sink.close(deadlineMs: 1000) }

    // An unchecked cast of NaN or 1e30 traps, and a count that does not survive
    // the round trip cannot be trusted to describe the batch it arrived with.
    for hostile in [Double.nan, .infinity, -.infinity, 1e30, 1.5] {
      let result = sink.appendBatch(batch: "{\"m\":1}\n", entryCount: hostile)
      XCTAssertFalse(result.accepted, "entryCount \(hostile) was accepted")
      XCTAssertEqual(result.rejectReason, .failed)
    }

    // And the batch really was refused, not merely reported as refused.
    XCTAssertTrue(sink.flush(deadlineMs: 1000).durable)
    XCTAssertEqual(sink.getStatus().queuedBytes, 0)
  }

  func testAnAbsentLineFramedFlagIsAbsentRatherThanTrue() throws {
    // Without a declared one-record-per-line contract the startup scan must not
    // trim a trailing record: it cannot tell a torn one from an intentional
    // newline. `nil` therefore has to reach the registry as `false`, and a sink
    // that defaulted it to `true` would silently discard a caller's last line
    // on the next open.
    let sink = answers()
    try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: nil)
    defer { _ = sink.close(deadlineMs: 1000) }

    // A second sink declaring `false` agrees with the first; declaring `true`
    // is a configuration conflict. That is the only observable difference, and
    // it is the registry's own definition of the flag.
    let agreeing = answers()
    XCTAssertNoThrow(
      try agreeing.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: false))
    _ = agreeing.close(deadlineMs: 1000)

    let disagreeing = answers()
    XCTAssertThrowsError(
      try disagreeing.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true))
  }

  // MARK: - With a live handle

  func testALiveSinkDelegatesEveryOpToItsHandle() throws {
    let sink = answers()
    try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    defer { _ = sink.close(deadlineMs: 1000) }

    let accepted = sink.appendBatch(batch: "{\"m\":1}\n", entryCount: 1)
    XCTAssertTrue(accepted.accepted)
    XCTAssertNil(accepted.rejectReason)

    XCTAssertTrue(sink.flush(deadlineMs: 1000).durable)
    // The bytes are on disk, which is what makes the rest of this test about
    // the handle rather than about an empty directory.
    XCTAssertEqual(sink.getLogFilePaths(), [logURL.path])

    let collected = sink.collectLogs(deadlineMs: 1000, maxTotalBytes: 1_000_000)
    XCTAssertTrue(collected.complete)
    XCTAssertGreaterThan(collected.byteCount, 0)
    XCTAssertEqual(collected.sourceFileCount, 1)
    XCTAssertTrue(sink.deleteSupportBundle(deadlineMs: 1000))

    // A live purge really deletes and really rebinds — the two facts the JS
    // destination reads separately before it resumes.
    let cleared = sink.clearLogs(deadlineMs: 1000)
    XCTAssertTrue(cleared.durable)
    XCTAssertTrue(cleared.rebound)
    XCTAssertEqual(cleared.failedPaths, [])
    XCTAssertGreaterThan(cleared.deletedCount, 0)

    // Zeroed after a purge, not stale: this is the status a live handle
    // reports, and it comes from the handle rather than from the no-handle
    // constant, which `maintain` on a live sink also has to.
    XCTAssertEqual(
      sink.maintain(deadlineMs: 1000),
      WireSinkStatus(queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0))
  }

  func testReleaseHandleFreesTheRegistrySlotAndIsTerminal() throws {
    let sink = answers()
    try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    sink.releaseHandle()

    // The slot is free: another sink can take the same path, which it could not
    // do while the first still held it with a different configuration.
    let next = answers()
    XCTAssertNoThrow(
      try next.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: false))
    _ = next.close(deadlineMs: 1000)

    // And the disposed one stays disposed rather than becoming reusable.
    XCTAssertThrowsError(
      try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    ) { error in
      XCTAssertEqual(
        error as? FileSinkOpenRefusal, FileSinkOpenRefusal(message: FileSinkMessages.disposed))
    }
  }
}
