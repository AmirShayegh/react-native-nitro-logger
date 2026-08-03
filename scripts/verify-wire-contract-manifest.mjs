#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'spec/wire/manifest.json');
const packStatePath = path.join(root, '.wire-pack-state.json');
const packLockPath = path.join(root, '.wire-pack-lock');
const expectedStatePaths = new Set([
  'docs/WIRE.md',
  'spec/wire/v1/contract.json',
  'spec/wire/v1/golden-vectors.json',
  'spec/wire/manifest.json',
]);
const identityKeys = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];

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
  return left && identityKeys.every((key) => left[key] === right[key]);
}

try {
  const packState = JSON.parse(fs.readFileSync(packStatePath, 'utf8'));
  if (
    packState.packStateVersion !== 1 ||
    packState.lock?.path !== '.wire-pack-lock' ||
    !/^[0-9a-f]{64}$/.test(packState.lock?.token) ||
    !Number.isSafeInteger(packState.lock?.pid) ||
    packState.lock.pid <= 0 ||
    !Array.isArray(packState.files) ||
    packState.files.length !== expectedStatePaths.size ||
    !packState.files.every((entry) => expectedStatePaths.has(entry.path)) ||
    new Set(packState.files.map((entry) => entry.path)).size !==
      expectedStatePaths.size
  ) {
    throw new Error('wire pack state has an invalid file inventory');
  }
  const lockOwner = JSON.parse(
    fs.readFileSync(path.join(packLockPath, 'owner.json'), 'utf8')
  );
  if (
    lockOwner.token !== packState.lock.token ||
    lockOwner.pid !== packState.lock.pid
  ) {
    throw new Error('wire pack state does not own the packaging lock');
  }
  for (const entry of packState.files) {
    if (!sameIdentity(entry.identity, identity(path.join(root, entry.path)))) {
      throw new Error(`${entry.path} changed during packaging`);
    }
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (!/^[0-9a-f]{40}$/.test(manifest.sourceCommit)) {
    throw new Error('wire manifest has no canonical source commit');
  }
  if (packState.sourceCommit !== manifest.sourceCommit) {
    throw new Error('wire pack state and manifest source commits differ');
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (head !== manifest.sourceCommit) {
    throw new Error(
      `wire manifest source ${manifest.sourceCommit} changed during packaging (now ${head})`
    );
  }

  for (const entry of manifest.files) {
    const worktree = fs.readFileSync(path.join(root, entry.path));
    const actual = crypto.createHash('sha256').update(worktree).digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`${entry.path} changed during packaging`);
    }
    const committed = execFileSync(
      'git',
      ['show', `${manifest.sourceCommit}:${entry.path}`],
      { cwd: root, encoding: 'buffer' }
    );
    if (!worktree.equals(committed)) {
      throw new Error(
        `${entry.path} is not reproducible from ${manifest.sourceCommit}`
      );
    }
  }

  console.log(
    `ok:   packaged wire inputs still match ${manifest.sourceCommit.slice(0, 12)}`
  );
} finally {
  fs.rmSync(packStatePath, { force: true });
  fs.rmSync(packLockPath, { recursive: true, force: true });
}
