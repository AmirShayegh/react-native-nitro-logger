// swift-tools-version: 5.9
import PackageDescription

/// Exists so the vendored writer can be unit-tested.
///
/// `LogFileWriter` and friends deliberately import nothing from Nitro — the
/// bridge adapter lives in `HybridFileSink.swift`, which this package does not
/// build. That split is what lets rotation, recovery, the registry, and every
/// injected fault run under XCTest in a second rather than on a simulator by
/// hand.
///
/// Tests sit outside `ios/` because the podspec globs `ios/**/*.swift` into the
/// consuming app. Anything under there ships.
let package = Package(
  name: "NitroLoggerFileWriter",
  platforms: [.iOS(.v15), .macOS(.v12)],
  products: [
    .library(name: "NitroLoggerFileWriter", targets: ["NitroLoggerFileWriter"])
  ],
  targets: [
    .target(
      name: "NitroLoggerFileWriter",
      path: "ios",
      // The Nitro adapters. Named so SwiftPM stops calling them stray files.
      exclude: [
        "HybridFileSink.swift",
        "HybridNativeConsoleSink.swift",
      ],
      // Explicit: everything else in this directory imports NitroModules.
      sources: [
        "LogFileWriter.swift",
        "LogWriterRegistry.swift",
        "LogSecureFile.swift",
        "Gzip.swift",
      ]
    ),
    .testTarget(
      name: "NitroLoggerFileWriterTests",
      dependencies: ["NitroLoggerFileWriter"],
      path: "swift-tests/NitroLoggerFileWriterTests"
    ),
  ]
)
