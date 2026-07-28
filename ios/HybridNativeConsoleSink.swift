import Foundation
import NitroModules

/// The Nitro end of the os_log sink: marshalling, and nothing else.
///
/// The level map and the chunking live in `NativeConsoleWriter`, which imports
/// nothing from Nitro and therefore runs under XCTest. Anything that grows a
/// decision in this file has been put in the wrong place — the same split the
/// file sink uses, for the same reason.
final class HybridNativeConsoleSink: HybridNativeConsoleSinkSpec {
  private let writer = NativeConsoleWriter()

  func install(subsystem: String, category: String) throws {
    writer.install(subsystem: subsystem, category: category)
  }

  func logBatch(levels: [Double], messages: [String]) throws {
    writer.logBatch(levels: levels, messages: messages)
  }
}
