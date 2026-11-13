package com.margelo.nitro.nitrologger

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.ByteArrayOutputStream
import java.io.File
import java.math.BigInteger
import java.security.MessageDigest
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.Base64

internal object WireContractSupport {
  data class SerializedHeader(
    val header: ByteArray,
    val zeroHeader: ByteArray,
    val hash: ByteArray
  )

  fun file(name: String): File {
    val root = System.getProperty("nitroLogger.repoRoot")
      ?: throw AssertionError("nitroLogger.repoRoot is unset")
    return File(root, "spec/wire/v1/$name")
  }

  fun objectFrom(name: String): JsonObject = JsonParser.parseString(file(name).readText()).asJsonObject

  fun bytes(hex: String): ByteArray {
    require(hex.length % 2 == 0)
    return ByteArray(hex.length / 2) { index ->
      hex.substring(index * 2, index * 2 + 2).toInt(16).toByte()
    }
  }

  fun classify(header: ByteArray, payload: ByteArray, descriptor: JsonObject): String {
    val config = descriptor.getAsJsonObject("header")
    val magic = bytes(config.get("magicHex").asString)
    if (header.size < magic.size + 2 || !header.copyOfRange(0, magic.size).contentEquals(magic)) return "malformed"
    if (integer(header, magic.size, 2) != config.get("version").asLong) return "unsupportedHeaderVersion"
    if (header.size < magic.size + 6 || integer(header, magic.size + 2, 4) != header.size.toLong()) return "malformed"
    val hashOffset = magic.size + 2 + 4 + 16
    if (header.size < hashOffset + 32) return "malformed"
    val parsed = parseV1Header(header, descriptor) ?: return "malformed"
    if (parsed.second != payload.size.toULong()) return "malformed"
    val persisted = header.copyOfRange(hashOffset, hashOffset + 32)
    val zeroed = header.copyOf()
    zeroed.fill(0, hashOffset, hashOffset + 32)
    val digest = MessageDigest.getInstance("SHA-256").apply { update(zeroed); update(payload) }.digest()
    if (!persisted.contentEquals(digest)) return "contentHashMismatch"
    val records = payloadRecordCount(payload) ?: return "malformed"
    return if (parsed.first == records.toULong()) "valid" else "malformed"
  }

  private fun parseV1Header(header: ByteArray, descriptor: JsonObject): Pair<ULong, ULong>? {
    val config = descriptor.getAsJsonObject("header")
    val magic = bytes(config.get("magicHex").asString)
    val maximum = descriptor.getAsJsonObject("identifiers").get("maxBytes").asInt
    var cursor = magic.size + 2 + 4 + 16 + 32
    repeat(3) {
      if (cursor + 2 > header.size) return null
      val length = integer(header, cursor, 2).toInt()
      cursor += 2
      if (length <= 0 || length > maximum || cursor + length > header.size) return null
      if (!validIdentifier(header.copyOfRange(cursor, cursor + length))) return null
      cursor += length
    }
    if (cursor + 4 + 8 + 4 + 8 != header.size) return null
    cursor += 4 + 8
    val recordCount = unsignedInteger(header, cursor, 4)
    cursor += 4
    val payloadLength = unsignedInteger(header, cursor, 8)
    return recordCount to payloadLength
  }

  private fun payloadRecordCount(payload: ByteArray): Int? {
    val request = try { JsonParser.parseString(payload.toString(StandardCharsets.UTF_8)).asJsonObject }
      catch (_: Exception) { return null }
    val resourceValue = request.get("resourceLogs")
    if (resourceValue != null && !resourceValue.isJsonArray) return null
    val resources = resourceValue?.asJsonArray ?: JsonArray()
    var count = 0
    resources.forEach { resourceValue ->
      val resource = if (resourceValue.isJsonObject) resourceValue.asJsonObject else return null
      val scopeValue = resource.get("scopeLogs")
      if (scopeValue != null && !scopeValue.isJsonArray) return null
      val scopes = scopeValue?.asJsonArray ?: JsonArray()
      scopes.forEach { scopeValue ->
        val scope = if (scopeValue.isJsonObject) scopeValue.asJsonObject else return null
        val recordValue = scope.get("logRecords")
        if (recordValue != null && !recordValue.isJsonArray) return null
        val records = recordValue?.asJsonArray ?: JsonArray()
        count += records.size()
      }
    }
    return count
  }

  fun serialize(fields: JsonObject, payload: ByteArray, descriptor: JsonObject): SerializedHeader {
    val config = descriptor.getAsJsonObject("header")
    val magic = bytes(config.get("magicHex").asString)
    val segmentId = bytes(fields.get("segmentIdHex").asString)
    require(segmentId.size == 16)

    fun body(hash: ByteArray): ByteArray {
      val output = ByteArrayOutputStream()
      output.write(magic)
      output.write(integerBytes(config.get("version").asString.toULong(), 2))
      output.write(ByteArray(4))
      output.write(segmentId)
      output.write(hash)
      listOf("tenantId", "streamId", "sourceEpoch").forEach { name ->
        val encoded = fields.get(name).asString.toByteArray(StandardCharsets.UTF_8)
        require(validIdentifier(encoded))
        output.write(integerBytes(encoded.size.toULong(), 2))
        output.write(encoded)
      }
      listOf(
        "schemaVersion" to 4,
        "consentGeneration" to 8,
        "recordCount" to 4,
        "payloadLength" to 8
      ).forEach { (name, width) ->
        val value = fields.get(name).asString
        require(canonicalDecimal(value, signed = false, bits = width * 8))
        output.write(integerBytes(value.toULong(), width))
      }
      val result = output.toByteArray()
      integerBytes(result.size.toULong(), 4).copyInto(result, destinationOffset = magic.size + 2)
      return result
    }

    val zeroHeader = body(ByteArray(32))
    val hash = MessageDigest.getInstance("SHA-256").apply {
      update(zeroHeader)
      update(payload)
    }.digest()
    return SerializedHeader(body(hash), zeroHeader, hash)
  }

  fun canonicalDecimal(value: String, signed: Boolean, bits: Int): Boolean {
    if (!Regex("^-?(0|[1-9][0-9]*)$").matches(value) || value == "-0") return false
    val parsed = try { BigInteger(value) } catch (_: NumberFormatException) { return false }
    val maximum = if (signed) BigInteger.ONE.shiftLeft(bits - 1).subtract(BigInteger.ONE)
      else BigInteger.ONE.shiftLeft(bits).subtract(BigInteger.ONE)
    val minimum = if (signed) BigInteger.ONE.shiftLeft(bits - 1).negate() else BigInteger.ZERO
    return parsed >= minimum && parsed <= maximum
  }

  fun validIdentifier(raw: ByteArray): Boolean {
    if (raw.isEmpty() || raw.size > 128 || raw.any { (it.toInt() and 0xff) >= 128 }) return false
    val decoded = try {
      StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(raw)).toString()
    } catch (_: Exception) { return false }
    return Regex("^[A-Za-z0-9][A-Za-z0-9._:-]*$").matches(decoded)
  }

  data class OtlpProfiles(val unknownPaths: List<String>, val normalized: JsonObject)

  fun otlpProfiles(descriptor: JsonObject, request: JsonObject): OtlpProfiles {
    val paths = mutableListOf<String>()
    val normalized = walkOtlp(descriptor, "ExportLogsServiceRequest", request, "$", paths)
    return OtlpProfiles(paths.sorted(), normalized)
  }

  private fun walkOtlp(
    descriptor: JsonObject,
    message: String,
    value: JsonObject,
    path: String,
    unknownPaths: MutableList<String>
  ): JsonObject {
    val otlp = descriptor.getAsJsonObject("otlp")
    val allowed = otlp.getAsJsonObject("messages").getAsJsonArray(message).map { it.asString }.toSet()
    val children = otlp.getAsJsonObject("children").getAsJsonObject(message)
    val result = JsonObject()
    value.entrySet().forEach { (key, child) ->
      if (key !in allowed) {
        unknownPaths.add("$path.$key")
        return@forEach
      }
      val relation = children?.getAsJsonObject(key)
      if (relation == null) {
        result.add(key, child.deepCopy())
      } else if (relation.get("repeated").asBoolean && child.isJsonArray) {
        val normalized = com.google.gson.JsonArray()
        child.asJsonArray.forEachIndexed { index, entry ->
          normalized.add(
            if (entry.isJsonObject) walkOtlp(
              descriptor, relation.get("message").asString, entry.asJsonObject,
              "$path.$key[$index]", unknownPaths
            ) else entry.deepCopy()
          )
        }
        result.add(key, normalized)
      } else if (!relation.get("repeated").asBoolean && child.isJsonObject) {
        result.add(
          key,
          walkOtlp(
            descriptor, relation.get("message").asString, child.asJsonObject,
            "$path.$key", unknownPaths
          )
        )
      } else {
        result.add(key, child.deepCopy())
      }
    }
    return result
  }

  fun otlpSemanticCaseValid(vector: JsonObject, descriptor: JsonObject): Boolean {
    val kind = vector.get("kind").asString
    val json = vector.get("json").asString
    if (kind == "duplicateKey") {
      return hasNoDuplicateKeys(json)
    }
    val value = try { JsonParser.parseString(json).asJsonObject } catch (_: Exception) { return false }
    val otlp = descriptor.getAsJsonObject("otlp")
    if (kind == "timeUnixNano" || kind == "observedTimeUnixNano") {
      val timestamp = value.get(kind) ?: return false
      return timestamp.isJsonPrimitive && timestamp.asJsonPrimitive.isString &&
        canonicalDecimal(timestamp.asString, signed = false, bits = 64)
    }
    if (kind == "u32") {
      val number = value.get(vector.get("field").asString) ?: return false
      if (!number.isJsonPrimitive || !number.asJsonPrimitive.isNumber) return false
      val parsed = number.asDouble
      return parsed.isFinite() && parsed % 1.0 == 0.0 && parsed >= 0 && parsed <= 4294967295.0
    }
    if (kind == "severityNumber") {
      val severity = value.get("severityNumber") ?: return false
      if (!severity.isJsonPrimitive || !severity.asJsonPrimitive.isNumber) return false
      val number = severity.asDouble
      val range = otlp.getAsJsonObject("severityNumber")
      return number.isFinite() && number % 1.0 == 0.0 &&
        number >= range.get("minimum").asInt && number <= range.get("maximum").asInt
    }
    if (kind == "AnyValue") {
      val arms = otlp.getAsJsonArray("anyValueArms").map { it.asString }
      return anyValueValid(value, arms)
    }
    return false
  }

  private fun hasNoDuplicateKeys(json: String): Boolean {
    class Parser {
      var cursor = 0

      fun whitespace() {
        while (cursor < json.length && json[cursor].isWhitespace()) cursor++
      }

      fun stringToken(): String {
        require(cursor < json.length && json[cursor] == '"')
        val start = cursor++
        while (cursor < json.length) {
          if (json[cursor] == '\\') cursor += 2
          else if (json[cursor++] == '"') {
            return JsonParser.parseString(json.substring(start, cursor)).asString
          }
        }
        throw IllegalArgumentException("unterminated string")
      }

      fun value(): Boolean {
        whitespace()
        require(cursor < json.length)
        if (json[cursor] == '{') {
          cursor++
          whitespace()
          val keys = mutableSetOf<String>()
          if (cursor < json.length && json[cursor] == '}') { cursor++; return true }
          while (cursor < json.length) {
            if (!keys.add(stringToken())) return false
            whitespace()
            require(cursor < json.length && json[cursor++] == ':')
            if (!value()) return false
            whitespace()
            require(cursor < json.length)
            val separator = json[cursor++]
            if (separator == '}') return true
            require(separator == ',')
            whitespace()
          }
        } else if (json[cursor] == '[') {
          cursor++
          whitespace()
          if (cursor < json.length && json[cursor] == ']') { cursor++; return true }
          while (cursor < json.length) {
            if (!value()) return false
            whitespace()
            require(cursor < json.length)
            val separator = json[cursor++]
            if (separator == ']') return true
            require(separator == ',')
          }
        } else if (json[cursor] == '"') {
          stringToken()
          return true
        } else {
          val start = cursor
          while (cursor < json.length && !json[cursor].isWhitespace() && json[cursor] !in ",}]") cursor++
          JsonParser.parseString(json.substring(start, cursor))
          return true
        }
        throw IllegalArgumentException("unterminated JSON container")
      }
    }
    return try {
      val parser = Parser()
      val valid = parser.value()
      parser.whitespace()
      valid && parser.cursor == json.length
    } catch (_: Exception) { false }
  }

  private fun anyValueValid(value: JsonObject, arms: List<String>): Boolean {
    val present = arms.filter(value::has)
    if (present.size != 1 || value.size() != 1) return false
    val arm = present.single()
    val payload = value.get(arm)
    if (arm == "stringValue") return payload.isJsonPrimitive && payload.asJsonPrimitive.isString
    if (arm == "boolValue") return payload.isJsonPrimitive && payload.asJsonPrimitive.isBoolean
    if (arm == "intValue") return payload.isJsonPrimitive && payload.asJsonPrimitive.isString &&
      canonicalDecimal(payload.asString, signed = true, bits = 64)
    if (arm == "doubleValue") return payload.isJsonPrimitive && payload.asJsonPrimitive.isNumber &&
      payload.asDouble.isFinite()
    if (arm == "bytesValue") {
      if (!payload.isJsonPrimitive || !payload.asJsonPrimitive.isString) return false
      return try {
        Base64.getEncoder().encodeToString(Base64.getDecoder().decode(payload.asString)) == payload.asString
      } catch (_: IllegalArgumentException) { false }
    }
    if (arm == "arrayValue") {
      if (!payload.isJsonObject || payload.asJsonObject.keySet() != setOf("values")) return false
      val values = payload.asJsonObject.get("values")
      if (values == null || !values.isJsonArray) return false
      return values.asJsonArray.all {
        it.isJsonObject && anyValueValid(it.asJsonObject, arms)
      }
    }
    if (arm == "kvlistValue") {
      if (!payload.isJsonObject || payload.asJsonObject.keySet() != setOf("values")) return false
      val values = payload.asJsonObject.get("values")
      if (values == null || !values.isJsonArray) return false
      val keys = mutableSetOf<String>()
      return values.asJsonArray.all {
        if (!it.isJsonObject) return@all false
        val entry = it.asJsonObject
        if (entry.keySet() != setOf("key", "value") || !entry.get("key").isJsonPrimitive ||
          !entry.get("key").asJsonPrimitive.isString || !entry.get("value").isJsonObject) return@all false
        val key = entry.get("key").asString
        keys.add(key) && anyValueValid(entry.getAsJsonObject("value"), arms)
      }
    }
    return false
  }

  private fun integer(bytes: ByteArray, offset: Int, count: Int): Long {
    if (offset < 0 || count <= 0 || offset + count > bytes.size) return -1
    var value = 0L
    for (index in offset until offset + count) value = (value shl 8) or (bytes[index].toLong() and 0xff)
    return value
  }

  private fun unsignedInteger(bytes: ByteArray, offset: Int, count: Int): ULong {
    if (offset < 0 || count <= 0 || offset + count > bytes.size) return ULong.MAX_VALUE
    var value = 0uL
    for (index in offset until offset + count) {
      value = (value shl 8) or (bytes[index].toInt() and 0xff).toULong()
    }
    return value
  }

  private fun integerBytes(value: ULong, count: Int): ByteArray = ByteArray(count) { index ->
    ((value shr ((count - index - 1) * 8)) and 0xffu).toByte()
  }
}
