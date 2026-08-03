# Wire contract v1

This is the public byte contract between `react-native-nitro-logger` clients
and an independently implemented ingest gateway. The machine-readable source
of truth is [`spec/wire/v1/contract.json`](../spec/wire/v1/contract.json); the
tables marked as generated below are rendered from it and checked in CI.
[`golden-vectors.json`](../spec/wire/v1/golden-vectors.json) pins complete
bytes and failure classifications.

This document defines syntax and immutable identity. It does not implement a
segment writer, HTTP endpoint, resource budget, tenant grammar lifecycle,
acknowledgement envelope, or authorization capability. Those consumers must
adopt these bytes without reinterpreting them.

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

## Golden vectors and adoption

The shared vectors contain source values, exact payload bytes, zero-slot header
bytes, final header bytes, digest, corruption cases, numeric boundaries,
identifier failures, and base-versus-strict unknown-field cases. Node, Swift,
and Kotlin consumers independently reproduce them; a platform may not import
another platform's codec.

The npm package generates `spec/wire/manifest.json` after the source commit
exists. It records that commit and SHA-256 for this document, the descriptor,
and the vectors. The generated manifest is not tracked and does not hash
itself, avoiding a circular commit or content reference. Gateway support must
deploy before a client release emits a new header/contract version.

Downstream ownership remains explicit:

- T-030 implements native sealing against these vectors;
- T-022 implements gateway parsing and resource budgets;
- T-023 implements tenant grammar lifecycle and emergency revocation;
- T-024 defines acknowledgement envelopes and terminal response behavior;
- T-062 extends the shared contract for A12/A13 capability and manifest rules.
