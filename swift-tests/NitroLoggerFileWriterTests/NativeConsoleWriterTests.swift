import XCTest
import os
@testable import NitroLoggerFileWriter

/// The os_log bridge's two decisions: which severity a code means, and what
/// happens to a line the unified log will not store whole.
final class NativeConsoleWriterTests: XCTestCase {

  // MARK: - Level mapping

  /// Byte-for-byte the map SwiftLogger's `OSLogDestination` uses, so the same
  /// entry lands at the same severity whichever logger produced it.
  func testTheLevelMapMatchesSwiftLoggers() {
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 0), .debug)   // verbose
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 1), .debug)   // debug
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 2), .info)    // info
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 3), .default) // warning
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 4), .error)   // error
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 5), .fault)   // todo
  }

  /// Levels cross as `Double` because that is what JavaScript has, and
  /// `Int(_:)` traps on `NaN` and on anything outside `Int`'s range. `1e30` is
  /// finite, so an `isFinite` guard alone does not save it — and a trap here
  /// is a crash reachable from every log call in the app.
  func testAValueThatCannotBeAnIntDoesNotTrap() {
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: .nan), .default)
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: .infinity), .default)
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: -.infinity), .default)
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 1e30), .default)
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: -1e30), .default)
  }

  /// An unrecognised code carries no trustworthy severity, so it gets the one
  /// that shows without hiding it as `.debug` or crying `.fault`. The rendered
  /// line still carries its own level tag either way.
  func testAnUnrecognisedCodeIsVisibleButNotAlarming() {
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: -3), .default)
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 99), .default)
  }

  func testFractionalCodesRoundToTheNearestLevel() {
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 3.4), .default)
    XCTAssertEqual(NativeConsoleWriter.osLogType(forCode: 3.6), .error)
  }

  // MARK: - Chunking

  /// The common case must come back exactly as it was rendered — no marker, no
  /// copy, nothing for a golden-output test elsewhere to trip over.
  func testALineThatFitsIsLeftAlone() {
    let line = "2026-07-28 INFO  something happened {count=3}"
    XCTAssertEqual(NativeConsoleWriter.chunks(of: line), [line])
  }

  func testAnEmptyLineIsStillOneEntry() {
    XCTAssertEqual(NativeConsoleWriter.chunks(of: ""), [""])
  }

  /// A line exactly at the limit is not over it.
  func testTheBoundaryIsNotSplit() {
    let line = String(repeating: "a", count: NativeConsoleWriter.chunkBytes)
    XCTAssertEqual(NativeConsoleWriter.chunks(of: line), [line])
  }

  /// Every piece has to fit, marker included — a marker that pushed a piece
  /// back over the limit would put the truncation right back.
  func testEveryPieceFitsWithItsMarker() {
    let line = String(repeating: "b", count: NativeConsoleWriter.chunkBytes * 3)
    let pieces = NativeConsoleWriter.chunks(of: line)

    XCTAssertGreaterThan(pieces.count, 1)
    for piece in pieces {
      XCTAssertLessThanOrEqual(piece.utf8.count, NativeConsoleWriter.chunkBytes)
    }
  }

  /// Reassembling the pieces has to give the line back. Chunking that quietly
  /// dropped a character would be worse than the truncation it replaces.
  func testThePiecesReassembleIntoTheOriginal() {
    let line = (0..<400).map { "field\($0)=value\($0)" }.joined(separator: " ")
    let pieces = NativeConsoleWriter.chunks(of: line)

    let rejoined = pieces
      .map { $0.drop { $0 != " " }.dropFirst() }
      .joined()
    XCTAssertEqual(String(rejoined), line)
  }

  func testPiecesAreNumberedSoAMissingOneIsVisible() {
    let line = String(repeating: "c", count: NativeConsoleWriter.chunkBytes * 2 + 10)
    let pieces = NativeConsoleWriter.chunks(of: line)

    for (index, piece) in pieces.enumerated() {
      XCTAssertTrue(
        piece.hasPrefix("(\(index + 1)/\(pieces.count)) "),
        "expected a position marker, got \(piece.prefix(12))")
    }
  }

  /// Splitting inside a grapheme produces replacement characters in Console
  /// and suggests corruption that is not there.
  func testSplitsFallOnCharacterBoundaries() {
    // Four bytes each, so a naive byte split lands mid-scalar almost every time.
    let line = String(repeating: "🇨🇦", count: 500)
    let pieces = NativeConsoleWriter.chunks(of: line)

    XCTAssertGreaterThan(pieces.count, 1)
    let rejoined = pieces
      .map { $0.drop { $0 != " " }.dropFirst() }
      .joined()
    XCTAssertEqual(String(rejoined), line)
    XCTAssertFalse(pieces.joined().contains("\u{FFFD}"),
                   "a replacement character means a scalar was cut in half")
  }

  /// A runaway string must not become thousands of console entries — but what
  /// it cost has to be stated rather than dropped in silence.
  func testAnEnormousLineIsCappedAndSaysWhatWasLost() throws {
    let line = String(repeating: "d", count: NativeConsoleWriter.chunkBytes * 40)
    let pieces = NativeConsoleWriter.chunks(of: line)

    XCTAssertEqual(pieces.count, NativeConsoleWriter.maxChunks)
    let last = try XCTUnwrap(pieces.last)
    XCTAssertTrue(last.contains("bytes truncated"),
                  "the tail is gone; the entry has to admit it")
  }

  /// The truncation notice has to fit inside the entry it is reporting on.
  ///
  /// Appending it past the limit gets the notice itself truncated by the
  /// unified log — which loses the one line here that must survive, and leaves
  /// an entry that looks merely short rather than cut.
  func testTheTruncationNoticeFitsInsideItsOwnEntry() {
    let line = String(repeating: "e", count: NativeConsoleWriter.chunkBytes * 60)
    let pieces = NativeConsoleWriter.chunks(of: line)

    XCTAssertTrue(pieces.last?.contains("bytes truncated") ?? false)
    for piece in pieces {
      XCTAssertLessThanOrEqual(
        piece.utf8.count, NativeConsoleWriter.chunkBytes,
        "including the one carrying the notice")
    }
  }

  /// The count in the notice has to describe the whole tail, including the
  /// characters given back to make room for the notice itself.
  func testTheTruncationCountIsTheRealShortfall() throws {
    let size = NativeConsoleWriter.chunkBytes * 60
    let line = String(repeating: "f", count: size)
    let pieces = NativeConsoleWriter.chunks(of: line)

    let last = try XCTUnwrap(pieces.last)
    let digits = try XCTUnwrap(
      last.split(separator: "+").last?.prefix { $0.isNumber })
    let reported = try XCTUnwrap(Int(digits))

    // Everything the pieces actually carry, minus the markers and the notice.
    let carried = pieces.reduce(0) { total, piece in
      total + piece.filter { $0 == "f" }.count
    }
    XCTAssertEqual(carried + reported, size)
  }

  /// The count in that notice is a length, not content — it describes how much
  /// was dropped without reproducing any of it.
  func testTheTruncationNoticeCarriesNoContent() {
    let secret = String(repeating: "SENTINEL", count: NativeConsoleWriter.chunkBytes * 5)
    let pieces = NativeConsoleWriter.chunks(of: secret)
    let notice = pieces.last?.split(separator: " ").suffix(3).joined(separator: " ")

    XCTAssertEqual(notice?.contains("SENTINEL"), false)
    XCTAssertEqual(pieces.count, NativeConsoleWriter.maxChunks)
  }

  // MARK: - Batching

  /// `messages` is authoritative on count. A short `levels` is a caller bug,
  /// and dropping the messages it does have turns that bug into missing logs.
  func testAShortLevelsArrayDoesNotCostMessages() {
    let writer = NativeConsoleWriter()
    writer.install(subsystem: "com.nitrologger.tests", category: "batching")

    // Reaching os_log means the assertion is that nothing traps or drops out;
    // the unified log is not readable back from a unit test.
    writer.logBatch(levels: [4], messages: ["first", "second", "third"])
    writer.logBatch(levels: [], messages: ["orphan"])
    writer.logBatch(levels: [.nan, .infinity], messages: ["a", "b"])
    writer.logBatch(levels: [1, 2, 3], messages: [])
  }

  /// Losing every line because a caller forgot `install` is worse than logging
  /// under a guessed category — this is the channel you reach for when
  /// something else has already gone wrong.
  func testLoggingBeforeInstallStillGoesSomewhere() {
    let writer = NativeConsoleWriter()
    writer.logBatch(levels: [2], messages: ["before install"])
    writer.install(subsystem: "com.nitrologger.tests", category: "late")
    writer.logBatch(levels: [2], messages: ["after install"])
  }

  /// An empty subsystem produces a logger that is legal and unfindable.
  func testEmptyInstallArgumentsFallBackToSomethingSearchable() {
    let writer = NativeConsoleWriter()
    writer.install(subsystem: "", category: "")
    writer.logBatch(levels: [3], messages: ["fallback"])
  }
}
