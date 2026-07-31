import Foundation
import XCTest

@testable import NitroLoggerFileWriter

/// The iOS half of the shared no-handle table.
///
/// The table lives in `spec/file-sink-lifecycle.rows.json` and is read by three
/// suites: this one, `__tests__/fileSinkLifecycleRows.test.ts`, and
/// `FileSinkLifecycleRowsTest.kt`. Its header explains why the answers live in
/// one file rather than in three hand-written suites that drifted apart on four
/// rows without anyone noticing.
///
/// ## What this does NOT prove
///
/// That `HybridFileSink` answers this way. Every nitrogen value type is a
/// C++-backed typealias behind `import NitroModules`, so that file cannot join
/// this target and nothing here executes a line of it. `answer(for:)` below
/// derives each answer from `FileSinkLifecycle` the way `HybridFileSink` does —
/// deliberately through the same `snapshot()` / `artifactSource()` calls, so
/// that a change to the lifecycle's verdict breaks this suite — but the
/// marshalling in between is out of reach until the `FileSinkAnswers`
/// extraction lands. At that point `answer(for:)` delegates instead of
/// deriving, and these same rows start pinning the adapter.
final class FileSinkLifecycleRowsTests: LogWriterTestCase {

  // MARK: - Loading

  private struct Row {
    let op: String
    let why: String
    let answers: [String: [String: String]]
  }

  /// `#filePath` is absolute and baked in at compile time, so this resolves
  /// identically however `swift test` was invoked. A `FileManager` cwd walk
  /// would resolve differently under Xcode and under SwiftPM, and the failure
  /// mode of guessing wrong is a suite that silently tests nothing.
  private static let tableURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // NitroLoggerFileWriterTests
    .deletingLastPathComponent()  // swift-tests
    .deletingLastPathComponent()  // repository root
    .appendingPathComponent("spec")
    .appendingPathComponent("file-sink-lifecycle.rows.json")

  private static func loadTable() throws -> (modes: [String], rows: [Row]) {
    let data = try Data(contentsOf: tableURL)
    guard
      let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let modes = root["modes"] as? [String],
      let raw = root["rows"] as? [[String: Any]]
    else {
      throw TableError.malformed("root object, `modes` and `rows` are required")
    }

    let rows: [Row] = try raw.map { entry in
      guard let op = entry["op"] as? String, let why = entry["why"] as? String else {
        throw TableError.malformed("every row needs `op` and `why`")
      }
      var answers: [String: [String: String]] = [:]
      for mode in modes {
        guard let answer = entry[mode] as? [String: String] else {
          throw TableError.malformed("row `\(op)` has no answer for mode `\(mode)`")
        }
        answers[mode] = answer
      }
      return Row(op: op, why: why, answers: answers)
    }
    return (modes, rows)
  }

  private enum TableError: Error, CustomStringConvertible {
    case malformed(String)
    var description: String {
      switch self {
      case .malformed(let detail): return "file-sink-lifecycle.rows.json: \(detail)"
      }
    }
  }

  // MARK: - The two modes

  /// A sink that was never opened: no handle, and nothing can exist yet.
  private func neverOpened() -> FileSinkLifecycle {
    FileSinkLifecycle()
  }

  /// A sink that opened, wrote, and closed: no handle, and files may exist.
  ///
  /// The file is left on disk on purpose. `getLogFilePaths` enumerates the
  /// directory rather than remembering a list, so a mode that deleted its file
  /// would answer `pathCount: 0` and agree with the never-opened row for a
  /// reason the table does not describe.
  private func openedThenClosed() throws -> FileSinkLifecycle {
    let lifecycle = FileSinkLifecycle()
    XCTAssertEqual(lifecycle.beginOpen(), .granted)
    let handle = try makeHandle()
    XCTAssertEqual(lifecycle.finishOpen(handle), .installed)
    _ = handle.appendBatch("{\"m\":1}\n", entryCount: 1)
    let detached = lifecycle.beginClose()
    _ = detached.handle?.close(deadlineMs: 1000)
    XCTAssertNil(lifecycle.current(), "the mode is defined by having no handle")
    return lifecycle
  }

  private func lifecycle(for mode: String) throws -> FileSinkLifecycle {
    switch mode {
    case "neverOpened": return neverOpened()
    case "openedThenClosed": return try openedThenClosed()
    default:
      // Never a skip. A mode this target cannot build is a mode this target
      // does not test, and a green suite would report the opposite.
      XCTFail("no builder for mode `\(mode)`")
      throw TableError.malformed("unbuildable mode `\(mode)`")
    }
  }

  // MARK: - The dispatcher

  /// Each case is the body `HybridFileSink` runs when its handle is `nil`,
  /// reading the same lifecycle calls in the same order.
  ///
  /// Returns `nil` for an op this target does not implement, which the guard
  /// below turns into a failure.
  private func answer(for op: String, _ lifecycle: FileSinkLifecycle) -> [String: String]? {
    switch op {
    case "appendBatch":
      guard lifecycle.current() == nil else { return nil }
      return [
        "accepted": "false", "rejectReason": "closed", "queuedBytes": "0",
        "lostBytes": "0", "lostEntries": "0", "degraded": "0",
      ]

    case "getStatus", "maintain":
      guard lifecycle.current() == nil else { return nil }
      return ["queuedBytes": "0", "lostBytes": "0", "lostEntries": "0", "degraded": "0"]

    case "collectLogs":
      guard lifecycle.current() == nil else { return nil }
      return [
        "path": "", "byteCount": "0", "sourceFileCount": "0",
        "complete": "true", "truncated": "false",
      ]

    case "flush":
      let (live, durableWithoutHandle) = lifecycle.snapshot()
      guard live == nil else { return nil }
      return Self.noHandleFlush(durable: durableWithoutHandle)

    case "close":
      let first = lifecycle.beginClose()
      guard first.handle == nil else { return nil }
      let second = lifecycle.beginClose()
      XCTAssertEqual(
        first.durableWithoutHandle, second.durableWithoutHandle,
        "closing twice must answer what the first close answered")
      return Self.noHandleFlush(durable: second.durableWithoutHandle)

    case "clearLogs":
      let (live, durableWithoutHandle) = lifecycle.snapshot()
      guard live == nil else { return nil }
      return [
        "deletedCount": "0", "failedPathCount": "0",
        "durable": String(durableWithoutHandle), "rebound": "false",
      ]

    case "deleteSupportBundle":
      // `snapshot()`, not `artifactSource()`. A sink that opened and closed
      // knows where its bundle would be but cannot confirm it is gone, and
      // `true` there deletes the caller's obligation to retry. This is the one
      // row that was wrong in shipped code, and it was found by review rather
      // than by a test because no test could reach the file.
      let (live, durableWithoutHandle) = lifecycle.snapshot()
      guard live == nil else { return nil }
      return ["deleted": String(durableWithoutHandle)]

    case "getLogFilePaths":
      let (live, path) = lifecycle.artifactSource()
      guard live == nil else { return nil }
      guard let path else { return ["pathCount": "0"] }
      return ["pathCount": String(LogWriter.artifactPaths(at: URL(fileURLWithPath: path)).count)]

    default:
      return nil
    }
  }

  private static func noHandleFlush(durable: Bool) -> [String: String] {
    [
      "durable": String(durable), "timedOut": "false", "pendingBytes": "0",
      "queuedBytes": "0", "lostBytes": "0", "lostEntries": "0", "degraded": "0",
    ]
  }

  private static let dispatchedOps = [
    "appendBatch", "getStatus", "maintain", "collectLogs", "flush",
    "close", "clearLogs", "deleteSupportBundle", "getLogFilePaths",
  ]

  // MARK: - Guards
  //
  // A shared table is only shared if every consumer is forced to keep up with
  // it. Each guard turns a way of quietly falling behind into a failure: a row
  // nobody dispatches, an op the table does not carry, a table that shrank.
  // Without them a new row would pass here by being ignored, and "add a row and
  // watch three suites go red" would describe something that does not happen.

  /// Pinned, not derived. `rows.count >= rows.count` is the shape of gate this
  /// repository has already shipped twice by accident.
  private static let pinnedRowFloor = 9
  private static let pinnedModes = ["neverOpened", "openedThenClosed"]

  func testTheTableStillHasEveryRowThisFloorWasPinnedAgainst() throws {
    let (_, rows) = try Self.loadTable()
    XCTAssertGreaterThanOrEqual(rows.count, Self.pinnedRowFloor)
  }

  func testTheTableDeclaresExactlyTheModesThisTargetCanBuild() throws {
    let (modes, _) = try Self.loadTable()
    XCTAssertEqual(modes, Self.pinnedModes)
  }

  func testEveryRowNamesAnOpThisTargetDispatches() throws {
    let (_, rows) = try Self.loadTable()
    let unknown = rows.map(\.op).filter { !Self.dispatchedOps.contains($0) }
    XCTAssertEqual(unknown, [], "unimplemented rows are a failure, never a skip")
  }

  func testEveryOpThisTargetDispatchesHasARow() throws {
    let (_, rows) = try Self.loadTable()
    let covered = Set(rows.map(\.op))
    XCTAssertEqual(
      Self.dispatchedOps.filter { !covered.contains($0) }, [],
      "an op answered here but absent from the table is answered by nobody else")
  }

  func testNoOpIsListedTwice() throws {
    let (_, rows) = try Self.loadTable()
    // Without this the headline claim — add a row, watch three suites go red —
    // has a hole in it: a tenth row duplicating an existing op and its answers
    // dispatches the same code a second time and passes everywhere. The row
    // count would even rise, satisfying every floor.
    let ops = rows.map(\.op)
    XCTAssertEqual(Set(ops).count, ops.count, "a duplicated op tests nothing twice")
  }

  func testEveryRowExplainsItself() throws {
    let (_, rows) = try Self.loadTable()
    for row in rows {
      // Not decoration. `complete: true` over an empty collect and
      // `durable: true` over a sink that never opened both read as bugs until
      // you know why.
      XCTAssertGreaterThan(row.why.count, 40, "row `\(row.op)` does not say why")
    }
  }

  // MARK: - The rows

  func testEveryRowAnswersAsTheTableSays() throws {
    let (modes, rows) = try Self.loadTable()
    var checked = 0

    for mode in modes {
      for row in rows {
        guard let expected = row.answers[mode] else {
          XCTFail("row `\(row.op)` has no answer for mode `\(mode)`")
          continue
        }
        guard let actual = answer(for: row.op, try lifecycle(for: mode)) else {
          XCTFail("no dispatcher for `\(row.op)`, or it found a live handle in `\(mode)`")
          continue
        }

        // Field-for-field in both directions, between the TABLE and the
        // DISPATCHER: a field the table names that `answer(for:)` does not
        // produce fails, and so does the reverse. It is deliberately not a
        // claim about `SinkStatus` or `FlushOutcome` growing a field — those
        // types are not reachable from this target at all, which is the whole
        // reason this file exists. The Jest half pins their key sets.
        XCTAssertEqual(actual, expected, "`\(row.op)` in mode `\(mode)`: \(row.why)")
        checked += 1
      }
    }

    // The loop above is only worth its assertions if it ran. A table that
    // parsed to zero rows, or a mode list that came back empty, would otherwise
    // report a pass having compared nothing.
    XCTAssertEqual(
      checked, modes.count * rows.count,
      "every row must be checked in every mode")
    XCTAssertGreaterThanOrEqual(checked, Self.pinnedModes.count * Self.pinnedRowFloor)
  }
}
