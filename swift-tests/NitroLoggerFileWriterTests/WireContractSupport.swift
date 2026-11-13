import CryptoKit
import CoreFoundation
import Foundation

enum WireContractSupport {
  struct SerializedHeader {
    let header: Data
    let zeroHeader: Data
    let hash: Data
  }

  static let root = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()

  static func object(_ relative: String) throws -> [String: Any] {
    let data = try Data(contentsOf: root.appendingPathComponent(relative))
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw NSError(domain: "WireContract", code: 1)
    }
    return value
  }

  static func data(hex: String) throws -> Data {
    guard hex.count.isMultiple(of: 2) else { throw NSError(domain: "WireContract", code: 2) }
    var bytes = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
      let end = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<end], radix: 16) else {
        throw NSError(domain: "WireContract", code: 3)
      }
      bytes.append(byte)
      index = end
    }
    return bytes
  }

  static func classify(header: Data, payload: Data, descriptor: [String: Any]) -> String {
    guard
      let config = descriptor["header"] as? [String: Any],
      let magicHex = config["magicHex"] as? String,
      let magic = try? data(hex: magicHex),
      let version = config["version"] as? Int,
      header.count >= magic.count + 2,
      header.prefix(magic.count) == magic
    else { return "malformed" }

    let encodedVersion = integer(header, at: magic.count, bytes: 2)
    if encodedVersion != UInt64(version) { return "unsupportedHeaderVersion" }
    guard header.count >= magic.count + 6 else { return "malformed" }
    if integer(header, at: magic.count + 2, bytes: 4) != UInt64(header.count) {
      return "malformed"
    }
    let hashOffset = magic.count + 2 + 4 + 16
    guard header.count >= hashOffset + 32, header.count >= 8 else { return "malformed" }
    guard let parsed = parseV1Header(header, descriptor: descriptor),
          parsed.payloadLength == UInt64(payload.count) else {
      return "malformed"
    }
    let persisted = header[hashOffset..<(hashOffset + 32)]
    var zeroed = header
    zeroed.replaceSubrange(hashOffset..<(hashOffset + 32), with: repeatElement(0, count: 32))
    var preimage = zeroed
    preimage.append(payload)
    guard Data(SHA256.hash(data: preimage)) == persisted else { return "contentHashMismatch" }
    guard let count = payloadRecordCount(payload), UInt64(count) == parsed.recordCount else {
      return "malformed"
    }
    return "valid"
  }

  private static func parseV1Header(
    _ header: Data, descriptor: [String: Any]
  ) -> (recordCount: UInt64, payloadLength: UInt64)? {
    guard
      let config = descriptor["header"] as? [String: Any],
      let magicHex = config["magicHex"] as? String,
      let magic = try? data(hex: magicHex),
      let identifiers = descriptor["identifiers"] as? [String: Any],
      let maxBytes = identifiers["maxBytes"] as? Int
    else { return nil }
    var cursor = magic.count + 2 + 4 + 16 + 32
    for _ in 0..<3 {
      guard cursor + 2 <= header.count else { return nil }
      let length = Int(integer(header, at: cursor, bytes: 2))
      cursor += 2
      guard length > 0, length <= maxBytes, cursor + length <= header.count else { return nil }
      guard validIdentifier(header[cursor..<(cursor + length)]) else { return nil }
      cursor += length
    }
    guard cursor + 4 + 8 + 4 + 8 == header.count else { return nil }
    cursor += 4 + 8
    let recordCount = integer(header, at: cursor, bytes: 4)
    cursor += 4
    let payloadLength = integer(header, at: cursor, bytes: 8)
    return (recordCount, payloadLength)
  }

  private static func payloadRecordCount(_ payload: Data) -> Int? {
    guard let request = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
    else { return nil }
    guard request["resourceLogs"] == nil || request["resourceLogs"] is [[String: Any]] else {
      return nil
    }
    let resources = request["resourceLogs"] as? [[String: Any]] ?? []
    var count = 0
    for resource in resources {
      guard let scopes = resource["scopeLogs"] as? [[String: Any]] else {
        if resource["scopeLogs"] == nil { continue }
        return nil
      }
      for scope in scopes {
        guard let records = scope["logRecords"] as? [Any] else {
          if scope["logRecords"] == nil { continue }
          return nil
        }
        count += records.count
      }
    }
    return count
  }

  static func serialize(
    fields: [String: Any], payload: Data, descriptor: [String: Any]
  ) throws -> SerializedHeader {
    let config = try required(descriptor["header"] as? [String: Any])
    let magic = try data(hex: try required(config["magicHex"] as? String))
    let segmentId = try data(hex: try required(fields["segmentIdHex"] as? String))
    guard segmentId.count == 16 else { throw NSError(domain: "WireContract", code: 4) }

    func body(hash: Data) throws -> Data {
      var result = Data()
      result.append(magic)
      appendInteger(UInt64(try required(config["version"] as? Int)), bytes: 2, to: &result)
      appendInteger(0, bytes: 4, to: &result)
      result.append(segmentId)
      result.append(hash)
      for name in ["tenantId", "streamId", "sourceEpoch"] {
        let value = try required(fields[name] as? String)
        let bytes = Data(value.utf8)
        guard validIdentifier(bytes) else { throw NSError(domain: "WireContract", code: 5) }
        appendInteger(UInt64(bytes.count), bytes: 2, to: &result)
        result.append(bytes)
      }
      for (name, width) in [
        ("schemaVersion", 4), ("consentGeneration", 8),
        ("recordCount", 4), ("payloadLength", 8),
      ] {
        let value = try required(fields[name] as? String)
        guard canonicalDecimal(value, signed: false, bits: width * 8),
              let parsed = UInt64(value) else { throw NSError(domain: "WireContract", code: 6) }
        appendInteger(parsed, bytes: width, to: &result)
      }
      replaceInteger(UInt64(result.count), at: magic.count + 2, bytes: 4, in: &result)
      return result
    }

    let zeroHeader = try body(hash: Data(repeating: 0, count: 32))
    var preimage = zeroHeader
    preimage.append(payload)
    let hash = Data(SHA256.hash(data: preimage))
    return try SerializedHeader(header: body(hash: hash), zeroHeader: zeroHeader, hash: hash)
  }

  static func canonicalDecimal(_ value: String, signed: Bool, bits: Int) -> Bool {
    if value == "-0" || value.isEmpty { return false }
    let negative = value.first == "-"
    let digits = negative ? String(value.dropFirst()) : value
    guard
      !digits.isEmpty,
      digits.unicodeScalars.allSatisfy({ (48...57).contains(Int($0.value)) }),
      digits == "0" || digits.first != "0"
    else {
      return false
    }
    if !signed && negative { return false }
    let maximum: String
    if bits == 16 { maximum = "65535" }
    else if bits == 32 { maximum = "4294967295" }
    else if signed { maximum = negative ? "9223372036854775808" : "9223372036854775807" }
    else { maximum = "18446744073709551615" }
    return compareDecimal(digits, maximum) <= 0
  }

  static func validIdentifier(_ raw: Data) -> Bool {
    guard !raw.isEmpty, raw.count <= 128, raw.allSatisfy({ $0 < 128 }),
          let value = String(data: raw, encoding: .utf8) else { return false }
    return value.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]*$", options: .regularExpression) != nil
  }

  static func otlpProfiles(
    descriptor: [String: Any], request: [String: Any]
  ) -> (unknownPaths: [String], normalized: [String: Any]) {
    var paths: [String] = []
    let normalized = walkOtlp(
      descriptor: descriptor,
      message: "ExportLogsServiceRequest",
      value: request,
      path: "$",
      unknownPaths: &paths
    )
    return (paths.sorted(), normalized)
  }

  private static func walkOtlp(
    descriptor: [String: Any], message: String, value: [String: Any], path: String,
    unknownPaths: inout [String]
  ) -> [String: Any] {
    guard
      let otlp = descriptor["otlp"] as? [String: Any],
      let messages = otlp["messages"] as? [String: [String]],
      let children = otlp["children"] as? [String: [String: [String: Any]]]
    else { return [:] }
    let allowed = Set(messages[message, default: []])
    var result: [String: Any] = [:]
    for (key, child) in value {
      guard allowed.contains(key) else {
        unknownPaths.append("\(path).\(key)")
        continue
      }
      guard let relation = children[message]?[key],
            let childMessage = relation["message"] as? String,
            let repeated = relation["repeated"] as? Bool else {
        result[key] = child
        continue
      }
      if repeated, let entries = child as? [[String: Any]] {
        result[key] = entries.enumerated().map { index, entry in
          walkOtlp(
            descriptor: descriptor, message: childMessage, value: entry,
            path: "\(path).\(key)[\(index)]", unknownPaths: &unknownPaths
          )
        }
      } else if !repeated, let entry = child as? [String: Any] {
        result[key] = walkOtlp(
          descriptor: descriptor, message: childMessage, value: entry,
          path: "\(path).\(key)", unknownPaths: &unknownPaths
        )
      } else {
        result[key] = child
      }
    }
    return result
  }

  static func otlpSemanticCaseValid(
    _ vector: [String: Any], descriptor: [String: Any]
  ) -> Bool {
    guard let kind = vector["kind"] as? String, let json = vector["json"] as? String else {
      return false
    }
    if kind == "duplicateKey" {
      return hasNoDuplicateKeys(json)
    }
    guard
      let value = try? JSONSerialization.jsonObject(with: Data(json.utf8)),
      let object = value as? [String: Any],
      let otlp = descriptor["otlp"] as? [String: Any]
    else { return false }
    if kind == "timeUnixNano" || kind == "observedTimeUnixNano" {
      guard let timestamp = object[kind] as? String else { return false }
      return canonicalDecimal(timestamp, signed: false, bits: 64)
    }
    if kind == "u32" {
      guard
        let field = vector["field"] as? String,
        let number = object[field] as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID(),
        number.doubleValue.rounded() == number.doubleValue
      else { return false }
      return number.doubleValue >= 0 && number.doubleValue <= 4_294_967_295
    }
    if kind == "severityNumber" {
      guard
        let number = object["severityNumber"] as? NSNumber,
        CFGetTypeID(number) != CFBooleanGetTypeID(),
        number.doubleValue.rounded() == number.doubleValue,
        let range = otlp["severityNumber"] as? [String: Int]
      else { return false }
      return number.intValue >= range["minimum", default: 0]
        && number.intValue <= range["maximum", default: -1]
    }
    if kind == "AnyValue" {
      guard let arms = otlp["anyValueArms"] as? [String] else { return false }
      return anyValueValid(object, arms: arms)
    }
    return false
  }

  private static func hasNoDuplicateKeys(_ json: String) -> Bool {
    let characters = Array(json)
    var cursor = 0
    func whitespace() {
      while cursor < characters.count, characters[cursor].isWhitespace { cursor += 1 }
    }
    func stringToken() throws -> String {
      guard cursor < characters.count, characters[cursor] == "\"" else {
        throw NSError(domain: "WireContract", code: 8)
      }
      let start = cursor
      cursor += 1
      while cursor < characters.count {
        if characters[cursor] == "\\" { cursor += 2 }
        else {
          let character = characters[cursor]
          cursor += 1
          if character == "\"" {
            let raw = String(characters[start..<cursor])
            let decoded = try JSONSerialization.jsonObject(
              with: Data("[\(raw)]".utf8)
            ) as? [String]
            guard let value = decoded?.first else {
              throw NSError(domain: "WireContract", code: 9)
            }
            return value
          }
        }
      }
      throw NSError(domain: "WireContract", code: 10)
    }
    func value() throws -> Bool {
      whitespace()
      guard cursor < characters.count else { throw NSError(domain: "WireContract", code: 11) }
      if characters[cursor] == "{" {
        cursor += 1
        whitespace()
        var keys = Set<String>()
        if cursor < characters.count, characters[cursor] == "}" { cursor += 1; return true }
        while cursor < characters.count {
          let key = try stringToken()
          guard keys.insert(key).inserted else { return false }
          whitespace()
          guard cursor < characters.count, characters[cursor] == ":" else {
            throw NSError(domain: "WireContract", code: 12)
          }
          cursor += 1
          guard try value() else { return false }
          whitespace()
          guard cursor < characters.count else { throw NSError(domain: "WireContract", code: 13) }
          let separator = characters[cursor]
          cursor += 1
          if separator == "}" { return true }
          guard separator == "," else { throw NSError(domain: "WireContract", code: 14) }
          whitespace()
        }
      } else if characters[cursor] == "[" {
        cursor += 1
        whitespace()
        if cursor < characters.count, characters[cursor] == "]" { cursor += 1; return true }
        while cursor < characters.count {
          guard try value() else { return false }
          whitespace()
          guard cursor < characters.count else { throw NSError(domain: "WireContract", code: 15) }
          let separator = characters[cursor]
          cursor += 1
          if separator == "]" { return true }
          guard separator == "," else { throw NSError(domain: "WireContract", code: 16) }
        }
      } else if characters[cursor] == "\"" {
        _ = try stringToken()
        return true
      } else {
        let start = cursor
        while cursor < characters.count,
              !characters[cursor].isWhitespace,
              ![",", "}", "]"].contains(characters[cursor]) { cursor += 1 }
        let raw = String(characters[start..<cursor])
        _ = try JSONSerialization.jsonObject(with: Data(raw.utf8), options: .fragmentsAllowed)
        return true
      }
      throw NSError(domain: "WireContract", code: 17)
    }
    do {
      let valid = try value()
      whitespace()
      return valid && cursor == characters.count
    } catch {
      return false
    }
  }

  private static func anyValueValid(_ value: [String: Any], arms: [String]) -> Bool {
    let present = arms.filter { value[$0] != nil }
    guard present.count == 1, value.count == 1 else { return false }
    let arm = present[0]
    let payload = value[arm]
    if arm == "stringValue" { return payload is String }
    if arm == "boolValue" { return payload is Bool }
    if arm == "intValue" {
      return (payload as? String).map { canonicalDecimal($0, signed: true, bits: 64) } ?? false
    }
    if arm == "doubleValue" {
      guard let number = payload as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
        return false
      }
      return number.doubleValue.isFinite
    }
    if arm == "bytesValue" {
      guard let encoded = payload as? String, let decoded = Data(base64Encoded: encoded) else {
        return false
      }
      return decoded.base64EncodedString() == encoded
    }
    if arm == "arrayValue" {
      guard
        let container = payload as? [String: Any], container.count == 1,
        let values = container["values"] as? [[String: Any]]
      else { return false }
      return values.allSatisfy { anyValueValid($0, arms: arms) }
    }
    if arm == "kvlistValue" {
      guard
        let container = payload as? [String: Any], container.count == 1,
        let values = container["values"] as? [[String: Any]]
      else { return false }
      var keys = Set<String>()
      return values.allSatisfy { entry in
        guard
          Set(entry.keys) == ["key", "value"],
          let key = entry["key"] as? String, !keys.contains(key),
          let nested = entry["value"] as? [String: Any], anyValueValid(nested, arms: arms)
        else { return false }
        keys.insert(key)
        return true
      }
    }
    return false
  }

  private static func compareDecimal(_ left: String, _ right: String) -> Int {
    if left.count != right.count { return left.count < right.count ? -1 : 1 }
    if left == right { return 0 }
    return left.lexicographicallyPrecedes(right) ? -1 : 1
  }

  private static func required<T>(_ value: T?) throws -> T {
    guard let value else { throw NSError(domain: "WireContract", code: 7) }
    return value
  }

  private static func appendInteger(_ value: UInt64, bytes: Int, to data: inout Data) {
    for shift in stride(from: (bytes - 1) * 8, through: 0, by: -8) {
      data.append(UInt8(truncatingIfNeeded: value >> UInt64(shift)))
    }
  }

  private static func replaceInteger(
    _ value: UInt64, at offset: Int, bytes: Int, in data: inout Data
  ) {
    var encoded = Data()
    appendInteger(value, bytes: bytes, to: &encoded)
    data.replaceSubrange(offset..<(offset + bytes), with: encoded)
  }

  private static func integer(_ data: Data, at offset: Int, bytes: Int) -> UInt64 {
    guard offset >= 0, bytes > 0, offset + bytes <= data.count else { return UInt64.max }
    return data[offset..<(offset + bytes)].reduce(0) { ($0 << 8) | UInt64($1) }
  }
}
