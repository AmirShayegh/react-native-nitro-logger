import XCTest

/// What `Package.swift` builds, checked against what is in `ios/`.
///
/// This suite is the reason the manifest no longer carries an explicit
/// `sources:` list. With one, a file was compiled only if somebody remembered
/// to name it: `FileSinkLifecycle.swift` was added, tested locally, and would
/// have gone into the release as a file this package did not build and no
/// XCTest case could reach — while shipping to consumers anyway, because the
/// podspec globs `ios/**/*.swift`. Nothing failed. The file was simply not
/// there, as far as `swift test` was concerned.
///
/// Inverting it — everything compiles unless excluded — makes the dangerous
/// direction the loud one, and leaves exactly one list to keep honest. So that
/// list is what this checks, in both directions:
///
/// - **Nothing is excluded without a reason that holds.** An entry has to name
///   a file that exists and that imports NitroModules, which is the only reason
///   a file here cannot build outside an app.
/// - **Nothing that could be compiled is left out.** Any `ios/*.swift` without
///   that import must not be excluded.
/// - **`sources:` does not come back.** Reintroducing it would restore the
///   opt-in without changing anything these tests could otherwise see: the
///   first file it omitted would look exactly like a file nobody had written.
///
/// The manifest is read as text rather than evaluated. Running SwiftPM's own
/// manifest loader from inside a test would need the toolchain's private
/// libraries, and the property under test is a syntactic one — which literals
/// appear in which array — so reading them is reading the answer, not
/// approximating it.
final class PackageManifestTests: XCTestCase {

  /// The repository root, derived from this file rather than from the working
  /// directory: `swift test` is not the only way this runs, and Xcode's is
  /// somewhere else entirely.
  private var repositoryRoot: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()   // NitroLoggerFileWriterTests
      .deletingLastPathComponent()   // swift-tests
      .deletingLastPathComponent()   // repository root
  }

  /// The manifest with its comments removed.
  ///
  /// Stripped, because the manifest explains itself at length and those
  /// explanations name the very tokens these tests look for — the first
  /// version of `testTheManifestHasNoExplicitSourceList` failed on a comment
  /// saying that `sources:` must not come back.
  ///
  /// Block comments go too, and not for tidiness: `sources /* … */: [...]` is
  /// valid Swift, so leaving them in would leave a spelling of the thing this
  /// forbids that the guard could not see. No string literal in this manifest
  /// contains `//` or `/*`, which is what makes the naive strip safe here.
  private var manifest: String {
    get throws {
      let text = try String(
        contentsOf: repositoryRoot.appendingPathComponent("Package.swift"),
        encoding: .utf8
      )

      let withoutBlocks = text.replacingOccurrences(
        of: "/\\*[\\s\\S]*?\\*/",
        with: " ",
        options: .regularExpression
      )

      return withoutBlocks
        .split(separator: "\n", omittingEmptySubsequences: false)
        .map { line -> Substring in
          guard let comment = line.range(of: "//") else { return line }
          return line[line.startIndex..<comment.lowerBound]
        }
        .joined(separator: "\n")
    }
  }

  /// Every `.swift` directly under `ios/`.
  private func iosSources() throws -> [String] {
    let directory = repositoryRoot.appendingPathComponent("ios")
    return try FileManager.default
      .contentsOfDirectory(atPath: directory.path)
      .filter { $0.hasSuffix(".swift") }
      .sorted()
  }

  /// The string literals inside the manifest's `exclude:` array.
  private func excludedFiles() throws -> [String] {
    let text = try manifest
    guard let start = text.range(of: "exclude: [") else { return [] }
    guard let end = text.range(of: "]", range: start.upperBound..<text.endIndex)
    else { return [] }

    let body = text[start.upperBound..<end.lowerBound]
    return body.split(separator: ",").compactMap { piece in
      let trimmed = piece.trimmingCharacters(in: .whitespacesAndNewlines)
      guard trimmed.hasPrefix("\""), trimmed.hasSuffix("\""), trimmed.count > 2
      else { return nil }
      return String(trimmed.dropFirst().dropLast())
    }.sorted()
  }

  private func importsNitro(_ file: String) throws -> Bool {
    let url = repositoryRoot
      .appendingPathComponent("ios")
      .appendingPathComponent(file)
    return try String(contentsOf: url, encoding: .utf8)
      .split(separator: "\n")
      .contains { $0.trimmingCharacters(in: .whitespaces) == "import NitroModules" }
  }

  // MARK: -

  /// Guards the two readers above. Both parse text, and a parse that quietly
  /// returned nothing would make every assertion below pass over empty sets.
  func testTheManifestAndTheDirectoryAreBothBeingRead() throws {
    XCTAssertGreaterThan(try iosSources().count, 4)
    XCTAssertTrue(try iosSources().contains("LogFileWriter.swift"))
    XCTAssertFalse(try excludedFiles().isEmpty,
                   "the exclude list parsed as empty, which no assertion below could tell from a correct manifest")
  }

  func testTheManifestHasNoExplicitSourceList() throws {
    // The whole mechanism. With `sources:` present, a file is compiled only if
    // it was remembered, and the failure mode of forgetting is silence.
    //
    // Matched with whitespace allowed before the colon rather than as the
    // literal `sources:`. Swift accepts trivia there — `sources : [...]` — so
    // an exact-string check would forbid one spelling of this and wave the
    // next one through, which is the shape of guard this file exists to stop
    // writing.
    XCTAssertNil(
      try manifest.range(of: "\\bsources\\s*:", options: .regularExpression),
      "an explicit source list makes compilation opt-in again; exclude the exceptions instead"
    )
  }

  func testEveryExcludedFileExistsAndCannotBeBuiltHere() throws {
    let sources = Set(try iosSources())

    for excluded in try excludedFiles() {
      XCTAssertTrue(
        sources.contains(excluded),
        "\(excluded) is excluded but is not in ios/ — SwiftPM only warns about that, so a rename would leave this list describing a file that is gone"
      )
      XCTAssertTrue(
        try importsNitro(excluded),
        "\(excluded) is excluded but does not import NitroModules, which is the only reason to exclude anything here"
      )
    }
  }

  func testEverySourceThatCanBeBuiltIsBuilt() throws {
    let excluded = Set(try excludedFiles())

    let missed = try iosSources().filter { file in
      try excluded.contains(file) && !importsNitro(file)
        || (!excluded.contains(file) && importsNitro(file))
    }

    XCTAssertEqual(
      missed, [],
      "each of these is on the wrong side of the exclude list: a Nitro-free file that is not compiled, or an adapter that is"
    )
  }
}
