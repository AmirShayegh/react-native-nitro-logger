import Foundation
import XCTest
@testable import NitroLoggerFileWriter

/// Pins the contract `acquire` and `LogFileHandle.close` rely on.
///
/// **`wait` returning `true` means "did not time out", not "was signalled".**
/// A pthread condition may wake a waiter with no broadcast behind it, so
/// nothing here treats a `true` as proof that a broadcast happened; each test
/// loops on a predicate held under the mutex, exactly as both production
/// callers do. A test that read `true` as "signalled" would pass on a spurious
/// wake and would be asserting something the primitive does not promise.
///
/// What these deliberately do NOT prove: behaviour across a realtime clock
/// step. A test cannot move CLOCK_REALTIME, so "an NTP jump no longer stretches
/// the wait" rests on what `pthread_cond_timedwait_relative_np` documents — a
/// relative timeout, unaffected by the calendar clock — not on an assertion
/// here. What can be pinned is the contract the callers were written against,
/// so a reimplementation that got timeout or expiry wrong fails here rather
/// than as a flaky registry test.
final class MonotonicConditionTests: XCTestCase {

  /// An already-expired deadline reports timeout without waiting — this is what
  /// makes `remaining(until:)` handing over a spent budget mean "do not wait"
  /// rather than "wait forever".
  func testAnExpiredDeadlineTimesOutImmediately() {
    let condition = MonotonicCondition()
    condition.lock()
    defer { condition.unlock() }

    let started = DispatchTime.now()
    let didNotTimeOut = condition.wait(until: started - .seconds(1))
    let elapsedMs = (DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000

    XCTAssertFalse(didNotTimeOut)
    XCTAssertLessThan(elapsedMs, 500, "an expired deadline must not wait at all")
  }

  /// With nothing to wake it, the wait ends at its deadline and says the
  /// deadline ended it. `acquire` turns exactly that into `stillClosing`.
  ///
  /// The loop is what makes this sound: a spurious wake returns `true` early,
  /// and a test that stopped there would fail a correct implementation. Only
  /// the deadline can end the loop, because no broadcast is ever sent.
  func testAnUnsignalledWaitTimesOutAtItsDeadline() {
    let condition = MonotonicCondition()
    condition.lock()
    defer { condition.unlock() }

    let started = DispatchTime.now()
    let deadline = started + .milliseconds(100)
    while condition.wait(until: deadline) {
      // Spurious wake: no broadcast has been sent, so keep waiting.
    }
    let elapsedMs = (DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000

    XCTAssertGreaterThanOrEqual(elapsedMs, 90, "the wait gave up before its deadline")
    XCTAssertLessThan(elapsedMs, 5_000, "the deadline did not end the wait")
  }

  /// A broadcast releases a waiter well before its deadline.
  ///
  /// The predicate — not `wait`'s return value — is what proves the broadcast
  /// arrived, and the elapsed time is what proves it was the broadcast rather
  /// than the deadline that ended the wait: the deadline here is ten seconds
  /// and the assertion is that waking took a fraction of it.
  func testABroadcastReleasesAWaiterBeforeTheDeadline() {
    let condition = MonotonicCondition()
    let woken = expectation(description: "waiter observed the predicate")
    var readyToProceed = false
    var waiting = false
    var elapsedMs: UInt64 = .max

    Thread.detachNewThread {
      condition.lock()
      waiting = true
      let started = DispatchTime.now()
      let deadline = started + .seconds(10)
      // Loop on the predicate: a spurious wake must not be mistaken for the
      // broadcast, and `false` here would mean the deadline won.
      while !readyToProceed && condition.wait(until: deadline) {}
      elapsedMs = (DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000
      let observed = readyToProceed
      condition.unlock()
      if observed { woken.fulfill() }
    }

    // The broadcast must not fire before the waiter is inside `wait`, or it
    // lands on nobody and this blocks for the full ten seconds. The flag makes
    // that ordering provable: it is set under the mutex immediately before
    // waiting, so once this thread holds the mutex *and* sees it set, the
    // waiter can only have released the mutex by entering `wait`.
    while true {
      condition.lock()
      if waiting {
        readyToProceed = true
        condition.broadcast()
        condition.unlock()
        break
      }
      condition.unlock()
      Thread.sleep(forTimeInterval: 0.001)
    }

    wait(for: [woken], timeout: 5)
    XCTAssertLessThan(elapsedMs, 5_000,
                      "the waiter ran to its own deadline instead of being released")
  }
}
