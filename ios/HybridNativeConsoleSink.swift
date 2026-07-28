import Foundation
import NitroModules
import os

/// Routes pre-formatted lines into os_log so JS entries interleave with
/// native ones in Xcode Console / Console.app.
final class HybridNativeConsoleSink: HybridNativeConsoleSinkSpec {
  private var logger: os.Logger?

  func install(subsystem: String, category: String) throws {
    logger = os.Logger(subsystem: subsystem, category: category)
  }

  func logBatch(levels: [Double], messages: [String]) throws {
    guard let logger else { return }
    for (index, message) in messages.enumerated() {
      let code = index < levels.count ? Int(levels[index]) : 2
      // verbose/debug → .debug, info → .info, warning → .default,
      // error → .error, todo → .fault (same map as SwiftLogger's OSLogDestination).
      let type: OSLogType
      switch code {
      case 0, 1: type = .debug
      case 2: type = .info
      case 3: type = .default
      case 4: type = .error
      default: type = .fault
      }
      // Redaction already happened in the JS layer; what arrives here is the
      // final rendered line, logged public so Console shows it.
      logger.log(level: type, "\(message, privacy: .public)")
    }
  }
}
