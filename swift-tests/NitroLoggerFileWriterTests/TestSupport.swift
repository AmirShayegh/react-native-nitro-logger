import Foundation
import XCTest
@testable import NitroLoggerFileWriter

/// A temp directory, an isolated registry, and cleanup that survives the flags
/// the fault tests set.
class LogWriterTestCase: XCTestCase {
  var root: URL!
  var registry: LogWriterRegistry!
  private var openHandles: [LogFileHandle] = []
  private var stalls: [() -> Void] = []

  override func setUpWithError() throws {
    try super.setUpWithError()
    let candidate = FileManager.default.temporaryDirectory
      .appendingPathComponent("nitro-logger-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
    // The writer keys and reports realpath-resolved paths, and on macOS the
    // temp directory lives behind the /var -> /private/var symlink. Resolving
    // here keeps assertions comparing like with like instead of quietly
    // asserting that resolution did not happen.
    //
    // `resolvingSymlinksInPath()` is not the tool for this: it documents that
    // it *strips* a leading /private, which is the opposite direction.
    let real = realpath(candidate.path, nil)
    defer { real.map { free($0) } }
    root = URL(fileURLWithPath: real.map { String(cString: $0) } ?? candidate.path)
    registry = LogWriterRegistry.isolated()
  }

  /// Points the "this name is a platform convention" rule at a directory this
  /// test owns, and takes it back again afterwards.
  ///
  /// The real one is `<Library>/Logs`, which on this host belongs to whoever is
  /// running the tests. Registering and unregistering here rather than in each
  /// test keeps the seam paired: it is process-wide, and a directory left
  /// declared conventional would silently withhold the claim from a parallel
  /// test's directory of the same name.
  func declareConventional(_ url: URL) {
    LogSecureFile.addConventionalDirectoryForTesting(url)
    addTeardownBlock { LogSecureFile.removeConventionalDirectoryForTesting(url) }
  }

  override func tearDownWithError() throws {
    // Release any stall first: closing a handle waits on the write queue.
    stalls.forEach { $0() }
    stalls.removeAll()
    openHandles.forEach { _ = $0.close(deadlineMs: 1000) }
    openHandles.removeAll()
    registry = nil
    if let root {
      // Only this test's root: the seam is process-wide, and clearing
      // everything would un-poison a parallel test mid-flight.
      LogSecureFile.clearDirectoryProtectionFaultsForTesting(under: root)
      TestFlags.clearImmutable(under: root)
      chmod(root.path, 0o700)
      try? FileManager.default.removeItem(at: root)
    }
    try super.tearDownWithError()
  }

  var logsDirectory: URL { root.appendingPathComponent("logs") }
  var logURL: URL { logsDirectory.appendingPathComponent("app.log") }

  @discardableResult
  func makeHandle(
    at url: URL? = nil,
    policy: LogRotationPolicy = LogRotationPolicy(),
    lineFramed: Bool = true,
    rawWrite: LogWriter.RawWrite? = nil,
    compressor: LogWriter.Compressor? = nil,
    steady: LogWriter.Steady? = nil
  ) throws -> LogFileHandle {
    let handle = try registry.acquire(
      path: (url ?? logURL).path,
      policy: policy,
      lineFramed: lineFramed,
      rawWrite: rawWrite,
      compressor: compressor,
      steady: steady
    )
    openHandles.append(handle)
    return handle
  }

  /// Blocks the writer's queue until the test releases it. Registered so
  /// teardown cannot hang on a stall a failing assertion skipped past.
  func stall(_ handle: LogFileHandle) -> () -> Void {
    let release = handle.writerForTesting.stallForTesting()
    stalls.append(release)
    return release
  }

  /// How many descriptors this process currently holds open on `url`.
  ///
  /// Deliberately scoped to one path rather than counting the whole descriptor
  /// table: XCTest, the temp directory and Foundation open and close their own
  /// descriptors while a test runs, so a table-wide count is noise that a leak
  /// of one descriptor hides inside. Asking "how many are on *this* file"
  /// answers exactly the question a reopen-after-close leak poses.
  ///
  /// `F_GETPATH` is the macOS way to map a descriptor back to a path; the
  /// writer opens realpath-resolved paths and `logURL` is resolved in setup, so
  /// both sides of the comparison are already in the same form.
  func openDescriptorCount(for url: URL? = nil) -> Int {
    let target = (url ?? logURL).path
    var count = 0
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    for fd in 0..<Int32(getdtablesize()) {
      guard fcntl(fd, F_GETPATH, &buffer) != -1 else { continue }
      if String(cString: buffer) == target { count += 1 }
    }
    return count
  }

  func contents(of url: URL? = nil) -> String {
    let data = (try? Data(contentsOf: url ?? logURL)) ?? Data()
    return String(decoding: data, as: UTF8.self)
  }

  func names(in directory: URL? = nil) -> [String] {
    let target = directory ?? logsDirectory
    return ((try? FileManager.default.contentsOfDirectory(atPath: target.path)) ?? []).sorted()
  }

  func archiveNames() -> [String] {
    names().filter { $0 != "app.log" }
  }

  /// Appends and waits for the write to land, so assertions do not race.
  @discardableResult
  func write(_ handle: LogFileHandle, _ text: String, entries: Int = 1) -> LogAppendResult {
    let result = handle.appendBatch(text, entryCount: entries)
    handle.writerForTesting.settleForTesting()
    return result
  }
}

/// A monotonic clock the test moves by hand.
///
/// Locked rather than a bare `var` captured by the closure: the writer reads it
/// on its own queue while the test advances it from the test thread, which is a
/// data race the sanitizer is right to flag.
final class SteadyClock {
  private let lock = NSLock()
  private var millis: Int64

  init(_ start: Int64 = 0) { millis = start }

  var now: Int64 {
    lock.lock()
    defer { lock.unlock() }
    return millis
  }

  func advance(_ by: Int64) {
    lock.lock()
    millis += by
    lock.unlock()
  }
}

// MARK: - Fault injection

/// A `write(2)` replacement that can be told to write short, fail, or both.
final class WriteFaults {
  private let lock = NSLock()
  private var chunkLimit: Int?
  private var failAfterBytes: Int?
  private var bytesThisCall = 0
  private(set) var callCount = 0

  /// Never write more than `bytes` per call, so the caller's retry loop is the
  /// thing under test.
  func writeShort(_ bytes: Int) {
    lock.lock(); chunkLimit = bytes; lock.unlock()
  }

  /// Succeed for `bytes` of the current batch, then fail hard.
  func failAfter(_ bytes: Int) {
    lock.lock(); failAfterBytes = bytes; bytesThisCall = 0; lock.unlock()
  }

  func recover() {
    lock.lock(); failAfterBytes = nil; chunkLimit = nil; lock.unlock()
  }

  var raw: LogWriter.RawWrite {
    { [self] fd, buffer, count in
      lock.lock()
      callCount += 1
      let limit = chunkLimit
      let budget = failAfterBytes
      let already = bytesThisCall
      lock.unlock()

      if let budget {
        let remaining = budget - already
        if remaining <= 0 {
          errno = EIO
          return -1
        }
        let allowed = min(count, remaining, limit ?? count)
        let written = write(fd, buffer, allowed)
        if written > 0 {
          lock.lock(); bytesThisCall += written; lock.unlock()
        }
        return written
      }

      return write(fd, buffer, min(count, limit ?? count))
    }
  }
}

enum TestFlags {
  /// Makes `removeItem` fail with EPERM, standing in for a file the process is
  /// not allowed to delete.
  static func makeImmutable(_ url: URL) {
    chflags(url.path, UInt32(UF_IMMUTABLE))
  }

  static func clearImmutable(under root: URL) {
    guard let walker = FileManager.default.enumerator(atPath: root.path) else { return }
    chflags(root.path, 0)
    for case let name as String in walker {
      chflags(root.appendingPathComponent(name).path, 0)
    }
  }
}
