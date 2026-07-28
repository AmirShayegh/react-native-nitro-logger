import Foundation
import NitroModules

/// M0 spike implementation of the FileSink contract.
///
/// Proves the bridge shapes end-to-end (accept/reject with byte reservation,
/// non-blocking status, deadline-bounded flush/close). M5 replaces the write
/// path with the vendored LogFileWriter: path registry + generations,
/// rotation/gzip/prune, secure-create on every artifact, fault recovery.
final class HybridFileSink: HybridFileSinkSpec {
  /// Hard payload cap: bytes stay reserved from acceptance until the write
  /// completes, so in-flight batches count against the bound.
  private static let hardCapBytes = 1_048_576

  private let queue = DispatchQueue(label: "com.nitrologger.filesink")
  /// Guards counters + handle swap only — never held across I/O, so
  /// getStatus() stays responsive while the writer is stalled on disk.
  private let stateLock = NSLock()
  private var reservedBytes = 0
  private var lostBytes = 0
  private var lostEntries = 0
  private var closed = true
  private var fileURL: URL?
  private var handle: FileHandle?

  var defaultLogDirectory: String {
    let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    return base.appendingPathComponent("Logs").path
  }

  func open(path: String, rotation: RotationConfig?) throws {
    _ = rotation // consumed from M5; numeric clamping happens there too
    let url = URL(fileURLWithPath: path)
    let fm = FileManager.default
    // Type-specific modes: directories need search permission, files do not.
    try fm.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    if !fm.fileExists(atPath: url.path) {
      guard fm.createFile(atPath: url.path, contents: nil,
                          attributes: [.posixPermissions: 0o600]) else {
        throw RuntimeError.error(withMessage: "FileSink: could not create \(url.path)")
      }
    }
    guard let h = try? FileHandle(forWritingTo: url) else {
      throw RuntimeError.error(withMessage: "FileSink: could not open \(url.path)")
    }
    h.seekToEndOfFile()
    stateLock.lock()
    fileURL = url
    handle = h
    closed = false
    stateLock.unlock()
  }

  func appendBatch(batch: String, entryCount: Double) throws -> AppendResult {
    let bytes = batch.utf8.count
    let entries = max(0, Int(entryCount))

    stateLock.lock()
    guard !closed, let h = handle else {
      let s = snapshotLocked()
      stateLock.unlock()
      return AppendResult(accepted: false, rejectReason: .closed,
                          queuedBytes: s.queuedBytes, lostBytes: s.lostBytes,
                          lostEntries: s.lostEntries, degraded: s.degraded)
    }
    guard reservedBytes + bytes <= Self.hardCapBytes else {
      let s = snapshotLocked()
      stateLock.unlock()
      return AppendResult(accepted: false, rejectReason: .full,
                          queuedBytes: s.queuedBytes, lostBytes: s.lostBytes,
                          lostEntries: s.lostEntries, degraded: s.degraded)
    }
    reservedBytes += bytes
    let accepted = snapshotLocked()
    stateLock.unlock()

    let data = Data(batch.utf8)
    queue.async { [weak self] in
      guard let self else { return }
      do {
        try h.write(contentsOf: data)
        self.stateLock.lock()
        self.reservedBytes -= bytes
        self.stateLock.unlock()
      } catch {
        // Batch is the atomic loss unit: the whole reservation becomes loss.
        self.stateLock.lock()
        self.reservedBytes -= bytes
        self.lostBytes += bytes
        self.lostEntries += entries
        self.stateLock.unlock()
      }
    }

    return AppendResult(accepted: true, rejectReason: nil,
                        queuedBytes: accepted.queuedBytes, lostBytes: accepted.lostBytes,
                        lostEntries: accepted.lostEntries, degraded: accepted.degraded)
  }

  func getStatus() throws -> SinkStatus {
    stateLock.lock()
    defer { stateLock.unlock() }
    return snapshotLocked()
  }

  func flush(deadlineMs: Double) throws -> FlushOutcome {
    let group = DispatchGroup()
    group.enter()
    queue.async { [weak self] in
      defer { group.leave() }
      guard let self else { return }
      self.stateLock.lock()
      let h = self.handle
      self.stateLock.unlock()
      try? h?.synchronize()
    }
    let timedOut = group.wait(
      timeout: .now() + .milliseconds(Int(max(0, deadlineMs)))
    ) == .timedOut

    stateLock.lock()
    let s = snapshotLocked()
    let pending = reservedBytes
    stateLock.unlock()
    return FlushOutcome(durable: !timedOut && pending == 0, timedOut: timedOut,
                        pendingBytes: Double(pending), queuedBytes: s.queuedBytes,
                        lostBytes: s.lostBytes, lostEntries: s.lostEntries,
                        degraded: s.degraded)
  }

  func close(deadlineMs: Double) throws -> FlushOutcome {
    stateLock.lock()
    closed = true
    stateLock.unlock()
    let outcome = try flush(deadlineMs: deadlineMs)
    stateLock.lock()
    let h = handle
    handle = nil
    stateLock.unlock()
    try? h?.close()
    return outcome
  }

  func getLogFilePaths() throws -> [String] {
    stateLock.lock()
    defer { stateLock.unlock() }
    guard let url = fileURL else { return [] }
    return [url.path] // archives join this list in M5
  }

  func clearLogs(deadlineMs: Double) throws -> ClearOutcome {
    // Spike: single current file. M5 extends the deletion set to the full
    // artifact scheme (sidecars, archives, gzip temporaries, staging) and
    // moves this under the registry lock with a generation bump.
    _ = try close(deadlineMs: deadlineMs)
    stateLock.lock()
    let url = fileURL
    stateLock.unlock()
    guard let url else {
      return ClearOutcome(deletedCount: 0, failedPaths: [], durable: true)
    }
    do {
      try FileManager.default.removeItem(at: url)
      return ClearOutcome(deletedCount: 1, failedPaths: [], durable: true)
    } catch {
      return ClearOutcome(deletedCount: 0, failedPaths: [url.path], durable: false)
    }
  }

  /// Callers must hold stateLock.
  private func snapshotLocked() -> SinkStatus {
    SinkStatus(queuedBytes: Double(reservedBytes), lostBytes: Double(lostBytes),
               lostEntries: Double(lostEntries), degraded: 0)
  }
}
