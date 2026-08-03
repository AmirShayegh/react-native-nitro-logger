# Wire contract v1

This is the public byte contract between `react-native-nitro-logger` clients
and an independently implemented ingest gateway. The machine-readable source
of truth is the versioned descriptor set under [`spec/wire/v1/`](../spec/wire/v1/);
the tables marked as generated below are rendered from it and checked in CI.
[`golden-vectors.json`](../spec/wire/v1/golden-vectors.json) pins complete
bytes and failure classifications. [`auth-contract.json`](../spec/wire/v1/auth-contract.json)
and [`auth-vectors.json`](../spec/wire/v1/auth-vectors.json) pin A12/A13
authorization behavior; [`resolution-table.json`](../spec/wire/v1/resolution-table.json)
pins gateway decision and transaction order.

This document defines syntax and immutable identity. It does not implement a
segment writer, HTTP endpoint implementation, resource-budget mechanism,
tenant grammar lifecycle, or acknowledgement envelope. It does define the
authorization capability and manifest behavior those consumers must adopt
without reinterpretation.

## Version pins

The payload subset follows the stable OpenTelemetry logs protobuf model at
[`opentelemetry-proto` v1.10.0](https://github.com/open-telemetry/opentelemetry-proto/releases/tag/v1.10.0)
and the [OTLP 1.11.0 JSON protobuf mapping](https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding).
Changing either pin is a wire-contract revision, even if a newer upstream
release describes the change as additive.

<!-- BEGIN GENERATED:contract-pin -->
| Item | Pinned value |
| --- | --- |
| Contract version | 1 |
| Header version | 1 |
| OpenTelemetry Protocol specification | 1.11.0 |
| OpenTelemetry protobuf definitions | v1.10.0 |
| Byte order | big-endian |
| Digest | SHA256 |
<!-- END GENERATED:contract-pin -->

## OTLP/HTTP JSON payload subset

One payload is one UTF-8 JSON representation of an
`ExportLogsServiceRequest`. Producers use lowerCamelCase protobuf field names
and the following v1 inventory.

<!-- BEGIN GENERATED:otlp-inventory -->
| Message | Allowed v1 fields |
| --- | --- |
| `ExportLogsServiceRequest` | `resourceLogs` |
| `ResourceLogs` | `resource`, `scopeLogs`, `schemaUrl` |
| `Resource` | `attributes`, `droppedAttributesCount` |
| `ScopeLogs` | `scope`, `logRecords`, `schemaUrl` |
| `InstrumentationScope` | `name`, `version`, `attributes`, `droppedAttributesCount` |
| `LogRecord` | `timeUnixNano`, `observedTimeUnixNano`, `severityNumber`, `severityText`, `body`, `attributes`, `droppedAttributesCount`, `flags`, `traceId`, `spanId` |
| `KeyValue` | `key`, `value` |
| `AnyValue` | `stringValue`, `boolValue`, `intValue`, `doubleValue`, `bytesValue`, `arrayValue`, `kvlistValue` |
| `ArrayValue` | `values` |
| `KeyValueList` | `values` |
<!-- END GENERATED:otlp-inventory -->

### Integers, enums, and time

`timeUnixNano` and `observedTimeUnixNano` are unsigned 64-bit decimal strings.
They are built with integer arithmetic:

```text
wholeSeconds * 1_000_000_000 + nanosWithinSecond
```

`nanosWithinSecond` is in `0...999_999_999`; the result is in
`0...18_446_744_073_709_551_615`. A JSON number is invalid even when it would
happen to be exactly representable. Leading zeroes, a plus sign, whitespace,
exponents, decimals, `-0`, and values outside the range are invalid.

Every protobuf enum is a JSON integer. `severityNumber` is `0...24`; symbolic
spellings such as `SEVERITY_NUMBER_INFO` and fractional numbers are invalid.
Thirty-two-bit count/flag fields are JSON integers within their protobuf
ranges. `AnyValue.intValue` is a signed 64-bit canonical decimal string in
`-9_223_372_036_854_775_808...9_223_372_036_854_775_807`.

### `AnyValue`

Exactly one recognized arm is present:

- `stringValue`: JSON string;
- `boolValue`: JSON boolean;
- `intValue`: signed 64-bit canonical decimal string;
- `doubleValue`: finite JSON number (v1 excludes `NaN` and infinities);
- `bytesValue`: canonical standard-base64 JSON string;
- `arrayValue`: `{ "values": AnyValue[] }`;
- `kvlistValue`: `{ "values": KeyValue[] }`, whose keys are unique.

An empty value or multiple recognized arms is invalid. Arrays and kvlists may
nest, subject to the gateway's separately defined parsing budgets.

### Duplicate and unknown fields

Duplicate JSON object keys are rejected before semantic decoding. A parser
that silently keeps the first or last value is not a v1 validator.

OTLP's base compatibility rule ignores unknown protobuf message fields. Strict
tenant validation is deliberately stronger: before insertion it walks the
original duplicate-aware JSON tree and rejects every field outside the table
above. It must not validate a normalized decoder result, because normalization
would already have discarded the unknown bytes. This preserves generic OTLP
forward compatibility without allowing a strict tenant to hide an unapproved
free-form value in an ignored field. Library producers emit only the listed
fields in either profile. Tenant-approved attribute names and value bounds are
a separate grammar layered on top.

The exact payload bytes are identity-bearing. Parsing is for validation only;
neither client nor gateway reserializes before verifying the content hash.

## Segment header v1

The header is binary. Unsigned integers are big-endian. Strings are an unsigned
16-bit byte length followed by bytes matching the identifier pattern in the
machine descriptor, with a maximum of 128 bytes. V1 rejects non-ASCII rather
than normalizing Unicode.

<!-- BEGIN GENERATED:header-layout -->
| Order | Field | Encoding | Size / bound | Hash rule |
| --- | --- | --- | --- | --- |
| 0 | `magic` | `fixed-bytes` | 8 bytes | exact persisted bytes |
| 1 | `headerVersion` | `u16` | 2 bytes | exact persisted bytes |
| 2 | `headerLength` | `u32` | 4 bytes | exact persisted bytes |
| 3 | `segmentId` | `fixed-bytes` | 16 bytes | exact persisted bytes |
| 4 | `contentHash` | `fixed-bytes` | 32 bytes | 32 zero bytes while hashing |
| 5 | `tenantId` | `ascii` + `u16` length | 1–128 bytes | exact persisted bytes |
| 6 | `streamId` | `ascii` + `u16` length | 1–128 bytes | exact persisted bytes |
| 7 | `sourceEpoch` | `ascii` + `u16` length | 1–128 bytes | exact persisted bytes |
| 8 | `schemaVersion` | `u32` | 4 bytes | exact persisted bytes |
| 9 | `consentGeneration` | `u64` | 8 bytes | exact persisted bytes |
| 10 | `recordCount` | `u32` | 4 bytes | exact persisted bytes |
| 11 | `payloadLength` | `u64` | 8 bytes | exact persisted bytes |
<!-- END GENERATED:header-layout -->

The magic bytes are `4e4c4f4753454700` (`NLOGSEG` followed by NUL). A parser
reads only magic and `headerVersion` before selecting a version. An unknown
version is `unsupportedHeaderVersion`; it is never interpreted using v1
offsets. `headerLength` includes the complete header and excludes payload.
`segmentId` is 16 raw bytes from an OS CSPRNG.

`schemaVersion`, `consentGeneration`, and `recordCount` are unsigned 32-, 64-,
and 32-bit values respectively. `payloadLength` is the exact byte length of the
following payload. Field-specific semantic rules may exclude a representable
zero, but an encoder never truncates or wraps an out-of-range input.

Lifecycle state is not a header field. Sealing, in-flight state, retries,
acknowledgement state, gateway acceptance epoch, and mutable timestamps live in
external state. Changing any of them leaves the immutable segment bytes alone.

## Content identity and verification

The persisted `contentHash` is:

```text
SHA-256(header with the 32-byte contentHash slot replaced by zeroes
        || exact payload bytes)
```

Verification checks magic and version first, then header length, every bounded
field, payload length, and finally the digest over the original bytes. A header
or payload bit flip is `contentHashMismatch`; truncation or inconsistent length
is `malformed`. Unknown version is distinct. These classifications never
authorize repair or silent deletion.

Tenant and stream values are immutable client claims, not authority. A gateway
derives its authoritative tenant/stream namespace from validated credentials
and requires exact agreement before insertion. `sourceEpoch` is the recovery
epoch at seal and never changes after a gateway rebuild. The gateway's later
`acceptanceEpoch` belongs to its ledger and acknowledgement contracts, not this
header.

## A12 delivery capability

The delivery capability is a custody-transfer credential, not a collection or
identity credential. The gateway derives every scope value from a validated
live-session or explicitly authorized tenant-backend principal; request and
header values are claims that must agree exactly. Credential IDs are independent
128-bit CSPRNG values and bearer secrets are independent 256-bit CSPRNG values.
They travel only in the `Authorization` header over TLS, never in URLs. Clients
use platform secure storage. Servers keep a verifier rather than the raw secret,
compare in constant time, encrypt recoverable responses, and never log raw
credentials.

<!-- BEGIN GENERATED:auth-scope -->
| Order | Scope field | Comparison |
| --- | --- | --- |
| 0 | `tenantId` | exact |
| 1 | `analyticsStream` | exact |
| 2 | `installId` | exact |
| 3 | `subjectScope` | exact |
| 4 | `identityGeneration` | exact |
| 5 | `consentGeneration` | exact |
<!-- END GENERATED:auth-scope -->

The capability may exchange itself and deliver an already manifested segment.
It cannot collect, bind identity, register a manifest entry, alter scope, extend
the absolute delivery deadline, or rotate a root. V1 permits one root per
binding generation. An exact `mintId` retry replays the exact encrypted root
response; a different ID is refused. Root replacement requires a separately
authenticated new binding generation, which invalidates the old chain before a
new mint.

Exchange atomically consumes one predecessor, mints one successor, and records
the exact encrypted result under its `exchangeId`. An exact retry replays that
result. A different ID, a restored predecessor, or a concurrent loser is
refused. Expiry permits exchange only while still before the unchanged delivery
deadline; at the deadline, exchange and delivery both fail. Activity never
slides the deadline.

<!-- BEGIN GENERATED:auth-operations -->
| Operation | Method and path | Authority | Idempotency |
| --- | --- | --- | --- |
| `capability-mint` | `POST /v1/delivery-capabilities:mint` | `live-session-or-tenant-backend` | `mintId` |
| `capability-exchange` | `POST /v1/delivery-capabilities:exchange` | `delivery-capability` | `exchangeId` |
| `manifest-register` | `POST /v1/segment-manifests` | `live-session` | exact manifest key |
<!-- END GENERATED:auth-operations -->

All policy, credential, namespace, binding, manifest, deadline, and immutable
identity refusals use the same fixed `403` envelope with
`Content-Type: application/json` and exactly `contractVersion`, `operation`, and
`code` fields. The version is `1`, `operation` exactly echoes the request
operation, and `code` is `refused`; extra or missing fields are invalid. Any 403
that does not match this complete schema is indeterminate, including HTML or an
empty response, and mint/exchange retries preserve the same idempotency ID. A
`429 throttled` response carries an integer `Retry-After` delta of 1–60 seconds. Clients cap it
to the remaining deadline and never start at or after that deadline. A missing,
malformed, conflicting, or out-of-range header is indeterminate and uses bounded
local backoff. Transport errors, `5xx`, proxy HTML, and malformed contract
responses are also indeterminate; mint and exchange retries reuse the same
idempotency ID.

## A13 segment manifest

The manifest is an epoch-independent control-plane authorization record with no
payload. Registration requires a live-session collection credential. The
gateway derives the full namespace and validates exact agreement before any
write; a delivery capability cannot register. An exact key retry is idempotent,
the same segment ID with a different hash is refused, and delivery exercises the
entry without consuming it.

<!-- BEGIN GENERATED:manifest-contract -->
| Property | Pinned value |
| --- | --- |
| Key | `tenantId`, `analyticsStream`, `installId`, `subjectScope`, `identityGeneration`, `consentGeneration`, `segmentId`, `contentHash` |
| Payload stored | false |
| Acceptance-epoch independent | true |
| Registration authority | `live-session` |
| Upload semantics | `exercise-not-spend` |
| Same ID / same hash | `idempotent` |
| Same ID / different hash | `refused` |
<!-- END GENERATED:manifest-contract -->

The manifest survives acceptance-epoch loss with its binding. Subject deletion
cascades immediately. Normal garbage collection occurs at the fixed delivery
deadline plus the bounded response-replay window. Removing a manifest never
rewrites an already committed same-epoch acknowledgement outcome.

## Gateway resolution table

Resolution order is normative. After credential and exact-scope validation, the
gateway consults the current acceptance epoch's ledger before mutable binding or
manifest state. A same-ID/same-hash outcome replays even after deletion and never
re-projects. A same-ID/different-hash outcome refuses. Only a missing ledger row
falls through to live binding and exact manifest authorization. Therefore an
empty post-rebuild ledger fails closed when deletion removed the binding and
manifest.

<!-- BEGIN GENERATED:gateway-resolution -->
| Order | Row | When | Result |
| --- | --- | --- | --- |
| 0 | `credential-or-scope-invalid` | `credentialOrScope=invalid` | `refuse` |
| 1 | `ledger-same-id-same-hash` | `credentialOrScope=valid`, `ledger=same-id-same-hash` | `replay-recorded-outcome` |
| 2 | `ledger-same-id-different-hash` | `credentialOrScope=valid`, `ledger=same-id-different-hash` | `refuse` |
| 3 | `no-ledger-binding-inactive` | `credentialOrScope=valid`, `ledger=missing`, `binding=inactive` | `refuse` |
| 4 | `no-ledger-manifest-missing` | `credentialOrScope=valid`, `ledger=missing`, `binding=live`, `manifest=missing-or-mismatch` | `refuse` |
| 5 | `no-ledger-live-manifest-match` | `credentialOrScope=valid`, `ledger=missing`, `binding=live`, `manifest=exact-match` | `commit-acceptance` |
| 6 | `post-rebuild-deleted-binding` | `credentialOrScope=valid`, `acceptanceEpoch=rebuilt-empty`, `binding=deleted`, `manifest=deleted` | `refuse` |
<!-- END GENERATED:gateway-resolution -->

## Transaction and lifecycle boundaries

<!-- BEGIN GENERATED:transaction-boundaries -->
| Boundary | Atomic state | Commit rule | Response / outage rule |
| --- | --- | --- | --- |
| `manifest-registration` | `exact-manifest-record`, `success-audit-intent` | `atomic-before-or-with-acceptance` | response after `durable-commit` |
| `acceptance-inbox-ledger-audit` | `inbox-bytes`, `same-epoch-ledger-outcome`, `success-audit-intent` | `single-acceptance-boundary` | response after `durable-commit` |
| `acknowledgement-emission` | none | `none` | requires `durable-inbox`, `durable-ledger-outcome`, `durable-audit-intent`; lost response: `replay-ledger-outcome` |
| `audit-publication` | `published-audit-event` | `idempotent-outbox-delivery` | outage: `queue-and-retry` |
<!-- END GENERATED:transaction-boundaries -->

Successful mutations co-commit an idempotently keyed audit intent with their
state; responses require that intent to be durable, while publication may queue
and retry. Refusals remain fail closed and enter a bounded durable WAL. If that
WAL is full, a non-droppable aggregate loss signal records the gap without
changing the indistinguishable public response. Audit data contains keyed
identifier hashes, never secrets, payloads, or raw subject IDs.

<!-- BEGIN GENERATED:lifecycle-boundary -->
| Item | Pinned values |
| --- | --- |
| Linearized mutations | `capability-mint`, `capability-exchange`, `manifest-registration`, `upload-acceptance` |
| Lifecycle transitions | `subject-deletion`, `consent-revocation`, `tenant-or-binding-disable`, `generation-change`, `delivery-deadline` |
| Mutation wins | `commit-state-and-audit-intent-then-transition-invalidates-authority` |
| Transition wins | `commit-no-new-authority-or-success-state` |
| Ledger replay exception | `pre-existing-same-epoch-outcome-only` |
<!-- END GENERATED:lifecycle-boundary -->

Deletion, consent revocation, tenant/binding disable, generation change, and the
absolute deadline serialize with mint, exchange, registration, and acceptance.
If the lifecycle transition wins, no new authority, response material, manifest,
inbox bytes, ledger row, or success event commits. If the mutation wins, the
transition subsequently invalidates its authority and recoverable material. The
only replay exception is a pre-existing same-epoch ledger outcome, which creates
no new authority.

## Golden vectors and adoption

The shared vectors contain source values, exact payload bytes, zero-slot header
bytes, final header bytes, digest, corruption cases, numeric boundaries,
identifier failures, base-versus-strict unknown-field cases, authorization
outcomes, lifecycle races, and crash recovery. Node, Swift, and Kotlin consumers
independently reproduce them; a platform may not import another platform's
codec.

The npm package generates `spec/wire/manifest.json` after the source commit
exists. It records that commit and SHA-256 for this document, the descriptor,
the authorization descriptors, the resolution table, and both vector sets. The
generated manifest is not tracked and does not hash
itself, avoiding a circular commit or content reference. Gateway support must
deploy before a client release emits a new header/contract version.

Downstream ownership remains explicit:

- T-030 implements native sealing against these vectors;
- T-022 implements gateway parsing and resource budgets;
- T-023 implements tenant grammar lifecycle and emergency revocation;
- T-024 defines acknowledgement envelopes and terminal response behavior;
- T-062 owns the shared A12/A13 capability, manifest, resolution, and transaction contract;
- T-063 implements these server-side rules without weakening this public surface.
