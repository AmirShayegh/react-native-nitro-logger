// swift-tools-version: 5.9
import PackageDescription

/// Exists so the vendored native code can be unit-tested.
///
/// `LogFileWriter`, `NativeConsoleWriter` and friends deliberately import
/// nothing from Nitro — each bridge adapter lives in its own `Hybrid*.swift`,
/// which this package does not build. That split is what lets rotation,
/// recovery, the registry, the os_log level map and every injected fault run
/// under XCTest in a second rather than on a simulator by hand.
///
/// The target keeps its original name because every test file imports it; it
/// covers more than the file writer now.
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
      // Excluded, and nothing else is. There used to be an explicit `sources:`
      // list here as well, which quietly made "compiled" an opt-in: a new
      // `ios/*.swift` was not built, not tested, and reported nothing — the
      // file simply did not exist as far as this package was concerned, while
      // shipping to consumers through the podspec's `ios/**/*.swift` glob.
      //
      // Now every Swift file in the directory compiles unless it is named
      // here, and this list is exactly the files that import NitroModules,
      // which cannot build outside an app. `PackageManifestTests` asserts both
      // halves of that sentence — including that no `sources:` key comes back.
      exclude: [
        "HybridFileSink.swift",
        "HybridNativeConsoleSink.swift",
      ]
    ),
    .testTarget(
      name: "NitroLoggerFileWriterTests",
      dependencies: ["NitroLoggerFileWriter"],
      path: "swift-tests/NitroLoggerFileWriterTests"
    ),
  ]
)
