import Foundation
import CryptoKit
import XCTest

@testable import NitroLoggerFileWriter

final class AuthContractTests: XCTestCase {
  private func object(_ name: String) throws -> [String: Any] {
    try WireContractSupport.object("spec/wire/v1/\(name)")
  }

  func testDeliveryCapabilityScopeAndAuthorityAreExact() throws {
    let descriptorData = try Data(
      contentsOf: WireContractSupport.root.appendingPathComponent("spec/wire/v1/auth-contract.json")
    )
    XCTAssertEqual(
      SHA256.hash(data: descriptorData).map { String(format: "%02x", $0) }.joined(),
      "50209450c1c742ca218b5b4e2fe1232888dc4764f1e3cab5e6c1a1198f75a38b"
    )
    let contract = try object("auth-contract.json")
    XCTAssertEqual(contract["contractVersion"] as? Int, 1)
    let scope = try XCTUnwrap(contract["scope"] as? [String: Any])
    XCTAssertEqual(scope["comparison"] as? String, "exact")
    XCTAssertEqual(scope["fields"] as? [String], [
      "tenantId", "analyticsStream", "installId", "subjectScope",
      "identityGeneration", "consentGeneration",
    ])
    let capability = try XCTUnwrap(contract["deliveryCapability"] as? [String: Any])
    XCTAssertEqual(capability["authority"] as? [String], [
      "exchange-self", "deliver-manifested-segment",
    ])
    XCTAssertEqual(capability["forbiddenAuthority"] as? [String], [
      "collect", "identify-or-bind", "manifest-register", "scope-change",
      "deadline-extension", "root-rotation",
    ])
    XCTAssertEqual(capability["rawCredentialLogging"] as? Bool, false)
    XCTAssertEqual(capability["deviceStorage"] as? String, "secure-platform-storage")
    let serverStorage = try XCTUnwrap(capability["serverStorage"] as? [String: String])
    XCTAssertEqual(serverStorage["secret"], "verifier-only")
    XCTAssertEqual(serverStorage["comparison"], "constant-time")
    XCTAssertEqual(serverStorage["recoverableResponses"], "encrypted-at-rest")
    let resourceControls = try XCTUnwrap(contract["resourceControls"] as? [String: Any])
    XCTAssertEqual(resourceControls["boundedConcurrency"] as? Bool, true)
    XCTAssertEqual(resourceControls["publicThrottleIndistinguishable"] as? Bool, true)
    let audit = try XCTUnwrap(contract["audit"] as? [String: Any])
    XCTAssertEqual(audit["forbiddenFields"] as? [String], ["bearerSecret", "payload", "rawSubjectId", "rawCredentialId"])
    XCTAssertEqual(audit["identifierHash"] as? String, "keyed")
    XCTAssertEqual(audit["authorizationOnAuditFailure"] as? String, "fail-closed")
    let operations = try XCTUnwrap(contract["operations"] as? [String: [String: Any]])
    XCTAssertEqual(Set(operations.keys), Set(["capabilityMint", "capabilityExchange", "manifestRegister"]))
    let expected: [String: (String, [String], [String], Int, [String])] = [
      "capabilityMint": (
        "/v1/delivery-capabilities:mint",
        ["contractVersion", "operation", "mintId", "scope"],
        ["credentialId", "bearerSecret", "issuedAt", "expiresAt", "deliveryDeadline"],
        201,
        ["contractVersion", "operation", "credentialId", "bearerSecret", "issuedAt", "expiresAt", "deliveryDeadline"]
      ),
      "capabilityExchange": (
        "/v1/delivery-capabilities:exchange",
        ["contractVersion", "operation", "exchangeId"],
        ["scope", "expiresAt", "deliveryDeadline"],
        200,
        ["contractVersion", "operation", "credentialId", "bearerSecret", "issuedAt", "expiresAt", "deliveryDeadline"]
      ),
      "manifestRegister": (
        "/v1/segment-manifests",
        ["contractVersion", "operation", "segmentId", "contentHash", "scope"],
        ["payload", "acceptanceEpoch"],
        201,
        ["contractVersion", "operation", "segmentId", "contentHash"]
      ),
    ]
    for (name, pin) in expected {
      let operation = try XCTUnwrap(operations[name])
      let request = try XCTUnwrap(operation["request"] as? [String: Any])
      let response = try XCTUnwrap(operation["response"] as? [String: Any])
      XCTAssertEqual(request["method"] as? String, "POST")
      XCTAssertEqual(request["contentType"] as? String, "application/json")
      XCTAssertEqual(request["path"] as? String, pin.0)
      XCTAssertEqual(request["requiredFields"] as? [String], pin.1)
      XCTAssertEqual(request["forbiddenFields"] as? [String], pin.2)
      XCTAssertEqual(response["status"] as? Int, pin.3)
      XCTAssertEqual(response["requiredFields"] as? [String], pin.4)
    }
    XCTAssertEqual(operations["capabilityMint"]?["operation"] as? String, "capability-mint")
    XCTAssertEqual((operations["capabilityMint"]?["request"] as? [String: Any])?["authorization"] as? String, "live-session-or-tenant-backend")
    XCTAssertEqual((operations["capabilityMint"]?["request"] as? [String: Any])?["idempotencyField"] as? String, "mintId")
    XCTAssertEqual(operations["capabilityExchange"]?["operation"] as? String, "capability-exchange")
    XCTAssertEqual((operations["capabilityExchange"]?["request"] as? [String: Any])?["authorization"] as? String, "delivery-capability")
    XCTAssertEqual((operations["capabilityExchange"]?["request"] as? [String: Any])?["idempotencyField"] as? String, "exchangeId")
    XCTAssertEqual(operations["manifestRegister"]?["operation"] as? String, "manifest-register")
    XCTAssertEqual((operations["manifestRegister"]?["request"] as? [String: Any])?["authorization"] as? String, "live-session")
    XCTAssertEqual((operations["manifestRegister"]?["response"] as? [String: Any])?["idempotentStatus"] as? Int, 200)
    let compatibility = try XCTUnwrap(contract["compatibility"] as? [String: String])
    XCTAssertEqual(compatibility, [
      "unknownContractVersion": "refused",
      "unknownOperation": "refused",
      "unknownRequestField": "refused",
      "additionalResponseField": "malformed-contract-response",
    ])
    let responses = try XCTUnwrap(contract["publicResponses"] as? [String: Any])
    let refused = try XCTUnwrap(responses["refused"] as? [String: Any])
    XCTAssertEqual(refused["contentType"] as? String, "application/json")
    XCTAssertEqual(refused["terminalOnlyWhenSchemaMatches"] as? Bool, true)
    XCTAssertEqual(refused["malformedClassification"] as? String, "indeterminate")
    let refusalBody = try XCTUnwrap(refused["body"] as? [String: Any])
    XCTAssertEqual(refusalBody["requiredFields"] as? [String], ["contractVersion", "operation", "code"])
    XCTAssertEqual(refusalBody["additionalFields"] as? Bool, false)
    XCTAssertEqual(refusalBody["contractVersion"] as? Int, 1)
    XCTAssertEqual(refusalBody["operation"] as? String, "echo-request-operation")
    XCTAssertEqual(refusalBody["code"] as? String, "refused")
  }

  func testAuthVectorGroupsAreNonVacuousAndUnique() throws {
    let vectors = try object("auth-vectors.json")
    let sets = try XCTUnwrap(vectors["vectorSets"] as? [String: [[String: Any]]])
    XCTAssertEqual(Set(sets.keys), Set([
      "scope", "mint", "exchange", "registration", "responses",
      "resourceControls", "audit", "lifecycleRaces", "crashRecovery",
    ]))
    for (name, rows) in sets {
      XCTAssertFalse(rows.isEmpty, "\(name) must not be vacuous")
      let ids = try rows.map { try XCTUnwrap($0["id"] as? String) }
      XCTAssertEqual(Set(ids).count, ids.count, "duplicate vector id in \(name)")
      for row in rows {
        XCTAssertEqual(
          AuthContractSupport.evaluate(contract: try object("auth-contract.json"), group: name, row: row),
          row["expected"] as? String,
          row["id"] as? String ?? name
        )
      }
    }
    let table = try object("resolution-table.json")
    let mutations = try XCTUnwrap(table["linearizedMutations"] as? [String])
    let transitions = try XCTUnwrap(table["lifecycleTransitions"] as? [String])
    let expectedRaces = mutations.flatMap { mutation in
      transitions.flatMap { transition in
        ["mutation", "transition"].map { "\(mutation)|\(transition)|\($0)" }
      }
    }
    let raceRows = try XCTUnwrap(sets["lifecycleRaces"])
    XCTAssertEqual(try raceRows.map { row in
      let input = try XCTUnwrap(row["input"] as? [String: Any])
      return "\(try XCTUnwrap(input["mutation"] as? String))|\(try XCTUnwrap(input["transition"] as? String))|\(try XCTUnwrap(input["winner"] as? String))"
    }, expectedRaces)
  }

  func testResolutionAndTransactionOrderArePinned() throws {
    let table = try object("resolution-table.json")
    XCTAssertEqual(table["evaluationOrder"] as? [String], [
      "validate-credential-and-scope", "consult-current-epoch-ledger",
      "resolve-immutable-ledger-outcome", "require-live-binding-and-manifest",
      "commit-inbox-ledger-audit",
    ])
    let rows = try XCTUnwrap(table["resolutionRows"] as? [[String: Any]])
    XCTAssertEqual(rows.compactMap { $0["id"] as? String }, [
      "credential-or-scope-invalid", "ledger-same-id-same-hash",
      "ledger-same-id-different-hash", "no-ledger-binding-inactive",
      "no-ledger-manifest-missing", "no-ledger-live-manifest-match",
      "post-rebuild-deleted-binding",
    ])
    for row in rows {
      XCTAssertEqual(
        AuthContractSupport.resolve(try XCTUnwrap(row["when"] as? [String: Any])),
        try XCTUnwrap((row["expected"] as? [String: Any])?["action"] as? String)
      )
    }
    let transactions = try XCTUnwrap(table["transactionRows"] as? [[String: Any]])
    XCTAssertEqual(transactions.compactMap { $0["id"] as? String }, [
      "manifest-registration", "acceptance-inbox-ledger-audit",
      "acknowledgement-emission", "audit-publication",
    ])
    XCTAssertEqual(transactions[0]["state"] as? [String], ["exact-manifest-record", "success-audit-intent"])
    XCTAssertEqual(transactions[0]["commit"] as? String, "atomic-before-or-with-acceptance")
    XCTAssertEqual(transactions[1]["state"] as? [String], ["inbox-bytes", "same-epoch-ledger-outcome", "success-audit-intent"])
    XCTAssertEqual(transactions[1]["commit"] as? String, "single-acceptance-boundary")
    XCTAssertEqual(transactions[2]["requires"] as? [String], ["durable-inbox", "durable-ledger-outcome", "durable-audit-intent"])
    XCTAssertEqual(transactions[2]["lostResponse"] as? String, "replay-ledger-outcome")
    XCTAssertEqual(transactions[3]["requires"] as? [String], ["durable-audit-intent"])
    XCTAssertEqual(transactions[3]["outage"] as? String, "queue-and-retry")
  }
}
