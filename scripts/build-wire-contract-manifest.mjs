#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = new Map();
let verifySourceCommit = false;
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (flag === '--verify-source-commit') {
    if (verifySourceCommit) {
      console.error(`FAIL: duplicate flag: ${flag}`);
      process.exit(2);
    }
    verifySourceCommit = true;
    continue;
  }
  if (
    flag !== '--source-commit' &&
    flag !== '--output' &&
    flag !== '--pack-state-output' &&
    flag !== '--pack-lock' &&
    flag !== '--lock-owner-pid'
  ) {
    console.error(`FAIL: unknown argument: ${flag}`);
    process.exit(2);
  }
  if (
    options.has(flag) ||
    index + 1 >= args.length ||
    args[index + 1].startsWith('--')
  ) {
    console.error(`FAIL: ${flag} requires exactly one value`);
    process.exit(2);
  }
  options.set(flag, args[index + 1]);
  index += 1;
}
const sourceCommit = options.get('--source-commit');
const output = options.get('--output');
const packStateOutput = options.get('--pack-state-output');
const packLock = options.get('--pack-lock');
const lockOwnerPid = options.get('--lock-owner-pid');

if (!sourceCommit || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
  console.error(
    'usage: build-wire-contract-manifest.mjs --source-commit <40 lowercase hex> [--output <path>]'
  );
  process.exit(2);
}
if (
  Boolean(packStateOutput) !== Boolean(packLock) ||
  Boolean(packStateOutput) !== Boolean(lockOwnerPid) ||
  (packStateOutput && !output)
) {
  console.error(
    'FAIL: --pack-state-output, --pack-lock, --lock-owner-pid, and --output are required together'
  );
  process.exit(2);
}
if (lockOwnerPid && !/^[1-9][0-9]*$/.test(lockOwnerPid)) {
  console.error('FAIL: --lock-owner-pid must be a positive integer');
  process.exit(2);
}

function identity(absolutePath) {
  const stat = fs.statSync(absolutePath, { bigint: true });
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function stableSnapshot(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const before = identity(absolutePath);
  const bytes = fs.readFileSync(absolutePath);
  const after = identity(absolutePath);
  if (!sameIdentity(before, after)) {
    console.error(`FAIL: ${relativePath} changed while it was read`);
    process.exit(1);
  }
  return { bytes, identity: after };
}

function writeAtomic(absolutePath, bytes) {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporary = `${absolutePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, absolutePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function processAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireLock(absolutePath, ownerPid) {
  const ownerPath = path.join(absolutePath, 'owner.json');
  const reclaimPath = path.join(absolutePath, 'reclaim');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(absolutePath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      } catch {
        throw new Error(
          `packaging lock is present but unreadable: ${absolutePath}`
        );
      }
      if (processAlive(existing.pid)) {
        throw new Error(`another packaging process owns ${absolutePath}`);
      }
      const reclaimToken = crypto.randomBytes(32).toString('hex');
      try {
        fs.writeFileSync(reclaimPath, `${reclaimToken}\n`, { flag: 'wx' });
      } catch (reclaimError) {
        if (reclaimError.code === 'EEXIST') continue;
        throw reclaimError;
      }
      try {
        const current = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        if (
          current.token !== existing.token ||
          current.pid !== existing.pid ||
          processAlive(current.pid)
        ) {
          throw new Error(`another packaging process owns ${absolutePath}`);
        }
        fs.rmSync(absolutePath, { recursive: true, force: true });
      } finally {
        try {
          if (fs.readFileSync(reclaimPath, 'utf8').trim() === reclaimToken) {
            fs.rmSync(reclaimPath, { force: true });
          }
        } catch {
          // The winning reclaimer removed the whole directory.
        }
      }
      continue;
    }

    const owner = {
      token: crypto.randomBytes(32).toString('hex'),
      pid: Number(ownerPid),
    };
    try {
      fs.writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { flag: 'wx' });
      return owner;
    } catch (error) {
      fs.rmSync(absolutePath, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error(`could not acquire packaging lock: ${absolutePath}`);
}

const contractFiles = [
  'docs/WIRE.md',
  'spec/wire/v1/auth-contract.json',
  'spec/wire/v1/auth-vectors.json',
  'spec/wire/v1/contract.json',
  'spec/wire/v1/envelope-contract.json',
  'spec/wire/v1/envelope-vectors.json',
  'spec/wire/v1/golden-vectors.json',
  'spec/wire/v1/resolution-table.json',
];
const versionDirectory = path.join(root, 'spec/wire/v1');
const expectedVersionFiles = new Set([
  'auth-contract.json',
  'auth-vectors.json',
  'contract.json',
  'envelope-contract.json',
  'envelope-vectors.json',
  'golden-vectors.json',
  'resolution-table.json',
]);
const unexpected = fs
  .readdirSync(versionDirectory)
  .filter((name) => !expectedVersionFiles.has(name));
if (unexpected.length) {
  console.error(`FAIL: unlisted v1 contract file(s): ${unexpected.join(', ')}`);
  process.exit(1);
}

const snapshots = new Map(
  contractFiles.map((relativePath) => [
    relativePath,
    stableSnapshot(relativePath),
  ])
);
const descriptor = JSON.parse(
  snapshots.get('spec/wire/v1/contract.json').bytes.toString('utf8')
);

if (verifySourceCommit) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sourceCommit}^{commit}`], {
      cwd: root,
      stdio: 'ignore',
    });
  } catch {
    console.error(`FAIL: source commit does not resolve: ${sourceCommit}`);
    process.exit(1);
  }
  for (const [relativePath, snapshot] of snapshots) {
    let committed;
    try {
      committed = execFileSync(
        'git',
        ['show', `${sourceCommit}:${relativePath}`],
        {
          cwd: root,
          encoding: 'buffer',
        }
      );
    } catch {
      console.error(`FAIL: ${relativePath} does not exist in ${sourceCommit}`);
      process.exit(1);
    }
    if (!snapshot.bytes.equals(committed)) {
      console.error(`FAIL: ${relativePath} differs from ${sourceCommit}`);
      process.exit(1);
    }
  }
}

const files = [...snapshots].map(([relativePath, snapshot]) => {
  return {
    path: relativePath,
    sha256: crypto.createHash('sha256').update(snapshot.bytes).digest('hex'),
  };
});
const manifest = {
  manifestVersion: 1,
  sourceCommit,
  contractVersion: descriptor.contractVersion,
  supportedHeaderVersions: [descriptor.header.version],
  descriptors: [
    'spec/wire/v1/contract.json',
    'spec/wire/v1/auth-contract.json',
    'spec/wire/v1/envelope-contract.json',
    'spec/wire/v1/resolution-table.json',
  ],
  vectorSets: [
    'spec/wire/v1/golden-vectors.json',
    'spec/wire/v1/auth-vectors.json',
    'spec/wire/v1/envelope-vectors.json',
  ],
  files,
};
const encoded = `${JSON.stringify(manifest, null, 2)}\n`;

for (const [relativePath, snapshot] of snapshots) {
  const absolutePath = path.join(root, relativePath);
  if (
    !snapshot.bytes.equals(fs.readFileSync(absolutePath)) ||
    !sameIdentity(snapshot.identity, identity(absolutePath))
  ) {
    console.error(`FAIL: ${relativePath} changed during manifest generation`);
    process.exit(1);
  }
}

if (output) {
  const absoluteOutput = path.resolve(root, output);
  const absoluteState = packStateOutput
    ? path.resolve(root, packStateOutput)
    : null;
  const absoluteLock = packLock ? path.resolve(root, packLock) : null;
  if (absoluteState === absoluteOutput) {
    console.error('FAIL: pack state output must differ from manifest output');
    process.exit(2);
  }
  const stateFiles = packStateOutput
    ? contractFiles.map((relativePath) => {
        const snapshot = snapshots.get(relativePath);
        const current = identity(path.join(root, relativePath));
        if (!sameIdentity(snapshot.identity, current)) {
          throw new Error(`${relativePath} changed before pack state capture`);
        }
        return { path: relativePath, identity: current };
      })
    : [];
  const lockOwner = absoluteLock
    ? acquireLock(absoluteLock, lockOwnerPid)
    : null;
  try {
    writeAtomic(absoluteOutput, encoded);
    console.log(`ok:   wrote ${path.relative(root, absoluteOutput)}`);

    if (packStateOutput) {
      stateFiles.push({
        path: path.relative(root, absoluteOutput),
        identity: identity(absoluteOutput),
      });
      const packState = `${JSON.stringify(
        {
          packStateVersion: 1,
          sourceCommit,
          lock: { path: path.relative(root, absoluteLock), ...lockOwner },
          files: stateFiles,
        },
        null,
        2
      )}\n`;
      writeAtomic(absoluteState, packState);
      console.log(`ok:   wrote ${path.relative(root, absoluteState)}`);
    }
  } catch (error) {
    if (absoluteLock) {
      fs.rmSync(absoluteLock, { recursive: true, force: true });
    }
    throw error;
  }
} else {
  process.stdout.write(encoded);
}
