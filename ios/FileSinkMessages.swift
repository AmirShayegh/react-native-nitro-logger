import Foundation

/// Every message the file sink adapter can send to JavaScript when an open
/// fails.
///
/// Named rather than written at the throw site so the whole list is one
/// greppable thing on each platform, and so `__tests__/openFailureParity` can
/// compare it against the Kotlin twin in `FileSinkMessages.kt`. The two
/// silently disagreed on all eight of these — Android sent "this sink is
/// already open" where this side sent "FileSink: already open" — which is
/// exactly the kind of difference that survives review and then arrives as a
/// cross-platform bug report about a string nobody meant to be an API.
///
/// Payload-free by construction: constants, never interpolation. A path carries
/// a username and an `errno` description carries the path, and this string ends
/// up wherever the app logs.
///
/// In its own file, mirroring `FileSinkMessages.kt`, because the file it used
/// to live in imports Nitro and so cannot be compiled by any test target. A
/// list whose entire purpose is to be compared across platforms should not be
/// unreachable on one of them.
enum FileSinkMessages {
  static let alreadyOpen = "FileSink: already open"
  static let closing = "FileSink: an earlier open on this sink is still being cancelled; retry"
  static let disposed = "FileSink: this sink has been disposed"
  static let configConflict =
    "FileSink: another destination already opened this file with a different configuration"
  static let symlinkEscape = "FileSink: the log path is a symbolic link"
  static let locked = "FileSink: another process is writing this log file"
  static let stillClosing = "FileSink: the previous destination for this file is still closing"
  static let openFailed = "FileSink: could not open the log file"
}
