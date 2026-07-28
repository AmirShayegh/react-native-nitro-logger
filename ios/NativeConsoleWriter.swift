import Foundation
import os

/// The os_log bridge, minus Nitro.
///
/// Everything worth getting wrong here — the level map, and what happens to a
/// line longer than the unified log will store — is a pure function of its
/// input, so it lives where XCTest can reach it. `HybridNativeConsoleSink` is
/// the adapter around this and holds no logic of its own.
public final class NativeConsoleWriter {

  /// Bytes of message text per `os_log` call.
  ///
  /// The unified log stores a bounded amount per entry and silently drops the
  /// rest — no ellipsis, no diagnostic, the tail simply is not there. For a
  /// logger that is the worst kind of failure: the console shows a complete-
  /// looking line that is missing the half you needed. 900 leaves room under
  /// the practical 1 KB limit for the chunk marker and os_log's own framing.
  static let chunkBytes = 900

  /// At most this many chunks per line. A stack trace should arrive whole; a
  /// runaway 4 MB string should not become five thousand console entries.
  static let maxChunks = 8

  private let lock = NSLock()
  private var logger: os.Logger?

  public init() {}

  /// Binds the subsystem and category. Calling it again rebinds.
  public func install(subsystem: String, category: String) {
    // Empty strings produce a logger that is legal but unfindable in Console,
    // so fall back to something a developer can actually search for.
    let subsystem = subsystem.isEmpty ? Self.fallbackSubsystem : subsystem
    let category = category.isEmpty ? "log" : category
    let bound = os.Logger(subsystem: subsystem, category: category)
    lock.lock()
    logger = bound
    lock.unlock()
  }

  /// Writes one drained batch.
  ///
  /// `levels` and `messages` are parallel arrays rather than a struct array,
  /// which keeps a batch to two bridge crossings instead of one per entry.
  /// `messages` is authoritative on count: a short `levels` means the caller
  /// has a bug, and dropping the messages it does have would turn that bug
  /// into missing logs.
  public func logBatch(levels: [Double], messages: [String]) {
    guard !messages.isEmpty else { return }
    let logger = self.resolvedLogger()

    for (index, message) in messages.enumerated() {
      let type = Self.osLogType(forCode: index < levels.count ? levels[index] : 2)
      for chunk in Self.chunks(of: message) {
        // `.public` because redaction already happened in the JavaScript layer
        // — what arrives here is the final rendered line, and marking it
        // private would hide it from the developer without protecting anything
        // that was not already decided upstream.
        logger.log(level: type, "\(chunk, privacy: .public)")
      }
    }
  }

  /// A logger even if `install` never ran.
  ///
  /// Losing every line because a caller forgot a setup call is a worse failure
  /// than logging under a guessed category, and this is the diagnostic channel
  /// — the one you reach for when something else has already gone wrong.
  private func resolvedLogger() -> os.Logger {
    lock.lock()
    if let logger {
      lock.unlock()
      return logger
    }
    let fallback = os.Logger(subsystem: Self.fallbackSubsystem, category: "log")
    logger = fallback
    lock.unlock()
    return fallback
  }

  private static let fallbackSubsystem =
    Bundle.main.bundleIdentifier ?? "com.nitrologger"

  // MARK: - Level mapping

  /// Codes 0–5 (verbose…todo), matching `LEVEL_ORDER` in TypeScript.
  ///
  /// There is no `Int(_:)` here, deliberately. Levels arrive as `Double`
  /// because that is what JavaScript has, and that conversion **traps** on
  /// `NaN` and on anything outside `Int`'s range — and `1e30` is perfectly
  /// finite, so an `isFinite` guard does not save it. A trap here is a crash in
  /// the logging path, reachable from every log call in the app. Matching on
  /// the `Double` cannot trap at all, and is exact for values this small.
  ///
  /// One rule for everything else: a code this does not recognise — negative,
  /// enormous, `NaN` — is `.default`. It carries no trustworthy severity, and
  /// `.default` shows it without hiding it as `.debug` or crying `.fault`. The
  /// rendered line still carries its own level tag either way.
  static func osLogType(forCode code: Double) -> OSLogType {
    switch code.rounded() {
    case 0, 1: return .debug     // verbose, debug
    case 2: return .info
    case 3: return .default      // warning
    case 4: return .error
    case 5: return .fault        // todo
    default: return .default
    }
  }

  // MARK: - Chunking

  /// Splits a line into pieces the unified log will store whole.
  ///
  /// A line that already fits comes back untouched and unmarked — the common
  /// case must look exactly as it was rendered. Only when splitting is
  /// unavoidable does each piece get an `(i/n)` prefix, so a reader can tell a
  /// continuation from a fresh entry and can see when one is missing.
  ///
  /// Splits fall on Character boundaries, never inside a grapheme: cutting a
  /// flag emoji or a combining sequence in half produces replacement
  /// characters in Console and, worse, suggests corruption that is not there.
  /// A single grapheme wider than a whole chunk — which no real log line
  /// contains — is emitted intact and left for the unified log to trim, since
  /// the alternative is deliberately producing mojibake.
  static func chunks(of message: String) -> [String] {
    guard message.utf8.count > chunkBytes else { return [message] }

    // Reserve room for the widest marker any of these pieces can carry, so
    // adding the prefix cannot push a piece back over the limit.
    let budget = chunkBytes - markerWidth
    var pieces: [String] = []
    var current = ""
    var currentBytes = 0

    for character in message {
      let width = String(character).utf8.count
      if currentBytes + width > budget, !current.isEmpty {
        pieces.append(current)
        current = ""
        currentBytes = 0
        if pieces.count == maxChunks { break }
      }
      current.append(character)
      currentBytes += width
    }

    if pieces.count < maxChunks, !current.isEmpty {
      pieces.append(current)
    }

    // Whatever is left over after the chunk ceiling is announced by size
    // rather than dropped in silence. A byte count is a length, not content,
    // so it says nothing about what was in the line.
    let consumed = pieces.reduce(0) { $0 + $1.utf8.count }
    var remaining = message.utf8.count - consumed
    if remaining > 0, var last = pieces.popLast() {
      // Make room for the notice inside the entry rather than appending past
      // the limit — otherwise the unified log truncates the very sentence that
      // exists to report truncation, which is the one line here that must
      // survive. Each character given back grows the count it reports.
      while last.utf8.count + noticeWidth + markerWidth > chunkBytes,
            let dropped = last.popLast() {
        remaining += String(dropped).utf8.count
      }
      last += " …+\(remaining) bytes truncated"
      pieces.append(last)
    }

    let total = pieces.count
    return pieces.enumerated().map { "(\($0.offset + 1)/\(total)) \($0.element)" }
  }

  /// `"(8/8) "` — the widest prefix `maxChunks` can produce.
  private static let markerWidth = "(\(maxChunks)/\(maxChunks)) ".utf8.count

  /// The truncation notice at its widest, so reserving this much is always
  /// enough however large the count turns out to be.
  private static let noticeWidth = " …+\(Int.max) bytes truncated".utf8.count
}
