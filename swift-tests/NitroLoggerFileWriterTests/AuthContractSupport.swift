import Foundation

enum AuthContractSupport {
  private static func text(_ object: [String: Any], _ key: String) -> String? {
    object[key] as? String
  }

  private static func exactScope(
    _ fields: [String], _ presented: [String: Any]?, _ derived: [String: Any]?
  ) -> Bool {
    guard Set(presented?.keys ?? Dictionary<String, Any>().keys) == Set(fields),
          Set(derived?.keys ?? Dictionary<String, Any>().keys) == Set(fields) else { return false }
    return fields.allSatisfy { field in
      guard let left = presented?[field] as? String,
            let right = derived?[field] as? String else { return false }
      return left == right
    }
  }

  private static let mutations = [
    "capability-mint", "capability-exchange", "manifest-registration", "upload-acceptance",
  ]
  private static let transitions = [
    "subject-deletion", "consent-revocation", "tenant-or-binding-disable",
    "generation-change", "delivery-deadline",
  ]

  private static func validRefusal(_ input: [String: Any]) -> Bool {
    guard text(input, "contentType") == "application/json",
          let body = input["body"] as? [String: Any],
          Set(body.keys) == Set(["contractVersion", "operation", "code"]),
          body["contractVersion"] as? Int == 1,
          body["operation"] as? String == text(input, "requestOperation"),
          body["code"] as? String == "refused" else { return false }
    return true
  }

  static func evaluate(
    contract: [String: Any], group: String, row: [String: Any]
  ) -> String? {
    guard let input = row["input"] as? [String: Any],
          let scope = contract["scope"] as? [String: Any],
          let fields = scope["fields"] as? [String] else { return nil }
    if group == "scope" {
      return exactScope(
        fields, input["presented"] as? [String: Any], input["derived"] as? [String: Any]
      ) ? "allow" : "refuse"
    }
    if group == "mint" {
      if text(input, "operation") == "root-rotation" { return "refuse" }
      if input["newGeneration"] != nil { return "invalidate-old-then-mint" }
      guard ["live-session", "tenant-backend"].contains(text(input, "authority")) else {
        return "refuse"
      }
      if let claim = input["scopeClaim"] as? [String: Any],
         let derived = input["derivedScope"] as? [String: Any],
         !exactScope(fields, claim, derived) { return "refuse" }
      if text(input, "binding") == "consent-revoked" { return "refuse" }
      if let existing = text(input, "existingMintId") {
        return existing == text(input, "mintId") ? "replay-exact-response" : "refuse"
      }
      if input["existingRoot"] as? Bool == false { return "mint-and-record" }
      return "mint-root"
    }
    if group == "exchange" {
      if input["atDeadline"] as? Bool == true || input["afterDeadline"] as? Bool == true {
        return "refuse"
      }
      if ["forged", "restored-consumed"].contains(text(input, "credential")) { return "refuse" }
      if text(input, "binding") == "disabled" { return "refuse" }
      if let recorded = text(input, "recordedExchangeId") {
        return recorded == text(input, "exchangeId") ? "replay-exact-response" : "refuse"
      }
      if input["deliveryDeadline"] != nil {
        return "successor-expires-no-later-than-delivery-deadline"
      }
      return "consume-mint-record"
    }
    if group == "registration" {
      if input["uploads"] != nil { return "exercise-without-consuming" }
      if text(input, "authority") != "live-session" { return "refuse" }
      if let claim = input["scopeClaim"] as? [String: Any],
         let derived = input["derivedScope"] as? [String: Any],
         !exactScope(fields, claim, derived) { return "refuse" }
      if text(input, "record") == "same-id-different-hash" { return "refuse" }
      if text(input, "record") == "same-id-same-hash" { return "idempotent" }
      return "create"
    }
    if group == "responses" {
      let status = input["status"] as? Int
      if status == 403 { return validRefusal(input) ? "terminal" : "indeterminate-retry-same-id" }
      if status == 429 && input["remainingDeadlineSeconds"] as? Int == 0 { return "do-not-attempt" }
      if status == 429 {
        guard let raw = text(input, "retryAfter"), let delay = Int(raw),
              String(delay) == raw, (1...60).contains(delay) else {
          return "indeterminate-local-backoff"
        }
        let remaining = input["remainingDeadlineSeconds"] as? Int ?? delay
        return "retry-after-\(min(delay, remaining))"
      }
      return "indeterminate-retry-same-id"
    }
    if group == "resourceControls" {
      return input["saturated"] as? Bool == true ? "generic-throttle" : "allow"
    }
    if group == "audit" {
      if text(input, "wal") == "full" { return "non-droppable-aggregate-loss-signal" }
      if text(input, "wal") == "available" { return "durable-refusal-event" }
      if text(input, "publication") == "unavailable" { return "queue-and-retry" }
      if input["deliveryAttempts"] != nil { return "one-logical-event" }
      if input["stateCommit"] as? Bool == true && input["auditIntentCommit"] as? Bool == true {
        return "acknowledge"
      }
      return "fail-without-success"
    }
    if group == "lifecycleRaces" {
      guard let mutation = text(input, "mutation"), mutations.contains(mutation),
            let transition = text(input, "transition"), transitions.contains(transition),
            ["mutation", "transition"].contains(text(input, "winner") ?? "") else {
        return "invalid-vector"
      }
      return text(input, "winner") == "mutation"
        ? "commit-then-invalidate" : "no-new-authority-or-success-state"
    }
    if group == "crashRecovery" {
      if text(input, "crashAt") == "before-state-and-audit-commit" {
        return "no-root-no-success-event"
      }
      if text(input, "crashAt") == "after-state-and-audit-commit",
         input["sameMintIdRetry"] as? Bool == true { return "replay-exact-root" }
      if text(input, "crashAt") == "before-predecessor-consume" {
        return "predecessor-remains-live"
      }
      if text(input, "crashAt") == "after-successor-and-audit-commit",
         input["sameExchangeIdRetry"] as? Bool == true { return "replay-exact-successor" }
      if text(input, "crashAt") == "after-inbox-ledger-audit-commit" {
        return "replay-recorded-ack"
      }
      if text(input, "crashAt") == "after-audit-intent-commit" {
        return "publish-idempotently-after-restart"
      }
      return "invalid-vector"
    }
    return nil
  }

  static func resolve(_ input: [String: Any]) -> String {
    if text(input, "credentialOrScope") == "invalid" { return "refuse" }
    if text(input, "ledger") == "same-id-same-hash" { return "replay-recorded-outcome" }
    if text(input, "ledger") == "same-id-different-hash" { return "refuse" }
    if text(input, "binding") != "live" { return "refuse" }
    if text(input, "manifest") != "exact-match" { return "refuse" }
    return "commit-acceptance"
  }
}
