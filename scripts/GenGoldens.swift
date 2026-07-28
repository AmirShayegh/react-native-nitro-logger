import Foundation
@testable import Logger

// Emits the SwiftLogger JSON rendering for a fixed corpus, as JSON Lines of
// {name, json}. The RN test suite asserts byte equality against this, after
// removing the three fields RN cannot produce (file, function, line).

struct GoldenCase {
    let name: String
    let entry: LogEntry
}

func makeCases() -> [GoldenCase] {
    // A fixed instant so goldens are reproducible: 2026-07-27T12:15:30.842Z
    let t = Date(timeIntervalSince1970: 1785154530.842)

    return [
        GoldenCase(name: "minimal",
                   entry: LogEntry(timestamp: t, level: .info, message: "started")),
        GoldenCase(name: "all-levels-verbose",
                   entry: LogEntry(timestamp: t, level: .verbose, message: "m")),
        GoldenCase(name: "all-levels-debug",
                   entry: LogEntry(timestamp: t, level: .debug, message: "m")),
        GoldenCase(name: "all-levels-warning",
                   entry: LogEntry(timestamp: t, level: .warning, message: "m")),
        GoldenCase(name: "all-levels-error",
                   entry: LogEntry(timestamp: t, level: .error, message: "m")),
        GoldenCase(name: "all-levels-todo",
                   entry: LogEntry(timestamp: t, level: .todo, message: "m")),
        GoldenCase(name: "correlation-only",
                   entry: LogEntry(timestamp: t, level: .info, message: "m",
                                   correlation: "c0ffee")),
        GoldenCase(name: "subsystem-only",
                   entry: LogEntry(timestamp: t, level: .info, message: "m",
                                   subsystem: "network")),
        GoldenCase(name: "correlation-and-subsystem",
                   entry: LogEntry(timestamp: t, level: .info, message: "m",
                                   correlation: "c0ffee", subsystem: "network")),
        GoldenCase(name: "metadata-types",
                   entry: LogEntry(timestamp: t, level: .info, message: "m",
                                   metadata: ["s": "text", "i": 42, "b": true])),
        GoldenCase(name: "metadata-key-sorting",
                   entry: LogEntry(timestamp: t, level: .info, message: "m",
                                   metadata: ["zebra": 1, "alpha": 2, "Mango": 3, "_under": 4])),
        GoldenCase(name: "metadata-numeric-keys",
                   entry: LogEntry(timestamp: t, level: .info, message: "m",
                                   metadata: ["2": "two", "10": "ten", "1": "one", "b": "bee"])),
        GoldenCase(name: "escape-quote-backslash",
                   entry: LogEntry(timestamp: t, level: .info,
                                   message: "he said \"hi\" and C:\\path")),
        GoldenCase(name: "escape-shorthand-controls",
                   entry: LogEntry(timestamp: t, level: .info,
                                   message: "nl\ncr\rtab\tbs\u{08}ff\u{0C}")),
        GoldenCase(name: "escape-other-c0",
                   entry: LogEntry(timestamp: t, level: .info,
                                   message: "\u{00}\u{01}\u{1F}")),
        GoldenCase(name: "unicode-passthrough",
                   entry: LogEntry(timestamp: t, level: .info,
                                   message: "café 日本語 🎉 emoji")),
        GoldenCase(name: "escaped-metadata-key",
                   entry: LogEntry(timestamp: t, level: .info, message: "m",
                                   metadata: ["with\"quote": "v", "with\nnewline": "w"])),
        GoldenCase(name: "empty-message",
                   entry: LogEntry(timestamp: t, level: .info, message: "")),
        GoldenCase(name: "empty-metadata-omitted",
                   entry: LogEntry(timestamp: t, level: .info, message: "m", metadata: [:])),
        GoldenCase(name: "negative-and-fractional-numbers",
                   entry: LogEntry(timestamp: t, level: .info, message: "m",
                                   metadata: ["neg": -17, "frac": 1.5, "zero": 0])),
        GoldenCase(name: "epoch-before-1970",
                   entry: LogEntry(timestamp: Date(timeIntervalSince1970: -1.5),
                                   level: .info, message: "m")),
    ]
}

let formatter = JSONLogFormatter()
for c in makeCases() {
    let line = formatter.format(c.entry)
    let record = ["name": c.name, "json": line]
    let data = try! JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
