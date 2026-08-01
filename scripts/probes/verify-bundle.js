// Independent verification of a pulled support bundle.
//
//   node verify-bundle.js <bundle.gz> <runId> <expectedRecords> [expectedMembers]
//
// A support bundle is a CONCATENATION of gzip members: each rotated archive
// is byte-copied in as the member it already was, and the active file is
// compressed in beside them. That framing is the property this file exists
// to prove, and proving it takes three independent things:
//
//   1. A member walk. The gzip headers are parsed here and each member's
//      deflate stream is inflated on its own, so the member COUNT is read
//      out of the bytes rather than assumed. Decompressing the whole file
//      with any decoder does NOT establish it: node's zlib and system gzip
//      both decode concatenated members transparently (measured, not
//      assumed), so an implementation that recompressed every source into
//      ONE member would decode fine and still be wrong. The count is
//      asserted >= 2, and against the native side's reported
//      `sourceFileCount` when the caller passes it — the one check that ties
//      a number native reported to the bytes actually on disk.
//   2. SYSTEM gzip (`gzip -dc`) — a decoder written by neither this repo nor
//      node — must produce exactly what the member walk produced. Two
//      independent decoders agreeing is what makes the bytes trustworthy.
//   3. A line scan over that output: every line valid JSON (framing survived
//      end to end), every sequence number 0..N-1 present exactly once, in
//      strictly increasing order (the bundle is chronological ACROSS member
//      boundaries, not merely within one).
const { spawnSync } = require('child_process');
const { Buffer } = require('buffer');
const zlib = require('zlib');
const fs = require('fs');

const [bundle, runId, expectedRaw, membersRaw] = process.argv.slice(2);
const expected = Number(expectedRaw);
if (!bundle || !runId || !Number.isInteger(expected)) {
  console.error(
    'usage: node verify-bundle.js <bundle.gz> <runId> <count> [members]'
  );
  process.exit(2);
}
const expectedMembers = membersRaw === undefined ? null : Number(membersRaw);
if (expectedMembers !== null && !Number.isInteger(expectedMembers)) {
  console.error(`FAIL: member count "${membersRaw}" is not an integer`);
  process.exit(2);
}

// Walks the concatenated members, returning each one's decompressed bytes.
// Header layout is RFC 1952; the optional fields have to be stepped over by
// hand or the deflate stream starts at the wrong offset. `bytesWritten` on
// a raw inflate is the number of INPUT bytes it consumed, which is what
// locates the 8-byte CRC32+ISIZE trailer and the next member after it.

// Steps over one NUL-terminated header field. Bounded on purpose: a
// truncated FNAME has no terminator, and scanning for one that is not there
// is how a verifier hangs instead of failing — the worst outcome available
// to a probe, since a wedged run reports nothing at all.
function afterCString(buf, p, field, memberOffset) {
  const end = buf.indexOf(0, p);
  if (end < 0) {
    throw new Error(
      `unterminated ${field} in the member at offset ${memberOffset}`
    );
  }
  return end + 1;
}

function gzipMembers(buf) {
  /* eslint-disable no-bitwise -- see above: this is the gzip header format */
  const members = [];
  let off = 0;
  while (off < buf.length) {
    if (buf.length - off < 18) {
      throw new Error(
        `${buf.length - off} trailing byte(s) at offset ${off} are not a member`
      );
    }
    if (buf[off] !== 0x1f || buf[off + 1] !== 0x8b) {
      throw new Error(`no gzip magic at offset ${off}`);
    }
    if (buf[off + 2] !== 0x08) {
      throw new Error(`unsupported compression method at offset ${off}`);
    }
    const flg = buf[off + 3];
    let p = off + 10;
    if (flg & 0x04) {
      if (p + 2 > buf.length) {
        throw new Error(`truncated FEXTRA length in the member at ${off}`);
      }
      p += 2 + buf.readUInt16LE(p);
      if (p > buf.length) {
        throw new Error(`FEXTRA runs past the end of the member at ${off}`);
      }
    }
    if (flg & 0x08) p = afterCString(buf, p, 'FNAME', off);
    if (flg & 0x10) p = afterCString(buf, p, 'FCOMMENT', off);
    if (flg & 0x02) {
      p += 2;
      if (p > buf.length) {
        throw new Error(`truncated FHCRC in the member at ${off}`);
      }
    }
    const inflated = zlib.inflateRawSync(buf.subarray(p), { info: true });
    members.push(inflated.buffer);
    off = p + inflated.engine.bytesWritten + 8;
  }
  /* eslint-enable no-bitwise */
  return members;
}

const raw = fs.readFileSync(bundle);

let members;
try {
  members = gzipMembers(raw);
} catch (e) {
  console.error(
    `FAIL: the bundle is not a well-formed gzip stream: ${e.message}`
  );
  process.exit(1);
}

if (members.length < 2) {
  console.error(
    `FAIL: the bundle holds ${members.length} gzip member(s) — nothing about ` +
      `multi-member framing was tested, so this run proves nothing`
  );
  process.exit(1);
}
if (expectedMembers !== null && members.length !== expectedMembers) {
  console.error(
    `FAIL: native reported sourceFileCount=${expectedMembers} but the bytes ` +
      `hold ${members.length} gzip member(s)`
  );
  process.exit(1);
}

const gunzip = spawnSync('gzip', ['-dc', bundle], {
  maxBuffer: 64 * 1024 * 1024,
});
if (gunzip.status !== 0) {
  console.error(`FAIL: system gzip rejected the bundle: ${gunzip.stderr}`);
  process.exit(1);
}

if (!Buffer.concat(members).equals(gunzip.stdout)) {
  console.error(
    'FAIL: the member walk and system gzip disagree about the contents'
  );
  process.exit(1);
}

const text = gunzip.stdout.toString('utf8');
const lines = text.split('\n').filter((l) => l.length > 0);

let badJson = 0;
for (const line of lines) {
  try {
    JSON.parse(line);
  } catch {
    badJson += 1;
    console.error(`FAIL: not JSON: ${line.slice(0, 120)}`);
  }
}
if (badJson > 0) {
  console.error(`FAIL: ${badJson} unparseable line(s) of ${lines.length}`);
  process.exit(1);
}

const seqs = [];
for (const line of lines) {
  if (!line.includes(runId)) continue;
  const m = line.match(/seq-(\d{4})/);
  if (m) seqs.push(Number(m[1]));
}

if (seqs.length !== expected) {
  console.error(`FAIL: expected ${expected} records, found ${seqs.length}`);
  process.exit(1);
}
for (let i = 0; i < seqs.length; i += 1) {
  if (seqs[i] !== i) {
    console.error(
      `FAIL: position ${i} holds seq ${seqs[i]} — order broken or duplicate`
    );
    process.exit(1);
  }
}

const tie =
  expectedMembers === null
    ? ''
    : `, matching sourceFileCount=${expectedMembers}`;
console.log(
  `ok: ${members.length} gzip members counted from the bytes${tie}; ` +
    `system gzip agrees byte for byte; ${lines.length} JSON lines, ` +
    `${seqs.length}/${expected} records, strictly chronological across members`
);
