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
/// Every answer below is produced by calling `FileSinkAnswers`, which is the
/// object `HybridFileSink` delegates to for all nine of these ops.
///
/// ## What this does NOT prove
///
/// That the `Wire*`-to-nitrogen copy in `HybridFileSink` is faithful. Every
/// nitrogen value type is a C++-backed typealias behind `import NitroModules`,
/// so that file still cannot join this target. What it now contains is a
/// field-for-field copy and nothing else — `adapterThinness.test.js` pins that
/// with a line ceiling and a ban on `lifecycle.` calls — and the copy itself is
/// covered end to end only by the min-rn smoke jobs. A real reduction of the
/// gap, not its elimination.
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
  private func neverOpened() -> FileSinkAnswers {
    FileSinkAnswers(registry: registry)
  }

  /// A sink that opened, wrote, and closed: no handle, and files may exist.
  ///
  /// The file is left on disk on purpose. `getLogFilePaths` enumerates the
  /// directory rather than remembering a list, so a mode that deleted its file
  /// would answer `pathCount: 0` and agree with the never-opened row for a
  /// reason the table does not describe.
  private func openedThenClosed() throws -> FileSinkAnswers {
    let answers = FileSinkAnswers(registry: registry)
    try answers.open(path: logURL.path, policy: LogRotationPolicy(), lineFramed: true)
    _ = answers.appendBatch(batch: "{\"m\":1}\n", entryCount: 1)
    XCTAssertTrue(answers.close(deadlineMs: 1000).durable)
    return answers
  }

  private func sink(for mode: String) throws -> FileSinkAnswers {
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

  /// Calls `FileSinkAnswers` and renders the answer's fields to strings.
  ///
  /// It does not decide anything: every value below comes back from the object
  /// under test. Returns `nil` for an op this target does not implement, which
  /// the caller turns into a failure.
  private func answer(for op: String, _ answers: FileSinkAnswers) -> [String: String]? {
    switch op {
    case "appendBatch":
      let r = answers.appendBatch(batch: "{\"m\":2}\n", entryCount: 1)
      return [
        "accepted": String(r.accepted),
        // The raw value, not a default: an implementation that refused without
        // saying why would be reporting something the table does not describe.
        "rejectReason": r.rejectReason?.rawValue ?? "<absent>",
        "queuedBytes": Self.number(r.queuedBytes),
        "lostBytes": Self.number(r.lostBytes),
        "lostEntries": Self.number(r.lostEntries),
        "degraded": Self.number(r.degraded),
      ]

    case "getStatus":
      return Self.status(answers.getStatus())

    case "maintain":
      return Self.status(answers.maintain(deadlineMs: 1000))

    case "collectLogs":
      let o = answers.collectLogs(deadlineMs: 1000, maxTotalBytes: 1_000_000)
      return [
        "path": o.path,
        "byteCount": Self.number(o.byteCount),
        "sourceFileCount": Self.number(o.sourceFileCount),
        "complete": String(o.complete),
        "truncated": String(o.truncated),
      ]

    case "flush":
      return Self.flush(answers.flush(deadlineMs: 1000))

    case "close":
      let first = answers.close(deadlineMs: 1000)
      let second = answers.close(deadlineMs: 1000)
      // Idempotence is a relation between two calls, so it cannot be a row.
      // The table pins what the answer *is*; this pins that asking twice does
      // not change it.
      XCTAssertEqual(first, second, "closing twice must answer what the first close answered")
      return Self.flush(second)

    case "clearLogs":
      let o = answers.clearLogs(deadlineMs: 1000)
      return [
        "deletedCount": Self.number(o.deletedCount),
        "failedPathCount": String(o.failedPaths.count),
        "durable": String(o.durable),
        "rebound": String(o.rebound),
      ]

    case "deleteSupportBundle":
      return ["deleted": String(answers.deleteSupportBundle(deadlineMs: 1000))]

    case "getLogFilePaths":
      return ["pathCount": String(answers.getLogFilePaths().count)]

    default:
      return nil
    }
  }

  /// `Double` renders as `0.0`, and the table says `0`. Integral values only,
  /// which every field here is — a fractional byte count would fail loudly
  /// rather than being rounded into agreement.
  private static func number(_ value: Double) -> String {
    guard value == value.rounded(), let exact = Int(exactly: value.rounded()) else {
      return String(value)
    }
    return String(exact)
  }

  private static func status(_ s: WireSinkStatus) -> [String: String] {
    [
      "queuedBytes": number(s.queuedBytes), "lostBytes": number(s.lostBytes),
      "lostEntries": number(s.lostEntries), "degraded": number(s.degraded),
    ]
  }

  private static func flush(_ o: WireFlushOutcome) -> [String: String] {
    [
      "durable": String(o.durable), "timedOut": String(o.timedOut),
      "pendingBytes": number(o.pendingBytes), "queuedBytes": number(o.queuedBytes),
      "lostBytes": number(o.lostBytes), "lostEntries": number(o.lostEntries),
      "degraded": number(o.degraded),
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
        guard let actual = answer(for: row.op, try sink(for: mode)) else {
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
