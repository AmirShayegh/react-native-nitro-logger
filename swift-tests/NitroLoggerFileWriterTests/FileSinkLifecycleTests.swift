import Foundation
import XCTest
@testable import NitroLoggerFileWriter

/// Derived from the transition table on `FileSinkLifecycle`, row by row.
///
/// The order matters: the table was written first, and these assert what it
/// says rather than what the implementation happens to do. Where the two
/// adapters previously disagreed, the test pins the resolved answer and names
/// which platform used to give the other one.
final class FileSinkLifecycleTests: LogWriterTestCase {

  // MARK: - Never opened

  func testAFreshSinkIsIdleAndCanClaimSuccessVacuously() {
    let lifecycle = FileSinkLifecycle()
    XCTAssertEqual(lifecycle.currentState, .idle)
    XCTAssertNil(lifecycle.current())
    XCTAssertTrue(lifecycle.vacuousSuccess,
                  "nothing was ever accepted, so there is nothing to vouch for")
  }

  /// The bit that separates "nothing exists" from "files exist and are out of
  /// reach" is set before the attempt, not after it succeeds.
  ///
  /// `acquire` creates the log directory and can then fail on the file itself,
  /// so a throw is not evidence that nothing was written. Setting it afterwards
  /// would let a sink whose open failed halfway report a durable purge over a
  /// directory it had just created.
  func testClaimingTheRightToOpenImmediatelyForfeitsVacuousSuccess() {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())

    XCTAssertEqual(lifecycle.currentState, .opening)
    XCTAssertFalse(lifecycle.vacuousSuccess,
                   "the directory may already exist; this sink can no longer say nothing does")
  }

  // MARK: - Refusing a second open

  func testASecondOpenIsRefusedWhileTheFirstIsStillAcquiring() {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())

    // Refused rather than allowed to race: the loser's handle would be
    // unreachable, and unreachable means a later purge never deletes its files.
    XCTAssertFalse(lifecycle.beginOpen())
    XCTAssertEqual(lifecycle.currentState, .opening)
  }

  func testASecondOpenIsRefusedOnceAHandleIsInstalled() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .installed)

    XCTAssertEqual(lifecycle.currentState, .open)
    XCTAssertFalse(lifecycle.beginOpen())
  }

  // MARK: - Open failure

  /// A failed open lands in `closed`, and stays forfeit.
  ///
  /// Not a state of its own: it is not observably different from a sink that
  /// opened and closed, and treating it as better is exactly the reasoning
  /// `mayHaveArtifacts` exists to stop.
  func testAFailedOpenReturnsToClosedWithoutRegainingVacuousSuccess() {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    lifecycle.failOpen()

    XCTAssertEqual(lifecycle.currentState, .closed)
    XCTAssertFalse(lifecycle.vacuousSuccess,
                   "acquire creates the directory before it opens the file")
    XCTAssertTrue(lifecycle.beginOpen(), "and a retry is allowed")
  }

  // MARK: - Close

  func testClosingHandsTheHandleBackExactlyOnce() throws {
    let lifecycle = FileSinkLifecycle()
    let handle = try makeHandle()
    XCTAssertTrue(lifecycle.beginOpen())
    XCTAssertEqual(lifecycle.finishOpen(handle), .installed)

    XCTAssertTrue(lifecycle.beginClose().handle === handle,
                  "the closing caller takes ownership")
    XCTAssertEqual(lifecycle.currentState, .closed)
    XCTAssertNil(lifecycle.beginClose().handle,
                 "and a second close finds nothing — closing is idempotent")
    XCTAssertNil(lifecycle.current())
  }

  /// Closing releases a handle; it does not unmake files.
  func testClosingNeverRestoresVacuousSuccess() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .installed)
    _ = lifecycle.beginClose()

    XCTAssertFalse(lifecycle.vacuousSuccess,
                   "the files are still on disk and this object cannot reach them")
  }

  func testAClosedSinkCanBeOpenedAgain() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .installed)
    _ = lifecycle.beginClose()

    XCTAssertTrue(lifecycle.beginOpen(), "close is not terminal; dispose is")
  }

  // MARK: - Close racing open

  /// Close wins, and the acquisition that lands afterwards is discarded.
  ///
  /// Letting the open install and relying on the caller to close again loses
  /// the descriptor whenever the caller does not: a live writer holding the
  /// registry slot with nothing able to reach it.
  func testACloseArrivingDuringAcquisitionCancelsTheOpen() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())

    XCTAssertNil(lifecycle.beginClose().handle, "there is no handle to hand back yet")
    XCTAssertEqual(lifecycle.currentState, .closePending,
                   "but the close must be remembered, or the open installs into a closed sink")

    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .abandon)
    XCTAssertEqual(lifecycle.currentState, .closed)
    XCTAssertNil(lifecycle.current(), "nothing was installed")
  }

  /// The cancellation is spent once. A close during acquisition must not
  /// silently cancel the *next* open too.
  func testACancelledOpenDoesNotCancelTheOneAfterIt() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    _ = lifecycle.beginClose()
    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .abandon)

    XCTAssertTrue(lifecycle.beginOpen())
    let second = try makeHandle(at: logsDirectory.appendingPathComponent("second.log"))
    XCTAssertEqual(lifecycle.finishOpen(second), .installed)
    XCTAssertTrue(lifecycle.current() === second)
  }

  /// A *second* close before the acquisition lands must not free the sink.
  ///
  /// The subtle one. If the second close moved the state on to `closed`, a new
  /// open could start while the first acquisition was still in flight — and
  /// that acquisition, landing into the new open's `opening` state, would
  /// install ITS handle. The caller that asked for the second path would be
  /// handed a sink pointing at the first, with its own handle abandoned: a
  /// writer for the wrong file, under the wrong rotation policy, and no error
  /// anywhere. Closing twice is ordinary — JavaScript can do it, and `dispose`
  /// does it too — so the cancellation has to survive being repeated.
  func testASecondCloseDuringAcquisitionDoesNotFreeTheSink() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())

    XCTAssertNil(lifecycle.beginClose().handle)
    XCTAssertNil(lifecycle.beginClose().handle)
    XCTAssertEqual(lifecycle.currentState, .closePending,
                   "the pending cancellation was spent by the repeat close")
    XCTAssertFalse(lifecycle.beginOpen(),
                   "an open here would be filled by the acquisition still in flight")

    // The first acquisition finally lands, and is still discarded.
    let stale = try makeHandle()
    XCTAssertEqual(lifecycle.finishOpen(stale), .abandon)
    XCTAssertNil(lifecycle.current())

    // Only now is the sink free, and the next open gets its own handle.
    XCTAssertTrue(lifecycle.beginOpen())
    let fresh = try makeHandle(at: logsDirectory.appendingPathComponent("fresh.log"))
    XCTAssertEqual(lifecycle.finishOpen(fresh), .installed)
    XCTAssertTrue(lifecycle.current() === fresh, "the stale acquisition must not be what got installed")
  }

  /// Disposing after an ordinary close, both during acquisition, still ends
  /// terminal — the repeat-close rule must not swallow the dispose.
  func testDisposingAfterACloseDuringAcquisitionIsStillTerminal() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    XCTAssertNil(lifecycle.beginClose().handle)

    XCTAssertNil(lifecycle.beginDispose().handle)
    XCTAssertEqual(lifecycle.currentState, .disposed)
    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .abandon)
    XCTAssertFalse(lifecycle.beginOpen())
  }

  /// While an open is in flight and already cancelled, another open is still
  /// refused — the sink is not free until the acquisition lands.
  func testAnOpenIsRefusedWhileACancelledAcquisitionIsStillInFlight() {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    _ = lifecycle.beginClose()

    XCTAssertEqual(lifecycle.currentState, .closePending)
    XCTAssertFalse(lifecycle.beginOpen(),
                   "the in-flight acquire has not landed; a rival would race it")
  }

  // MARK: - Dispose

  func testDisposeIsTerminalWhereCloseIsNot() throws {
    let lifecycle = FileSinkLifecycle()
    let handle = try makeHandle()
    XCTAssertTrue(lifecycle.beginOpen())
    XCTAssertEqual(lifecycle.finishOpen(handle), .installed)

    XCTAssertTrue(lifecycle.beginDispose().handle === handle)
    XCTAssertEqual(lifecycle.currentState, .disposed)
    XCTAssertFalse(lifecycle.beginOpen(), "a disposed object must not be reopened")
  }

  func testDisposingDuringAcquisitionAlsoDiscardsTheHandle() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())

    XCTAssertNil(lifecycle.beginDispose().handle)
    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .abandon,
                   "a teardown must not be handed a live writer nothing can release")
    XCTAssertEqual(lifecycle.currentState, .disposed)
  }

  func testDisposingTwiceIsHarmless() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .installed)

    XCTAssertNotNil(lifecycle.beginDispose().handle)
    XCTAssertNil(lifecycle.beginDispose().handle)
    XCTAssertEqual(lifecycle.currentState, .disposed)
  }

  // MARK: - The pair that must be read together

  /// "No handle, and nothing was ever created" is the one combination that is
  /// never true after an open. Reading the two fields separately lets a close
  /// land between them and produce exactly that.
  ///
  /// This is the assertion the review said did not exist: reverting
  /// `durable: !created` used to leave every test in the repo green.
  func testAClosedSinkRefusesToCallAPurgeDurable() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .installed)
    _ = lifecycle.beginClose()

    let snapshot = lifecycle.snapshot()
    XCTAssertNil(snapshot.handle)
    XCTAssertFalse(snapshot.durableWithoutHandle,
                   "reporting a durable purge over these files is the worst lie this API can tell")
  }

  func testANeverOpenedSinkCallsAPurgeDurableVacuously() {
    let snapshot = FileSinkLifecycle().snapshot()
    XCTAssertNil(snapshot.handle)
    XCTAssertTrue(snapshot.durableWithoutHandle,
                  "nothing was ever created, so every artifact is gone with nothing to check")
  }

  /// A purge over a sink whose open *failed* is not durable either. `acquire`
  /// creates the directory before it opens the file, so the attempt may well
  /// have left something behind.
  func testASinkWhoseOpenFailedRefusesToCallAPurgeDurable() {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    lifecycle.failOpen()

    XCTAssertFalse(lifecycle.snapshot().durableWithoutHandle)
  }

  // MARK: - Concurrency

  /// Only one of many concurrent opens may claim the right to acquire.
  ///
  /// This is the invariant the whole type exists for: two winners means two
  /// writers on one file, and the loser's handle is unreachable — so a later
  /// purge never deletes its files.
  func testExactlyOneOfManyConcurrentOpensWins() {
    let lifecycle = FileSinkLifecycle()
    let winners = NSCounter()

    DispatchQueue.concurrentPerform(iterations: 64) { _ in
      if lifecycle.beginOpen() { winners.increment() }
    }

    XCTAssertEqual(winners.value, 1)
    XCTAssertEqual(lifecycle.currentState, .opening)
  }

  /// Repeated close and dispose from several threads must not hand the same
  /// handle to two callers — each would close it, and the second close is on a
  /// writer somebody else already gave back to the registry.
  func testConcurrentClosesHandTheHandleToExactlyOneCaller() throws {
    let lifecycle = FileSinkLifecycle()
    XCTAssertTrue(lifecycle.beginOpen())
    XCTAssertEqual(lifecycle.finishOpen(try makeHandle()), .installed)

    let takers = NSCounter()
    DispatchQueue.concurrentPerform(iterations: 64) { index in
      let taken = index.isMultiple(of: 2) ? lifecycle.beginClose().handle : lifecycle.beginDispose().handle
      if taken != nil { takers.increment() }
    }

    XCTAssertEqual(takers.value, 1)
    XCTAssertNil(lifecycle.current())
  }
}

/// A counter that is safe to bump from several threads at once.
final class NSCounter {
  private let lock = NSLock()
  private var count = 0

  func increment() {
    lock.lock()
    count += 1
    lock.unlock()
  }

  var value: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }
}
