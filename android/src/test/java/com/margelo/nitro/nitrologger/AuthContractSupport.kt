package com.margelo.nitro.nitrologger

import com.google.gson.JsonObject

object AuthContractSupport {
  private fun text(input: JsonObject, name: String): String? =
    input.get(name)?.takeUnless { it.isJsonNull }?.asString

  private fun exactScope(fields: List<String>, presented: JsonObject?, derived: JsonObject?): Boolean =
    presented?.keySet() == fields.toSet() && derived?.keySet() == fields.toSet() && fields.all { field ->
      presented?.has(field) == true && derived?.has(field) == true &&
        presented.get(field).isJsonPrimitive && presented.get(field).asJsonPrimitive.isString &&
        text(presented, field) == text(derived, field)
    }

  private val mutations = setOf(
    "capability-mint", "capability-exchange", "manifest-registration", "upload-acceptance"
  )
  private val transitions = setOf(
    "subject-deletion", "consent-revocation", "tenant-or-binding-disable",
    "generation-change", "delivery-deadline"
  )

  private fun validRefusal(input: JsonObject): Boolean {
    if (text(input, "contentType") != "application/json" || !input.get("body")?.isJsonObject.orFalse()) return false
    val body = input.getAsJsonObject("body")
    val version = body.get("contractVersion")
    val operation = body.get("operation")
    val code = body.get("code")
    return body.keySet() == setOf("contractVersion", "operation", "code") &&
      version?.isJsonPrimitive == true && version.asJsonPrimitive.isNumber &&
      runCatching { version.asInt }.getOrNull() == 1 &&
      operation?.isJsonPrimitive == true && operation.asJsonPrimitive.isString &&
      operation.asString == text(input, "requestOperation") &&
      code?.isJsonPrimitive == true && code.asJsonPrimitive.isString && code.asString == "refused"
  }

  private fun Boolean?.orFalse() = this == true

  fun evaluate(contract: JsonObject, group: String, row: JsonObject): String? {
    val input = row.getAsJsonObject("input")
    val fields = contract.getAsJsonObject("scope").getAsJsonArray("fields").map { it.asString }
    return when (group) {
      "scope" -> if (exactScope(fields, input.getAsJsonObject("presented"), input.getAsJsonObject("derived"))) "allow" else "refuse"
      "mint" -> when {
        text(input, "operation") == "root-rotation" -> "refuse"
        input.has("newGeneration") -> "invalidate-old-then-mint"
        text(input, "authority") !in setOf("live-session", "tenant-backend") -> "refuse"
        input.has("derivedScope") && !exactScope(fields, input.getAsJsonObject("scopeClaim"), input.getAsJsonObject("derivedScope")) -> "refuse"
        text(input, "binding") == "consent-revoked" -> "refuse"
        input.has("existingMintId") && text(input, "existingMintId") == text(input, "mintId") -> "replay-exact-response"
        input.has("existingMintId") -> "refuse"
        input.has("existingRoot") && !input.get("existingRoot").asBoolean -> "mint-and-record"
        else -> "mint-root"
      }
      "exchange" -> when {
        input.get("atDeadline")?.asBoolean == true || input.get("afterDeadline")?.asBoolean == true -> "refuse"
        text(input, "credential") in setOf("forged", "restored-consumed") -> "refuse"
        text(input, "binding") == "disabled" -> "refuse"
        input.has("recordedExchangeId") && text(input, "recordedExchangeId") == text(input, "exchangeId") -> "replay-exact-response"
        input.has("recordedExchangeId") -> "refuse"
        input.has("deliveryDeadline") -> "successor-expires-no-later-than-delivery-deadline"
        else -> "consume-mint-record"
      }
      "registration" -> when {
        input.has("uploads") -> "exercise-without-consuming"
        text(input, "authority") != "live-session" -> "refuse"
        input.has("derivedScope") && !exactScope(fields, input.getAsJsonObject("scopeClaim"), input.getAsJsonObject("derivedScope")) -> "refuse"
        text(input, "record") == "same-id-different-hash" -> "refuse"
        text(input, "record") == "same-id-same-hash" -> "idempotent"
        else -> "create"
      }
      "responses" -> when {
        input.get("status").asInt == 403 -> if (validRefusal(input)) "terminal" else "indeterminate-retry-same-id"
        input.get("status").asInt == 429 && input.get("remainingDeadlineSeconds")?.asInt == 0 -> "do-not-attempt"
        input.get("status").asInt == 429 -> {
          val raw = text(input, "retryAfter")
          val delay = raw?.toIntOrNull()
          if (delay == null || delay.toString() != raw || delay !in 1..60) "indeterminate-local-backoff"
          else "retry-after-${minOf(delay, input.get("remainingDeadlineSeconds")?.asInt ?: delay)}"
        }
        else -> "indeterminate-retry-same-id"
      }
      "resourceControls" -> if (input.get("saturated")?.asBoolean == true) "generic-throttle" else "allow"
      "audit" -> when {
        text(input, "wal") == "full" -> "non-droppable-aggregate-loss-signal"
        text(input, "wal") == "available" -> "durable-refusal-event"
        text(input, "publication") == "unavailable" -> "queue-and-retry"
        input.has("deliveryAttempts") -> "one-logical-event"
        input.get("stateCommit")?.asBoolean == true && input.get("auditIntentCommit")?.asBoolean == true -> "acknowledge"
        else -> "fail-without-success"
      }
      "lifecycleRaces" -> when {
        text(input, "mutation") !in mutations || text(input, "transition") !in transitions ||
          text(input, "winner") !in setOf("mutation", "transition") -> "invalid-vector"
        text(input, "winner") == "mutation" -> "commit-then-invalidate"
        else -> "no-new-authority-or-success-state"
      }
      "crashRecovery" -> when {
        text(input, "crashAt") == "before-state-and-audit-commit" -> "no-root-no-success-event"
        text(input, "crashAt") == "after-state-and-audit-commit" && input.get("sameMintIdRetry")?.asBoolean == true -> "replay-exact-root"
        text(input, "crashAt") == "before-predecessor-consume" -> "predecessor-remains-live"
        text(input, "crashAt") == "after-successor-and-audit-commit" && input.get("sameExchangeIdRetry")?.asBoolean == true -> "replay-exact-successor"
        text(input, "crashAt") == "after-inbox-ledger-audit-commit" -> "replay-recorded-ack"
        text(input, "crashAt") == "after-audit-intent-commit" -> "publish-idempotently-after-restart"
        else -> "invalid-vector"
      }
      else -> null
    }
  }

  fun resolve(input: JsonObject): String = when {
    text(input, "credentialOrScope") == "invalid" -> "refuse"
    text(input, "ledger") == "same-id-same-hash" -> "replay-recorded-outcome"
    text(input, "ledger") == "same-id-different-hash" -> "refuse"
    text(input, "binding") != "live" -> "refuse"
    text(input, "manifest") != "exact-match" -> "refuse"
    else -> "commit-acceptance"
  }
}
