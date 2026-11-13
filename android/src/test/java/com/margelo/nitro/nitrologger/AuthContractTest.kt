package com.margelo.nitro.nitrologger

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Test
import java.io.File
import java.security.MessageDigest

class AuthContractTest {
  private fun objectFrom(name: String) = JsonParser.parseString(contractFile(name).readText()).asJsonObject

  private fun contractFile(name: String): File {
    val root = System.getProperty("nitroLogger.repoRoot")
      ?: throw AssertionError("nitroLogger.repoRoot is unset")
    return File(root, "spec/wire/v1/$name")
  }

  @Test
  fun `delivery capability scope and authority are exact`() {
    assertEquals(
      "50209450c1c742ca218b5b4e2fe1232888dc4764f1e3cab5e6c1a1198f75a38b",
      MessageDigest.getInstance("SHA-256").digest(contractFile("auth-contract.json").readBytes()).joinToString("") {
        "%02x".format(it)
      }
    )
    val contract = objectFrom("auth-contract.json")
    assertEquals(1, contract.get("contractVersion").asInt)
    assertEquals(
      listOf(
        "tenantId", "analyticsStream", "installId", "subjectScope",
        "identityGeneration", "consentGeneration"
      ),
      contract.getAsJsonObject("scope").getAsJsonArray("fields").map { it.asString }
    )
    assertEquals(
      listOf("exchange-self", "deliver-manifested-segment"),
      contract.getAsJsonObject("deliveryCapability").getAsJsonArray("authority").map { it.asString }
    )
    assertEquals(
      listOf(
        "collect", "identify-or-bind", "manifest-register", "scope-change",
        "deadline-extension", "root-rotation"
      ),
      contract.getAsJsonObject("deliveryCapability").getAsJsonArray("forbiddenAuthority").map { it.asString }
    )
    val capability = contract.getAsJsonObject("deliveryCapability")
    assertEquals(false, capability.get("rawCredentialLogging").asBoolean)
    assertEquals("secure-platform-storage", capability.get("deviceStorage").asString)
    assertEquals("verifier-only", capability.getAsJsonObject("serverStorage").get("secret").asString)
    assertEquals("constant-time", capability.getAsJsonObject("serverStorage").get("comparison").asString)
    assertEquals("encrypted-at-rest", capability.getAsJsonObject("serverStorage").get("recoverableResponses").asString)
    assertEquals(true, contract.getAsJsonObject("resourceControls").get("boundedConcurrency").asBoolean)
    assertEquals(true, contract.getAsJsonObject("resourceControls").get("publicThrottleIndistinguishable").asBoolean)
    val audit = contract.getAsJsonObject("audit")
    assertEquals(listOf("bearerSecret", "payload", "rawSubjectId", "rawCredentialId"), audit.getAsJsonArray("forbiddenFields").map { it.asString })
    assertEquals("keyed", audit.get("identifierHash").asString)
    assertEquals("fail-closed", audit.get("authorizationOnAuditFailure").asString)
    val operations = contract.getAsJsonObject("operations")
    assertEquals(setOf("capabilityMint", "capabilityExchange", "manifestRegister"), operations.keySet())
    val expected = mapOf(
      "capabilityMint" to listOf(
        "/v1/delivery-capabilities:mint", "contractVersion,operation,mintId,scope",
        "credentialId,bearerSecret,issuedAt,expiresAt,deliveryDeadline", "201",
        "contractVersion,operation,credentialId,bearerSecret,issuedAt,expiresAt,deliveryDeadline"
      ),
      "capabilityExchange" to listOf(
        "/v1/delivery-capabilities:exchange", "contractVersion,operation,exchangeId",
        "scope,expiresAt,deliveryDeadline", "200",
        "contractVersion,operation,credentialId,bearerSecret,issuedAt,expiresAt,deliveryDeadline"
      ),
      "manifestRegister" to listOf(
        "/v1/segment-manifests", "contractVersion,operation,segmentId,contentHash,scope",
        "payload,acceptanceEpoch", "201", "contractVersion,operation,segmentId,contentHash"
      )
    )
    expected.forEach { (name, pin) ->
      val operation = operations.getAsJsonObject(name)
      val request = operation.getAsJsonObject("request")
      val response = operation.getAsJsonObject("response")
      assertEquals("POST", request.get("method").asString)
      assertEquals("application/json", request.get("contentType").asString)
      assertEquals(pin[0], request.get("path").asString)
      assertEquals(pin[1], request.getAsJsonArray("requiredFields").joinToString(",") { it.asString })
      assertEquals(pin[2], request.getAsJsonArray("forbiddenFields").joinToString(",") { it.asString })
      assertEquals(pin[3], response.get("status").asString)
      assertEquals(pin[4], response.getAsJsonArray("requiredFields").joinToString(",") { it.asString })
    }
    assertEquals("capability-mint", operations.getAsJsonObject("capabilityMint").get("operation").asString)
    assertEquals("live-session-or-tenant-backend", operations.getAsJsonObject("capabilityMint").getAsJsonObject("request").get("authorization").asString)
    assertEquals("mintId", operations.getAsJsonObject("capabilityMint").getAsJsonObject("request").get("idempotencyField").asString)
    assertEquals("capability-exchange", operations.getAsJsonObject("capabilityExchange").get("operation").asString)
    assertEquals("delivery-capability", operations.getAsJsonObject("capabilityExchange").getAsJsonObject("request").get("authorization").asString)
    assertEquals("exchangeId", operations.getAsJsonObject("capabilityExchange").getAsJsonObject("request").get("idempotencyField").asString)
    assertEquals("manifest-register", operations.getAsJsonObject("manifestRegister").get("operation").asString)
    assertEquals("live-session", operations.getAsJsonObject("manifestRegister").getAsJsonObject("request").get("authorization").asString)
    assertEquals(200, operations.getAsJsonObject("manifestRegister").getAsJsonObject("response").get("idempotentStatus").asInt)
    assertEquals(
      mapOf(
        "unknownContractVersion" to "refused",
        "unknownOperation" to "refused",
        "unknownRequestField" to "refused",
        "additionalResponseField" to "malformed-contract-response"
      ),
      contract.getAsJsonObject("compatibility").entrySet().associate { it.key to it.value.asString }
    )
    val refused = contract.getAsJsonObject("publicResponses").getAsJsonObject("refused")
    assertEquals("application/json", refused.get("contentType").asString)
    assertEquals(true, refused.get("terminalOnlyWhenSchemaMatches").asBoolean)
    assertEquals("indeterminate", refused.get("malformedClassification").asString)
    val refusalBody = refused.getAsJsonObject("body")
    assertEquals(listOf("contractVersion", "operation", "code"), refusalBody.getAsJsonArray("requiredFields").map { it.asString })
    assertEquals(false, refusalBody.get("additionalFields").asBoolean)
    assertEquals(1, refusalBody.get("contractVersion").asInt)
    assertEquals("echo-request-operation", refusalBody.get("operation").asString)
    assertEquals("refused", refusalBody.get("code").asString)
  }

  @Test
  fun `auth vector groups are non-vacuous and unique`() {
    val contract = objectFrom("auth-contract.json")
    val sets = objectFrom("auth-vectors.json").getAsJsonObject("vectorSets")
    assertEquals(
      setOf(
        "scope", "mint", "exchange", "registration", "responses",
        "resourceControls", "audit", "lifecycleRaces", "crashRecovery"
      ),
      sets.keySet()
    )
    sets.entrySet().forEach { (name, element) ->
      val rows = element.asJsonArray
      assertFalse("$name must not be vacuous", rows.isEmpty)
      val ids = rows.map { it.asJsonObject.get("id").asString }
      assertEquals("duplicate vector id in $name", ids.size, ids.toSet().size)
      rows.forEach {
        val row = it.asJsonObject
        assertEquals(
          row.get("id").asString,
          row.get("expected").asString,
          AuthContractSupport.evaluate(contract, name, row)
        )
      }
    }
    val table = objectFrom("resolution-table.json")
    val mutations = table.getAsJsonArray("linearizedMutations").map { it.asString }
    val transitions = table.getAsJsonArray("lifecycleTransitions").map { it.asString }
    val expectedRaces = mutations.flatMap { mutation ->
      transitions.flatMap { transition ->
        listOf("mutation", "transition").map { "$mutation|$transition|$it" }
      }
    }
    assertEquals(
      expectedRaces,
      sets.getAsJsonArray("lifecycleRaces").map {
        val input = it.asJsonObject.getAsJsonObject("input")
        "${input.get("mutation").asString}|${input.get("transition").asString}|${input.get("winner").asString}"
      }
    )
  }

  @Test
  fun `resolution and transaction order are pinned`() {
    val table = objectFrom("resolution-table.json")
    assertEquals(
      listOf(
        "validate-credential-and-scope", "consult-current-epoch-ledger",
        "resolve-immutable-ledger-outcome", "require-live-binding-and-manifest",
        "commit-inbox-ledger-audit"
      ),
      table.getAsJsonArray("evaluationOrder").map { it.asString }
    )
    assertEquals(
      listOf(
        "credential-or-scope-invalid", "ledger-same-id-same-hash",
        "ledger-same-id-different-hash", "no-ledger-binding-inactive",
        "no-ledger-manifest-missing", "no-ledger-live-manifest-match",
        "post-rebuild-deleted-binding"
      ),
      table.getAsJsonArray("resolutionRows").map { it.asJsonObject.get("id").asString }
    )
    table.getAsJsonArray("resolutionRows").forEach {
      val row = it.asJsonObject
      assertEquals(
        row.get("id").asString,
        row.getAsJsonObject("expected").get("action").asString,
        AuthContractSupport.resolve(row.getAsJsonObject("when"))
      )
    }
    assertEquals(
      listOf(
        "manifest-registration", "acceptance-inbox-ledger-audit",
        "acknowledgement-emission", "audit-publication"
      ),
      table.getAsJsonArray("transactionRows").map { it.asJsonObject.get("id").asString }
    )
    val transactions = table.getAsJsonArray("transactionRows").map { it.asJsonObject }
    assertEquals(listOf("exact-manifest-record", "success-audit-intent"), transactions[0].getAsJsonArray("state").map { it.asString })
    assertEquals("atomic-before-or-with-acceptance", transactions[0].get("commit").asString)
    assertEquals(listOf("inbox-bytes", "same-epoch-ledger-outcome", "success-audit-intent"), transactions[1].getAsJsonArray("state").map { it.asString })
    assertEquals("single-acceptance-boundary", transactions[1].get("commit").asString)
    assertEquals(listOf("durable-inbox", "durable-ledger-outcome", "durable-audit-intent"), transactions[2].getAsJsonArray("requires").map { it.asString })
    assertEquals("replay-ledger-outcome", transactions[2].get("lostResponse").asString)
    assertEquals(listOf("durable-audit-intent"), transactions[3].getAsJsonArray("requires").map { it.asString })
    assertEquals("queue-and-retry", transactions[3].get("outage").asString)
  }
}
