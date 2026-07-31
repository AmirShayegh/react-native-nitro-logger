import Foundation
import XCTest
@testable import NitroLoggerFileWriter

/// The Swift half of the perf harness — `measure {}` around the shapes the
/// 0.4.0 audit priced, so every writer-side optimisation records a
/// before/after from the same suite that proves it correct.
///
/// XCTest prints each block's average and never fails on it: no baselines are
/// set, deliberately. A shared CI runner's timings are noise, so what CI
/// takes from this file is only that the shapes still execute; the numbers
/// worth reading are two local runs of the same machine, one per commit.
///
/// WHAT THIS DOES NOT PROVE. These are macOS numbers for code that ships to
/// iOS; syscall costs differ, but the shapes — CRC stride, per-name regex,
/// prune passes, per-append fstat — are engine-independent in a way JS
/// numbers are not. Correctness lives in the other suites; a faster number
/// with a red guard test is a regression, not a win.
final class LogPerfTests: LogWriterTestCase {

  private func line(_ index: Int) -> String {
    String(format: "%08d ", index) + String(repeating: "x", count: 40) + "\n"
  }

  /// The per-append path: reserve, write, track, health-check — S5's shape.
  /// Rotation is out of reach so nothing else joins the measurement.
  func testMeasureAppendFlushBurst() throws {
    let handle = try makeHandle(policy: LogRotationPolicy(maxFileSizeBytes: 1_000_000_000))
    var next = 0
    // `.full` is backpressure and gets retried; any OTHER rejection would
    // silently turn the burst into a cheap failure-path measurement — the
    // flag (one predicted-false branch, no XCTest call inside timing)
    // converts that into a red test instead of a wrong number.
    var everRejected = false
    measure {
      for _ in 0..<1_000 {
        var result = handle.appendBatch(line(next), entryCount: 1)
        while !result.accepted, result.rejectReason == .full {
          _ = handle.flush(deadlineMs: 1000)
          result = handle.appendBatch(line(next), entryCount: 1)
        }
        if !result.accepted { everRejected = true }
        next += 1
      }
      _ = handle.flush(deadlineMs: 10_000)
    }
    XCTAssertFalse(everRejected, "an append was rejected; the measured shape must be all-accepted")
    XCTAssertEqual(handle.status().lostEntries, 0)
  }

  /// Rotation with gzip on: the compression stream, the CRC (S1's ~55% of
  /// archive cost), the stamp, and the retention sweep each rotation runs.
  func testMeasureRotationWithCompressionBurst() throws {
    let policy = LogRotationPolicy(
      maxFileSizeBytes: 16_384, maxArchivedFilesCount: 10_000, compressArchives: true)
    let handle = try makeHandle(policy: policy)
    var next = 0
    // Same acceptance discipline as the plain burst above: archives produced
    // before a failure would satisfy the rotation assertion on their own.
    var everRejected = false
    measure {
      // ~64 KiB per block: four rotations' worth at the 16 KiB threshold.
      for _ in 0..<1_300 {
        var result = handle.appendBatch(line(next), entryCount: 1)
        while !result.accepted, result.rejectReason == .full {
          _ = handle.flush(deadlineMs: 1000)
          result = handle.appendBatch(line(next), entryCount: 1)
        }
        if !result.accepted { everRejected = true }
        next += 1
      }
      _ = handle.flush(deadlineMs: 10_000)
    }
    XCTAssertFalse(everRejected, "an append was rejected; the measured shape must be all-accepted")
    XCTAssertGreaterThan(archiveNames().count, 0, "the burst really did rotate")
  }

  /// The retention sweep over a populated directory: two enumerations, the
  /// per-name grammar checks, and the prune passes — S2, S3, S6, S7's shape.
  /// Two hundred archives is retention's working ceiling, not its default.
  func testMeasureRetentionSweepAcrossManyArchives() throws {
    let handle = try makeHandle(
      policy: LogRotationPolicy(maxFileSizeBytes: 1_000_000_000, maxArchivedFilesCount: 500))
    _ = handle.appendBatch(line(0), entryCount: 1)
    _ = handle.flush(deadlineMs: 1000)

    for index in 0..<200 {
      let name = String(format: "app.log.20260101T%06dZ_%08x", index, index)
      try Data("archived\n".utf8).write(to: logsDirectory.appendingPathComponent(name))
    }

    measure {
      _ = handle.maintain(deadlineMs: 10_000)
    }
    XCTAssertGreaterThanOrEqual(archiveNames().count, 200, "nothing should be pruned at count 500")
  }

  /// `Gzip.crc32` alone over 1 MiB — the term slicing-by-8 (S1) attacks,
  /// measured without the compressor beside it.
  func testMeasureCrc32OverOneMebibyte() {
    var bytes = Data(count: 1_048_576)
    for index in 0..<bytes.count {
      bytes[index] = UInt8((index &* 31) & 0xFF)
    }
    // Wrapping addition, not XOR: `measure` runs the block an even number of
    // times, and an even count of identical values XORs back to zero.
    var checksum: UInt32 = 0
    measure {
      checksum = checksum &+ Gzip.crc32(bytes)
    }
    XCTAssertNotEqual(checksum, 0, "the loop must not be optimised away")
  }
}
