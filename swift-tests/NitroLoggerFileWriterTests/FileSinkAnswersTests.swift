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
      let result = sink.appendBatch(batch: "REFUSED-\(hostile)\n", entryCount: hostile)
      XCTAssertFalse(result.accepted, "entryCount \(hostile) was accepted")
      XCTAssertEqual(result.rejectReason, .failed)
    }

    // And the batch really was refused, not merely reported as refused.
    //
    // Checked against the file, not against `queuedBytes` after a flush: an
    // accepted batch is drained by that flush too, so a post-flush queue depth
    // of zero is a state both the correct and the broken implementation reach.
    // It said nothing, and this is what it was supposed to say.
    XCTAssertTrue(sink.flush(deadlineMs: 1000).durable)
    // `try`, not `try?`: a read that failed would fall back to an empty string
    // and satisfy both assertions below, which would make a log file that was
    // never created read as proof that the batch was refused.
    let written = try String(contentsOf: logURL, encoding: .utf8)
    XCTAssertFalse(written.contains("REFUSED"), "a refused batch reached the file")
    XCTAssertEqual(written, "", "nothing was accepted, so nothing should be on disk")
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

  /// Every op that has a side effect is checked by that side effect.
  ///
  /// An earlier draft asserted only the returned values, and a review pointed
  /// out that several broken implementations reach the same ones: an
  /// `appendBatch` that reports `accepted` without writing still yields a
  /// non-empty gzip and one source file from the empty open log, a
  /// `deleteSupportBundle` hardcoded to `true` is indistinguishable from one
  /// that deleted, and a `clearLogs` that fabricated its count passes a
  /// `deletedCount > 0`. So each one below is now asked of the filesystem
  /// instead.
  func testALiveSinkDelegatesEveryOpToItsHandle() throws {
    let sink = answers()
    try sink.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    defer { _ = sink.close(deadlineMs: 1000) }

    let accepted = sink.appendBatch(batch: "{\"m\":1}\n", entryCount: 1)
    XCTAssertTrue(accepted.accepted)
    XCTAssertNil(accepted.rejectReason)

    XCTAssertTrue(sink.flush(deadlineMs: 1000).durable)
    // The record, not merely a file. `accepted` is a claim about bytes, and
    // this is the bytes.
    XCTAssertEqual(try String(contentsOf: logURL, encoding: .utf8), "{\"m\":1}\n")
    XCTAssertEqual(sink.getLogFilePaths(), [logURL.path])

    let collected = sink.collectLogs(deadlineMs: 1000, maxTotalBytes: 1_000_000)
    XCTAssertTrue(collected.complete)
    XCTAssertEqual(collected.sourceFileCount, 1)
    XCTAssertNotEqual(collected.path, "")
    // The bundle is where it says it is, and it is what it says it is: a
    // `byteCount` alone is satisfied by a gzip header over an empty file.
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: collected.path),
      "collect returned a path with nothing at it")
    let onDisk = try FileManager.default.attributesOfItem(atPath: collected.path)[.size] as? Int
    XCTAssertEqual(Double(onDisk ?? -1), collected.byteCount)
    // And it carries the log. A size that agrees with `byteCount` is still
    // satisfied by a valid gzip over nothing, together with a fabricated
    // `sourceFileCount` — which is exactly the bundle a support flow would
    // upload and a reviewer would open to find empty.
    XCTAssertEqual(try gunzip(URL(fileURLWithPath: collected.path)), "{\"m\":1}\n")

    XCTAssertTrue(sink.deleteSupportBundle(deadlineMs: 1000))
    // The assertion that stops `return true` passing: the bundle is gone.
    XCTAssertFalse(
      FileManager.default.fileExists(atPath: collected.path),
      "deleteSupportBundle reported success over a bundle still on disk")

    // A live purge really deletes and really rebinds — the two facts the JS
    // destination reads separately before it resumes.
    let cleared = sink.clearLogs(deadlineMs: 1000)
    XCTAssertTrue(cleared.durable)
    XCTAssertTrue(cleared.rebound)
    XCTAssertEqual(cleared.failedPaths, [])
    // Exactly one, not merely more than none: there is exactly one artifact
    // here, so `> 0` is satisfied by any fabricated number. A count that does
    // not describe what was deleted is what a compliance caller reports upward.
    XCTAssertEqual(cleared.deletedCount, 1)
    // `durable` means every artifact is gone. A fabricated count does not.
    XCTAssertEqual(
      try String(contentsOf: logURL, encoding: .utf8), "",
      "a durable purge left the caller's records on disk")

    // And `rebound` means writable, not merely reopened. A sink that reported
    // it without a usable file accepts every later record and drops it.
    XCTAssertTrue(sink.appendBatch(batch: "{\"m\":2}\n", entryCount: 1).accepted)
    XCTAssertTrue(sink.flush(deadlineMs: 1000).durable)
    XCTAssertEqual(try String(contentsOf: logURL, encoding: .utf8), "{\"m\":2}\n")
  }

  /// `getStatus` and `maintain` read the handle, not the no-handle constant.
  ///
  /// Both return a zeroed status on a healthy idle sink, which is also what a
  /// body that ignored the handle entirely would return — so a live sink in a
  /// *quiet* state cannot tell the two apart. This one is not quiet: the
  /// directory carries an injected protection shortfall, so the handle's own
  /// status has a bit set that the no-handle constant does not have.
  ///
  /// The control is the point. Without it this asserts `degraded != 0` against
  /// a mask that several unrelated routes can set — on macOS an ordinary temp
  /// directory already fails backup exclusion — and would pass with the
  /// injection discarded.
  func testGetStatusAndMaintainReportTheHandlesOwnState() throws {
    // Separate directories, and the fault injected before either is created:
    // securing happens once, when the directory is made, so a fault arriving
    // afterwards reaches nothing.
    let clean = root.appendingPathComponent("clean")
    let faulty = root.appendingPathComponent("faulty")
    LogSecureFile.injectDirectoryProtectionFaultForTesting(.protection, under: faulty)

    let control = answers()
    try control.open(
      path: clean.appendingPathComponent("app.log").path,
      policy: LogRotationPolicy(), lineFramed: true)
    let baseline = control.getStatus().degraded
    _ = control.close(deadlineMs: 1000)

    let sink = answers()
    try sink.open(
      path: faulty.appendingPathComponent("app.log").path,
      policy: LogRotationPolicy(), lineFramed: true)
    defer { _ = sink.close(deadlineMs: 1000) }

    let status = sink.getStatus()
    XCTAssertNotEqual(
      status.degraded, baseline,
      "the injected shortfall changed nothing, so this test distinguishes nothing")
    XCTAssertNotEqual(status.degraded, 0)
    // And `maintain` reads the same handle rather than the constant.
    XCTAssertEqual(sink.maintain(deadlineMs: 1000).degraded, status.degraded)
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
