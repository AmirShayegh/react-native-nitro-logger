import Foundation
import XCTest
@testable import NitroLoggerFileWriter

/// Volume and concurrency. The unit tests above prove each rule; these prove
/// the rules still hold when everything happens at once.
final class LogBurstTests: LogWriterTestCase {

  private func line(_ index: Int) -> String {
    // Fixed width so a torn or interleaved record is obvious rather than
    // plausible.
    String(format: "%08d ", index) + String(repeating: "x", count: 40) + "\n"
  }

  /// The sanity burst: ten thousand records, every one intact and in order.
  func testTenThousandRecordsSurviveIntactAndInOrder() throws {
    let handle = try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 10_000_000))

    var accepted = 0
    for index in 0..<10_000 {
      var result = handle.appendBatch(line(index), entryCount: 1)
      // `full` is normal backpressure, and answering it by waiting is exactly
      // what the JavaScript batcher does.
      var spins = 0
      while !result.accepted, result.rejectReason == .full, spins < 1000 {
        _ = handle.flush(deadlineMs: 1000)
        result = handle.appendBatch(line(index), entryCount: 1)
        spins += 1
      }
      if result.accepted { accepted += 1 }
    }

    XCTAssertEqual(accepted, 10_000)
    XCTAssertTrue(handle.flush(deadlineMs: 10_000).durable)
    XCTAssertEqual(handle.status().lostEntries, 0)
    XCTAssertEqual(handle.status().queuedBytes, 0)

    let lines = contents().split(separator: "\n", omittingEmptySubsequences: false).dropLast()
    XCTAssertEqual(lines.count, 10_000)
    for (index, text) in lines.enumerated() {
      XCTAssertEqual(text.count, 49, "record \(index) is torn")
      XCTAssertTrue(text.hasPrefix(String(format: "%08d ", index)), "record \(index) is out of order")
    }
  }

  /// Rotation under load: nothing is lost, and every record ends up in exactly
  /// one file.
  func testBurstAcrossManyRotationsLosesNothing() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 4096, maxArchivedFilesCount: 10_000, compressArchives: false)
    let handle = try makeHandle(policy: policy)

    let total = 4_000
    for index in 0..<total {
      var result = handle.appendBatch(line(index), entryCount: 1)
      while !result.accepted, result.rejectReason == .full {
        _ = handle.flush(deadlineMs: 1000)
        result = handle.appendBatch(line(index), entryCount: 1)
      }
      XCTAssertTrue(result.accepted, "record \(index)")
    }
    XCTAssertTrue(handle.flush(deadlineMs: 10_000).durable)
    XCTAssertGreaterThan(archiveNames().count, 10, "the burst really did rotate")

    var seen = Set<Int>()
    for path in handle.logFilePaths() {
      let text = String(decoding: (try? Data(contentsOf: URL(fileURLWithPath: path))) ?? Data(),
                        as: UTF8.self)
      for record in text.split(separator: "\n") {
        XCTAssertEqual(record.count, 49, "torn record in \(URL(fileURLWithPath: path).lastPathComponent)")
        let index = Int(record.prefix(8))
        XCTAssertNotNil(index)
        if let index { XCTAssertTrue(seen.insert(index).inserted, "record \(index) appears twice") }
      }
    }
    XCTAssertEqual(seen.count, total, "every record is in exactly one file")
  }

  /// Several JavaScript runtimes can hold handles on one file. Records may
  /// interleave between handles — the writer never promised otherwise — but a
  /// record must never interleave with itself.
  func testConcurrentHandlesNeverTearARecord() throws {
    let handleCount = 4
    let perHandle = 500
    let handles = try (0..<handleCount).map { _ in
      try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 10_000_000))
    }

    DispatchQueue.concurrentPerform(iterations: handleCount) { worker in
      for index in 0..<perHandle {
        let text = String(format: "%02d-%06d ", worker, index)
          + String(repeating: "y", count: 40) + "\n"
        var result = handles[worker].appendBatch(text, entryCount: 1)
        while !result.accepted, result.rejectReason == .full {
          _ = handles[worker].flush(deadlineMs: 1000)
          result = handles[worker].appendBatch(text, entryCount: 1)
        }
      }
    }
    XCTAssertTrue(handles[0].flush(deadlineMs: 10_000).durable)

    let lines = contents().split(separator: "\n")
    XCTAssertEqual(lines.count, handleCount * perHandle)
    var seen = Set<String>()
    for text in lines {
      XCTAssertEqual(text.count, 50, "a record was torn by a concurrent write")
      XCTAssertTrue(seen.insert(String(text.prefix(9))).inserted, "duplicate record")
    }
    XCTAssertEqual(seen.count, handleCount * perHandle)
  }

  /// The backpressure loop polls status from the JavaScript thread while the
  /// writer thread is busy. That must never block, and must never hand back a
  /// number that has been half-updated.
  func testStatusPollingStaysResponsiveUnderLoad() throws {
    let handle = try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 10_000_000))
    // A semaphore rather than an XCTestExpectation: this loop polls until the
    // writer finishes, and an expectation may only be waited on once.
    let finished = DispatchSemaphore(value: 0)

    DispatchQueue.global().async {
      for index in 0..<5_000 {
        var result = handle.appendBatch(self.line(index), entryCount: 1)
        while !result.accepted, result.rejectReason == .full {
          result = handle.appendBatch(self.line(index), entryCount: 1)
        }
      }
      finished.signal()
    }

    var slowest: TimeInterval = 0
    var polls = 0
    var sawWorkInFlight = false
    while finished.wait(timeout: .now() + .milliseconds(1)) == .timedOut {
      let started = Date()
      let status = handle.status()
      slowest = max(slowest, Date().timeIntervalSince(started))
      polls += 1
      if status.queuedBytes > 0 { sawWorkInFlight = true }
      XCTAssertGreaterThanOrEqual(status.queuedBytes, 0)
      XCTAssertLessThanOrEqual(status.queuedBytes, LogWriter.hardCapBytes)
      XCTAssertGreaterThanOrEqual(status.lostEntries, 0)
    }

    // How many polls fit depends on how fast the machine drains, so the count
    // is only a guard against the loop never running. The claim under test is
    // the latency, and that a poll landed while bytes really were in flight.
    XCTAssertGreaterThan(polls, 0, "the poll loop should have run while writing")
    XCTAssertTrue(sawWorkInFlight, "at least one poll should have caught the writer busy")
    XCTAssertLessThan(slowest, 0.25, "getStatus must not wait behind writer I/O")
    XCTAssertTrue(handle.flush(deadlineMs: 10_000).durable)
  }

  /// The whole lifecycle at once: writing, rotating, compressing, purging, and
  /// writing again — with the invariant that a purge leaves nothing behind and
  /// the sink still works afterwards.
  func testPurgeDuringSustainedLoggingLeavesAWorkingSink() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 2048, maxArchivedFilesCount: 100, compressArchives: true)
    let handle = try makeHandle(policy: policy)

    for index in 0..<600 { write(handle, line(index)) }
    XCTAssertGreaterThan(archiveNames().count, 3)

    XCTAssertTrue(handle.clearLogs(deadlineMs: 5000).durable)
    XCTAssertEqual(names(), ["app.log", LogWriter.lockName("app.log")])
    XCTAssertEqual(handle.status().lostEntries, 0)

    for index in 0..<600 { write(handle, line(index)) }
    XCTAssertTrue(handle.flush(deadlineMs: 10_000).durable)

    var seen = Set<Int>()
    for path in handle.logFilePaths() where !path.hasSuffix(".gz") {
      let text = String(decoding: (try? Data(contentsOf: URL(fileURLWithPath: path))) ?? Data(),
                        as: UTF8.self)
      for record in text.split(separator: "\n") {
        XCTAssertEqual(record.count, 49)
        if let index = Int(record.prefix(8)) { seen.insert(index) }
      }
    }
    XCTAssertFalse(seen.isEmpty, "post-purge records are readable")
  }
}
