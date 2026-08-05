import Foundation
import CryptoKit
import XCTest

@testable import NitroLoggerFileWriter

final class WireContractTests: XCTestCase {
  private static let root = WireContractSupport.root

  private static let descriptor = root
    .appendingPathComponent("spec/wire/v1/contract.json")
  private static let vectors = root
    .appendingPathComponent("spec/wire/v1/golden-vectors.json")

  private func requestContaining(_ message: String, object: [String: Any]) -> [String: Any] {
    if message == "ExportLogsServiceRequest" { return object }
    if message == "ResourceLogs" { return ["resourceLogs": [object]] }
    if message == "Resource" { return ["resourceLogs": [["resource": object]]] }
    if message == "ScopeLogs" { return ["resourceLogs": [["scopeLogs": [object]]]] }
    if message == "InstrumentationScope" {
      return ["resourceLogs": [["scopeLogs": [["scope": object]]]]]
    }
    if message == "LogRecord" {
      return ["resourceLogs": [["scopeLogs": [["logRecords": [object]]]]]]
    }
    if message == "KeyValue" {
      return ["resourceLogs": [["resource": ["attributes": [object]]]]]
    }
    if message == "AnyValue" {
      return ["resourceLogs": [["scopeLogs": [["logRecords": [["body": object]]]]]]]
    }
    return requestContaining(
      "AnyValue",
      object: [message == "ArrayValue" ? "arrayValue" : "kvlistValue": object]
    )
  }

  private func withoutKey(_ value: Any, removed: String) -> Any {
    if let array = value as? [Any] {
      return array.map { withoutKey($0, removed: removed) }
    }
    if let object = value as? [String: Any] {
      return Dictionary(uniqueKeysWithValues: object.compactMap { key, child in
        key == removed ? nil : (key, withoutKey(child, removed: removed))
      })
    }
    return value
  }

  func testTheSharedWireContractExistsAndDeclaresV1() throws {
    XCTAssertTrue(FileManager.default.fileExists(atPath: Self.descriptor.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: Self.vectors.path))
    let data = try Data(contentsOf: Self.descriptor)
    let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(root["contractVersion"] as? Int, 1)
    let upstream = try XCTUnwrap(root["upstream"] as? [String: String])
    XCTAssertEqual(upstream["otlpSpecification"], "1.11.0")
    XCTAssertEqual(upstream["protobufDefinitions"], "v1.10.0")
    let header = try XCTUnwrap(root["header"] as? [String: Any])
    XCTAssertEqual(header["version"] as? Int, 1)
    XCTAssertEqual(header["byteOrder"] as? String, "big-endian")
    XCTAssertEqual(header["hash"] as? String, "sha256")
    let fields = try XCTUnwrap(header["fields"] as? [[String: Any]])
    XCTAssertEqual(fields.compactMap { $0["name"] as? String }, [
      "magic", "headerVersion", "headerLength", "segmentId", "contentHash",
      "tenantId", "streamId", "sourceEpoch", "schemaVersion",
      "consentGeneration", "recordCount", "payloadLength",
    ])
    XCTAssertEqual(fields.compactMap { $0["encoding"] as? String }, [
      "fixed-bytes", "u16", "u32", "fixed-bytes", "fixed-bytes", "ascii",
      "ascii", "ascii", "u32", "u64", "u32", "u64",
    ])
    XCTAssertEqual(fields.map { ($0["bytes"] as? Int) ?? ($0["maxBytes"] as? Int) }, [
      8, 2, 4, 16, 32, 128, 128, 128, 4, 8, 4, 8,
    ])
  }

  func testEverySharedVectorGroupIsNonEmpty() throws {
    let data = try Data(contentsOf: Self.vectors)
    XCTAssertEqual(
      SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
      "fba17acea318ed21799eab6fb961c34bd49e26ad361e781850cbe4dfda789910"
    )
    let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    for key in [
      "validSegments", "invalidSegments", "numericCases", "identifierCases",
      "otlpSemanticCases", "unknownFieldCases",
    ] {
      let rows = try XCTUnwrap(root[key] as? [Any], "missing vector group \(key)")
      XCTAssertFalse(rows.isEmpty, "vector group \(key) must not be vacuous")
    }
  }

  func testEveryStoredHeaderAndCorruptionClassificationAgrees() throws {
    let descriptor = try WireContractSupport.object("spec/wire/v1/contract.json")
    let vectors = try WireContractSupport.object("spec/wire/v1/golden-vectors.json")
    for raw in try XCTUnwrap(vectors["validSegments"] as? [[String: Any]]) {
      let payload = try WireContractSupport.data(hex: try XCTUnwrap(raw["payloadHex"] as? String))
      let serialized = try WireContractSupport.serialize(
        fields: try XCTUnwrap(raw["fields"] as? [String: Any]),
        payload: payload,
        descriptor: descriptor
      )
      let header = try WireContractSupport.data(hex: try XCTUnwrap(raw["expectedHeaderHex"] as? String))
      XCTAssertEqual(serialized.zeroHeader, try WireContractSupport.data(hex: try XCTUnwrap(raw["expectedZeroHeaderHex"] as? String)))
      XCTAssertEqual(serialized.hash, try WireContractSupport.data(hex: try XCTUnwrap(raw["expectedHashHex"] as? String)))
      XCTAssertEqual(serialized.header, header)
      XCTAssertEqual(WireContractSupport.classify(header: header, payload: payload, descriptor: descriptor), "valid")
    }
    for raw in try XCTUnwrap(vectors["invalidSegments"] as? [[String: Any]]) {
      let header = try WireContractSupport.data(hex: try XCTUnwrap(raw["headerHex"] as? String))
      let payload = try WireContractSupport.data(hex: try XCTUnwrap(raw["payloadHex"] as? String))
      let expected = try XCTUnwrap(raw["expected"] as? String)
      let name = try XCTUnwrap(raw["name"] as? String)
      XCTAssertEqual(
        WireContractSupport.classify(header: header, payload: payload, descriptor: descriptor),
        expected,
        name
      )
    }
  }

  func testEveryNumericBoundaryAgrees() throws {
    let vectors = try WireContractSupport.object("spec/wire/v1/golden-vectors.json")
    for raw in try XCTUnwrap(vectors["numericCases"] as? [[String: Any]]) {
      let expected = try XCTUnwrap(raw["valid"] as? Bool)
      let name = try XCTUnwrap(raw["name"] as? String)
      XCTAssertEqual(
        WireContractSupport.canonicalDecimal(
          try XCTUnwrap(raw["value"] as? String),
          signed: try XCTUnwrap(raw["signed"] as? Bool),
          bits: try XCTUnwrap(raw["bits"] as? Int)
        ),
        expected,
        name
      )
    }
    for raw in try XCTUnwrap(vectors["identifierCases"] as? [[String: Any]]) {
      let bytes = try WireContractSupport.data(hex: try XCTUnwrap(raw["rawHex"] as? String))
      XCTAssertEqual(
        WireContractSupport.validIdentifier(bytes),
        try XCTUnwrap(raw["valid"] as? Bool)
      )
    }
  }

  func testStrictUnknownFieldInventoryUsesTheOriginalObject() throws {
    let descriptor = try WireContractSupport.object("spec/wire/v1/contract.json")
    let otlp = try XCTUnwrap(descriptor["otlp"] as? [String: Any])
    let messages = try XCTUnwrap(otlp["messages"] as? [String: [String]])
    let vectors = try WireContractSupport.object("spec/wire/v1/golden-vectors.json")
    let rows = try XCTUnwrap(vectors["unknownFieldCases"] as? [[String: Any]])
    XCTAssertEqual(rows.count, messages.count)
    for raw in rows {
      let message = try XCTUnwrap(raw["message"] as? String)
      let json = try XCTUnwrap(raw["json"] as? String)
      let object = try XCTUnwrap(
        JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
      )
      let unknown = Set(object.keys).subtracting(try XCTUnwrap(messages[message]))
      XCTAssertEqual(unknown, [try XCTUnwrap(raw["unknownField"] as? String)])
      let profiles = WireContractSupport.otlpProfiles(
        descriptor: descriptor,
        request: requestContaining(message, object: object)
      )
      XCTAssertEqual(profiles.unknownPaths.count, 1)
      let expected = withoutKey(
        requestContaining(message, object: object),
        removed: try XCTUnwrap(raw["unknownField"] as? String)
      ) as? NSDictionary
      XCTAssertEqual(profiles.normalized as NSDictionary, expected)
      XCTAssertTrue(
        WireContractSupport.otlpProfiles(
          descriptor: descriptor, request: profiles.normalized
        ).unknownPaths.isEmpty
      )
    }
  }

  func testOtlpSemanticVectorsAgree() throws {
    let descriptor = try WireContractSupport.object("spec/wire/v1/contract.json")
    let vectors = try WireContractSupport.object("spec/wire/v1/golden-vectors.json")
    for raw in try XCTUnwrap(vectors["otlpSemanticCases"] as? [[String: Any]]) {
      let expected = try XCTUnwrap(raw["valid"] as? Bool)
      let name = try XCTUnwrap(raw["name"] as? String)
      XCTAssertEqual(
        WireContractSupport.otlpSemanticCaseValid(raw, descriptor: descriptor),
        expected,
        name
      )
    }
  }
}
