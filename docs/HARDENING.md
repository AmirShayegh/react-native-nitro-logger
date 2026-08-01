# Hardening probes

The test suites verify contracts. The probes in this document verify
reality: real operations through the real production path — the published
npm artifact, a real simulator or emulator, real files — with the output
inspected independently rather than trusted from a status field. They exist
because the bug class that survives a green suite lives in the gaps the
suites cannot cross by design: the JVM tests stop at the Nitro adapter, the
Swift package cannot link Nitro at all, and the JS tests run against a
scripted sink.

These are **manual probes**, not CI gates. Each needs a booted
simulator/emulator, npm access and tens of minutes; none of that belongs on
a shared runner. What keeps them honest instead: each script refuses to
report success when its own preconditions would make the run vacuous, and
this document records when each probe last ran and what it found.

## When to run which probe

| Probe | Run it when |
| --- | --- |
| Collect probe (`scripts/probe-collect-ios.sh`, `scripts/probe-collect-android.sh`) | Any release candidate; any change to rotation, compression, collect, or the writer's file layout |
| OTA pairing probe (recipe below) | Any change to a `.nitro.ts` spec signature — the wire itself |

## The collect probe

`collectForSupport()` is the deepest boundary crossing the package has:
JS batcher → ArrayBuffer bridge → native writer → rotation → gzip archives
→ multi-member bundle → back out as a file a human ships to support. The
probe runs all of it against the version npm serves:

```sh
# emulator/simulator booted first
NITRO_LOGGER_VERSION=0.4.0 ./scripts/probe-collect-android.sh
NITRO_LOGGER_VERSION=0.4.0 ./scripts/probe-collect-ios.sh
```

Each script scaffolds a consumer app against the registry artifact, writes
60 sequenced records under a rotation policy small enough to force several
compressed archives, collects a bundle, and then verifies **off-device and
independently**:

- the reported `byteCount` equals the size of the file actually on disk;
- the gzip **members are counted out of the bytes** — headers parsed, each
  member's deflate stream inflated on its own — and the count must be at
  least 2 and must equal the `sourceFileCount` native reported. Decoding
  the file proves nothing about framing on its own: both system gzip and
  node's zlib decode concatenated members transparently, so a build that
  recompressed every source into one member would decompress perfectly and
  still have lost the property. This is the one check that ties a number
  native reported to the bytes on disk;
- **system** `gzip -dc` — a decoder written by neither this repo nor node —
  must produce byte-for-byte what the member walk produced;
- every line is valid JSON, every sequence number appears exactly once, and
  they appear in strictly increasing order (the bundle is chronological
  across member boundaries, not merely within one);
- `sourceFileCount >= 2`, or the script fails itself as vacuous — a run
  where rotation never produced an archive tested nothing multi-member;
- after `deleteSupportBundle()` returns `true`, the file is verifiably gone
  from the device. Returning `true` is not verification.

## The OTA pairing probe

Ships with every wire change, in both directions, and the results go in the
changelog. The 0.3.x → 0.4.0 run is the worked example: see the 0.4.0 entry
in the changelog for the measured failure shape (construction succeeds, the
bridge rejects every batch, nothing throws at any logging call site,
`flush()` returns `durable: false` with unreported-loss counters climbing —
silent total loss) and the measured positive control (bytes land intact,
`queuedBytes` equal to the true UTF-8 length of a payload holding 2-, 3-
and 4-byte sequences).

The recipe, per direction:

- **Mismatch** (new JS over old binary): scaffold a consumer app against
  the OLD published tarball, build it (Release on iOS so the JS embeds;
  debug + Metro on Android), then replace only the JavaScript with the new
  tree's build and re-bundle. The native binary is never recompiled — that
  is the OTA scenario exactly. Probe construction, the raw sink call (for
  the exact bridge error text), the consumer-visible path through
  `FileDestination` over two flushes, and a signature-unchanged control
  method.
- **Positive control** (new over new): same app, both halves from the same
  packed tarball. Assert acceptance, durability, and read the written bytes
  back off the device — content compared, not just size.

## Traps this discipline has already caught

Recorded so the next probe author does not rediscover them:

- **Grep the generated `.hpp`, never the `.cpp`, to prove a wire type.**
  The `.cpp` registers methods by name only; a parameter-type grep there is
  vacuously satisfied in every version. The 0.4.0 positive control failed
  its own sanity check this way before measuring anything.
- **Pull binary files with `adb exec-out`, never `adb shell`.** The shell
  channel rewrites `\n` as `\r\n` and corrupts a gzip stream.
- **An independent decoder is not a member count.** The first version of
  this checklist claimed system gzip was needed because node's
  `zlib.gunzipSync` reads only the first member of a concatenated stream.
  That is false — measured on node 22, `gunzipSync` returns every member's
  payload — and the claim was load-bearing for a check that therefore
  proved nothing about framing. Review caught the claim; measurement
  settled it; the member walk replaced it. Decoding proves the bytes are
  readable, not that they are structured the way the design says.
- **Keep probe workdirs and evidence out of `/tmp`.** The macOS tmp reaper
  deleted a live harness mid-run during the 0.4.0 release; everything under
  `~/.cache` survived.
- **A probe must be able to fail itself as vacuous.** The collect scripts
  refuse success when rotation produced no archive; the pairing scripts
  refuse to run when the installed artifact is not the version the run
  claims to measure.

## Probe log

| Date | Probe | Artifact | Result |
| --- | --- | --- | --- |
| 2026-08-01 | OTA mismatch, iOS + Android | 0.4.0 JS over published 0.3.0 binary | Measured silent total loss; recorded in the 0.4.0 changelog |
| 2026-08-01 | OTA positive control, iOS + Android | packed 0.4.0 over itself | Bytes intact on device, `queuedBytes` exact |
| 2026-08-01 | Collect probe, iOS + Android | published `react-native-nitro-logger@0.4.0` | PASS both platforms: 60/60 records, chronological, byteCount exact (710 iOS / 771 Android), delete verified gone. One anomaly traced: `getLogFilePaths` reported 4 while `sourceFileCount` was 3 — the final flush's rotation leaves a fresh empty active file, which collect deliberately skips (`bytes == 0` sources are not packed as empty members; documented in the writer). Not a defect. |
| 2026-08-01 | Collect bundles re-verified under the member walk | the same two captured bundles | Both hold exactly 3 gzip members, equal to the reported `sourceFileCount`, and the member walk agrees byte for byte with system gzip. The original run asserted multi-member framing without counting members; the property held, but the check had not earned it. |
