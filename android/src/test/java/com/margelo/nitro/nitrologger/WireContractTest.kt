package com.margelo.nitro.nitrologger

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class WireContractTest {
  private fun contractFile(name: String): File {
    val root = System.getProperty("nitroLogger.repoRoot")
      ?: throw AssertionError("nitroLogger.repoRoot is unset")
    return File(root, "spec/wire/v1/$name")
  }

  private fun requestContaining(message: String, value: com.google.gson.JsonObject): com.google.gson.JsonObject {
    fun obj(name: String, child: com.google.gson.JsonElement) = com.google.gson.JsonObject().apply { add(name, child) }
    fun array(child: com.google.gson.JsonElement) = com.google.gson.JsonArray().apply { add(child) }
    return when (message) {
      "ExportLogsServiceRequest" -> value
      "ResourceLogs" -> obj("resourceLogs", array(value))
      "Resource" -> obj("resourceLogs", array(obj("resource", value)))
      "ScopeLogs" -> obj("resourceLogs", array(obj("scopeLogs", array(value))))
      "InstrumentationScope" -> obj("resourceLogs", array(obj("scopeLogs", array(obj("scope", value)))))
      "LogRecord" -> obj("resourceLogs", array(obj("scopeLogs", array(obj("logRecords", array(value))))))
      "KeyValue" -> obj("resourceLogs", array(obj("resource", obj("attributes", array(value)))))
      "AnyValue" -> obj("resourceLogs", array(obj("scopeLogs", array(obj("logRecords", array(obj("body", value)))))))
      else -> requestContaining("AnyValue", obj(if (message == "ArrayValue") "arrayValue" else "kvlistValue", value))
    }
  }

  private fun withoutKey(value: com.google.gson.JsonElement, removed: String): com.google.gson.JsonElement {
    if (value.isJsonArray) {
      return com.google.gson.JsonArray().apply {
        value.asJsonArray.forEach { add(withoutKey(it, removed)) }
      }
    }
    if (value.isJsonObject) {
      return com.google.gson.JsonObject().apply {
        value.asJsonObject.entrySet().forEach { (key, child) ->
          if (key != removed) add(key, withoutKey(child, removed))
        }
      }
    }
    return value.deepCopy()
  }

  @Test
  fun `the shared wire contract exists and declares v1`() {
    val descriptor = contractFile("contract.json")
    val vectors = contractFile("golden-vectors.json")
    assertTrue("no descriptor at ${descriptor.absolutePath}", descriptor.isFile)
    assertTrue("no vectors at ${vectors.absolutePath}", vectors.isFile)
    val root = JsonParser.parseString(descriptor.readText()).asJsonObject
    assertEquals(1, root.get("contractVersion").asInt)
    assertEquals("1.11.0", root.getAsJsonObject("upstream").get("otlpSpecification").asString)
    assertEquals("v1.10.0", root.getAsJsonObject("upstream").get("protobufDefinitions").asString)
    assertEquals(1, root.getAsJsonObject("header").get("version").asInt)
    assertEquals("big-endian", root.getAsJsonObject("header").get("byteOrder").asString)
    assertEquals("sha256", root.getAsJsonObject("header").get("hash").asString)
    val fields = root.getAsJsonObject("header").getAsJsonArray("fields").map { it.asJsonObject }
    assertEquals(
      listOf(
        "magic", "headerVersion", "headerLength", "segmentId", "contentHash",
        "tenantId", "streamId", "sourceEpoch", "schemaVersion",
        "consentGeneration", "recordCount", "payloadLength"
      ),
      fields.map { it.get("name").asString }
    )
    assertEquals(
      listOf(
        "fixed-bytes", "u16", "u32", "fixed-bytes", "fixed-bytes", "ascii",
        "ascii", "ascii", "u32", "u64", "u32", "u64"
      ),
      fields.map { it.get("encoding").asString }
    )
    assertEquals(
      listOf(8, 2, 4, 16, 32, 128, 128, 128, 4, 8, 4, 8),
      fields.map { if (it.has("bytes")) it.get("bytes").asInt else it.get("maxBytes").asInt }
    )
  }

  @Test
  fun `every shared vector group is non-empty`() {
    val vectorFile = contractFile("golden-vectors.json")
    assertEquals(
      "fba17acea318ed21799eab6fb961c34bd49e26ad361e781850cbe4dfda789910",
      MessageDigest.getInstance("SHA-256").digest(vectorFile.readBytes()).joinToString("") {
        "%02x".format(it)
      }
    )
    val root = JsonParser.parseString(vectorFile.readText()).asJsonObject
    listOf(
      "validSegments",
      "invalidSegments",
      "numericCases",
      "identifierCases",
      "otlpSemanticCases",
      "unknownFieldCases"
    ).forEach {
      assertFalse("vector group $it must not be vacuous", root.getAsJsonArray(it).isEmpty)
    }
  }

  @Test
  fun `every stored header and corruption classification agrees`() {
    val descriptor = WireContractSupport.objectFrom("contract.json")
    val vectors = WireContractSupport.objectFrom("golden-vectors.json")
    vectors.getAsJsonArray("validSegments").forEach { element ->
      val row = element.asJsonObject
      val payload = WireContractSupport.bytes(row.get("payloadHex").asString)
      val serialized = WireContractSupport.serialize(
        row.getAsJsonObject("fields"),
        payload,
        descriptor
      )
      assertTrue(
        row.get("name").asString,
        serialized.zeroHeader.contentEquals(WireContractSupport.bytes(row.get("expectedZeroHeaderHex").asString))
      )
      assertTrue(
        row.get("name").asString,
        serialized.hash.contentEquals(WireContractSupport.bytes(row.get("expectedHashHex").asString))
      )
      assertTrue(
        row.get("name").asString,
        serialized.header.contentEquals(WireContractSupport.bytes(row.get("expectedHeaderHex").asString))
      )
      assertEquals(
        "valid",
        WireContractSupport.classify(
          WireContractSupport.bytes(row.get("expectedHeaderHex").asString),
          payload,
          descriptor
        )
      )
    }
    vectors.getAsJsonArray("invalidSegments").forEach { element ->
      val row = element.asJsonObject
      assertEquals(
        row.get("name").asString,
        row.get("expected").asString,
        WireContractSupport.classify(
          WireContractSupport.bytes(row.get("headerHex").asString),
          WireContractSupport.bytes(row.get("payloadHex").asString),
          descriptor
        )
      )
    }
  }

  @Test
  fun `every numeric boundary agrees`() {
    val vectors = WireContractSupport.objectFrom("golden-vectors.json")
    vectors.getAsJsonArray("numericCases").forEach {
      val row = it.asJsonObject
      assertEquals(
        row.get("name").asString,
        row.get("valid").asBoolean,
        WireContractSupport.canonicalDecimal(
          row.get("value").asString,
          row.get("signed").asBoolean,
          row.get("bits").asInt
        )
      )
    }
    vectors.getAsJsonArray("identifierCases").forEach {
      val row = it.asJsonObject
      assertEquals(
        row.get("name").asString,
        row.get("valid").asBoolean,
        WireContractSupport.validIdentifier(WireContractSupport.bytes(row.get("rawHex").asString))
      )
    }
  }

  @Test
  fun `strict unknown field inventory uses the original object`() {
    val descriptor = WireContractSupport.objectFrom("contract.json")
    val messages = descriptor.getAsJsonObject("otlp").getAsJsonObject("messages")
    val rows = WireContractSupport.objectFrom("golden-vectors.json").getAsJsonArray("unknownFieldCases")
    assertEquals(messages.size(), rows.size())
    rows.forEach {
      val row = it.asJsonObject
      val message = row.get("message").asString
      val allowed = messages.getAsJsonArray(message).map { field -> field.asString }.toSet()
      val original = JsonParser.parseString(row.get("json").asString).asJsonObject
      val unknown = original.keySet().filterNot { field -> field in allowed }
      assertEquals(listOf(row.get("unknownField").asString), unknown)
      val profiles = WireContractSupport.otlpProfiles(
        descriptor,
        requestContaining(message, original)
      )
      assertEquals(1, profiles.unknownPaths.size)
      assertEquals(
        withoutKey(requestContaining(message, original), row.get("unknownField").asString),
        profiles.normalized
      )
      assertTrue(WireContractSupport.otlpProfiles(descriptor, profiles.normalized).unknownPaths.isEmpty())
    }
  }

  @Test
  fun `OTLP semantic vectors agree`() {
    val descriptor = WireContractSupport.objectFrom("contract.json")
    val vectors = WireContractSupport.objectFrom("golden-vectors.json")
    vectors.getAsJsonArray("otlpSemanticCases").forEach {
      val row = it.asJsonObject
      assertEquals(
        row.get("name").asString,
        row.get("valid").asBoolean,
        WireContractSupport.otlpSemanticCaseValid(row, descriptor)
      )
    }
  }
}
