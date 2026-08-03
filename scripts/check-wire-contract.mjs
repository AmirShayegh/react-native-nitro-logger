#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const renderer = path.join(root, 'scripts/render-wire-doc.mjs');
const builder = path.join(root, 'scripts/build-wire-contract-manifest.mjs');
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nitro-wire-contract-')
);

try {
  execFileSync(node, [renderer, '--check'], { cwd: root, stdio: 'inherit' });

  const first = path.join(temporary, 'first.json');
  const second = path.join(temporary, 'second.json');
  for (const output of [first, second]) {
    execFileSync(
      node,
      [builder, '--source-commit', sourceCommit, '--output', output],
      { cwd: root, stdio: 'pipe' }
    );
  }

  const firstBytes = fs.readFileSync(first);
  const secondBytes = fs.readFileSync(second);
  if (!firstBytes.equals(secondBytes)) {
    throw new Error('manifest generation is not byte-for-byte deterministic');
  }

  const manifest = JSON.parse(firstBytes);
  if (manifest.sourceCommit !== sourceCommit) {
    throw new Error('manifest did not preserve the explicit source commit');
  }
  for (const entry of manifest.files) {
    const bytes = fs.readFileSync(path.join(root, entry.path));
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`manifest digest mismatch for ${entry.path}`);
    }
  }

  const malformed = spawnSync(
    node,
    [builder, '--source-commit', 'not-a-commit'],
    { cwd: root, encoding: 'utf8' }
  );
  if (malformed.status !== 2) {
    throw new Error(
      'manifest builder did not reject a malformed source commit'
    );
  }

  for (const malformedArgs of [
    ['--source-commit', sourceCommit, '--output'],
    ['--source-commit', sourceCommit, '--pack-state-output', 'state.json'],
    ['--source-commit', sourceCommit, '--unknown', 'value'],
    [
      '--source-commit',
      sourceCommit,
      '--verify-source-commit',
      '--verify-source-commit',
    ],
  ]) {
    const result = spawnSync(node, [builder, ...malformedArgs], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status !== 2) {
      throw new Error(
        `manifest builder accepted malformed arguments: ${malformedArgs.join(' ')}`
      );
    }
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'))
  );
  if (
    !packageJson.files.includes('docs/*.md') ||
    !packageJson.files.includes('spec/wire')
  ) {
    throw new Error(
      'npm files does not include public documents and versioned wire artifacts'
    );
  }

  const committedTree = path.join(temporary, 'committed-tree');
  for (const relativePath of [
    'scripts/build-wire-contract-manifest.mjs',
    'scripts/verify-wire-contract-manifest.mjs',
    'docs/WIRE.md',
    'spec/wire/v1/contract.json',
    'spec/wire/v1/golden-vectors.json',
  ]) {
    const target = path.join(committedTree, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relativePath), target);
  }
  for (const gitArgs of [
    ['init', '--quiet'],
    ['config', 'user.email', 'wire-check@example.invalid'],
    ['config', 'user.name', 'Wire Contract Check'],
    ['add', '.'],
    ['commit', '--quiet', '-m', 'fixture'],
  ]) {
    execFileSync('git', gitArgs, { cwd: committedTree, stdio: 'ignore' });
  }
  const committedSource = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: committedTree,
    encoding: 'utf8',
  }).trim();
  const committedBuilder = path.join(
    committedTree,
    'scripts/build-wire-contract-manifest.mjs'
  );
  const committedBuildArgs = [
    committedBuilder,
    '--source-commit',
    committedSource,
    '--verify-source-commit',
    '--output',
    'spec/wire/manifest.json',
    '--pack-state-output',
    '.wire-pack-state.json',
    '--pack-lock',
    '.wire-pack-lock',
    '--lock-owner-pid',
    String(process.pid),
  ];
  const buildCommittedManifest = () => {
    execFileSync(node, committedBuildArgs, {
      cwd: committedTree,
      stdio: 'ignore',
    });
  };
  buildCommittedManifest();
  const concurrentBuild = spawnSync(node, committedBuildArgs, {
    cwd: committedTree,
    encoding: 'utf8',
  });
  if (
    concurrentBuild.status !== 1 ||
    !concurrentBuild.stderr.includes('another packaging process owns')
  ) {
    throw new Error('a concurrent package build acquired the shared lock');
  }
  const committedVerifier = path.join(
    committedTree,
    'scripts/verify-wire-contract-manifest.mjs'
  );
  execFileSync(node, [committedVerifier], {
    cwd: committedTree,
    stdio: 'ignore',
  });
  const packLockPath = path.join(committedTree, '.wire-pack-lock');
  fs.mkdirSync(packLockPath);
  fs.writeFileSync(
    path.join(packLockPath, 'owner.json'),
    `${JSON.stringify({ token: '0'.repeat(64), pid: 2_147_483_646 })}\n`
  );
  const contend = () =>
    new Promise((resolve) => {
      const child = spawn(node, committedBuildArgs, {
        cwd: committedTree,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('close', (status) => resolve({ status, stderr }));
    });
  const staleContenders = await Promise.all([contend(), contend()]);
  if (
    staleContenders.filter(({ status }) => status === 0).length !== 1 ||
    staleContenders.filter(({ status }) => status === 1).length !== 1
  ) {
    throw new Error(
      `stale packaging lock did not elect exactly one owner: ${JSON.stringify(staleContenders)}`
    );
  }
  execFileSync(node, [committedVerifier], {
    cwd: committedTree,
    stdio: 'ignore',
  });

  buildCommittedManifest();
  const ownerPath = path.join(packLockPath, 'owner.json');
  const mismatchedOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  mismatchedOwner.token = 'f'.repeat(64);
  fs.writeFileSync(ownerPath, `${JSON.stringify(mismatchedOwner)}\n`);
  const mismatchedLock = spawnSync(node, [committedVerifier], {
    cwd: committedTree,
    encoding: 'utf8',
  });
  if (
    mismatchedLock.status !== 1 ||
    !mismatchedLock.stderr.includes('does not own the packaging lock') ||
    fs.existsSync(packLockPath)
  ) {
    throw new Error('postpack verifier accepted mismatched lock ownership');
  }

  const wirePath = path.join(committedTree, 'docs/WIRE.md');
  const originalWire = fs.readFileSync(wirePath);
  buildCommittedManifest();
  fs.appendFileSync(wirePath, '\n');
  const dirtySource = spawnSync(
    node,
    [
      committedBuilder,
      '--source-commit',
      committedSource,
      '--verify-source-commit',
    ],
    { cwd: committedTree, encoding: 'utf8' }
  );
  if (
    dirtySource.status !== 1 ||
    !dirtySource.stderr.includes('differs from')
  ) {
    throw new Error(
      'manifest builder did not reject bytes absent from its source commit'
    );
  }
  const dirtyPackage = spawnSync(node, [committedVerifier], {
    cwd: committedTree,
    encoding: 'utf8',
  });
  if (
    dirtyPackage.status !== 1 ||
    !dirtyPackage.stderr.includes('changed during packaging')
  ) {
    throw new Error(
      'postpack verifier did not reject a mid-package source change'
    );
  }
  fs.writeFileSync(wirePath, originalWire);

  buildCommittedManifest();
  fs.appendFileSync(wirePath, '\n');
  fs.writeFileSync(wirePath, originalWire);
  const restoredPackage = spawnSync(node, [committedVerifier], {
    cwd: committedTree,
    encoding: 'utf8',
  });
  if (
    restoredPackage.status !== 1 ||
    !restoredPackage.stderr.includes('changed during packaging')
  ) {
    throw new Error(
      'postpack verifier did not detect a source changed and restored during packaging'
    );
  }

  buildCommittedManifest();
  const packStatePath = path.join(committedTree, '.wire-pack-state.json');
  fs.writeFileSync(packStatePath, '{malformed');
  const unreadableState = spawnSync(node, [committedVerifier], {
    cwd: committedTree,
    encoding: 'utf8',
  });
  if (
    unreadableState.status !== 1 ||
    fs.existsSync(packStatePath) ||
    fs.existsSync(packLockPath)
  ) {
    throw new Error('malformed pack state was not cleaned after rejection');
  }

  const rejectStateMutation = (mutate, expected) => {
    buildCommittedManifest();
    const state = JSON.parse(fs.readFileSync(packStatePath, 'utf8'));
    mutate(state);
    fs.writeFileSync(packStatePath, `${JSON.stringify(state, null, 2)}\n`);
    const result = spawnSync(node, [committedVerifier], {
      cwd: committedTree,
      encoding: 'utf8',
    });
    if (result.status !== 1 || !result.stderr.includes(expected)) {
      throw new Error(`postpack verifier accepted invalid state: ${expected}`);
    }
  };
  rejectStateMutation((state) => {
    state.packStateVersion = 2;
  }, 'invalid file inventory');
  rejectStateMutation((state) => {
    state.sourceCommit = 'abcdef0123456789abcdef0123456789abcdef01';
  }, 'source commits differ');

  buildCommittedManifest();
  const manifestPath = path.join(committedTree, 'spec/wire/manifest.json');
  const malformedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  malformedManifest.sourceCommit = 'not-a-commit';
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(malformedManifest, null, 2)}\n`
  );
  const malformedState = JSON.parse(fs.readFileSync(packStatePath, 'utf8'));
  malformedState.sourceCommit = 'not-a-commit';
  const manifestStat = fs.statSync(manifestPath, { bigint: true });
  const manifestState = malformedState.files.find(
    (entry) => entry.path === 'spec/wire/manifest.json'
  );
  for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
    manifestState.identity[key] = manifestStat[key].toString();
  }
  fs.writeFileSync(
    packStatePath,
    `${JSON.stringify(malformedState, null, 2)}\n`
  );
  const malformedPackage = spawnSync(node, [committedVerifier], {
    cwd: committedTree,
    encoding: 'utf8',
  });
  if (
    malformedPackage.status !== 1 ||
    !malformedPackage.stderr.includes('no canonical source commit')
  ) {
    throw new Error('postpack verifier accepted a malformed source commit');
  }

  buildCommittedManifest();
  fs.writeFileSync(path.join(committedTree, 'unrelated.txt'), 'next commit\n');
  execFileSync('git', ['add', 'unrelated.txt'], {
    cwd: committedTree,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '--quiet', '-m', 'unrelated'], {
    cwd: committedTree,
    stdio: 'ignore',
  });
  const changedHead = spawnSync(node, [committedVerifier], {
    cwd: committedTree,
    encoding: 'utf8',
  });
  if (
    changedHead.status !== 1 ||
    !changedHead.stderr.includes('changed during packaging')
  ) {
    throw new Error('postpack verifier did not reject a HEAD transition');
  }

  console.log('ok:   wire manifest is deterministic and every digest matches');
  console.log('ok:   malformed manifest source commits fail closed');
  console.log('ok:   malformed manifest arguments fail closed');
  console.log('ok:   npm files includes every public wire artifact root');
  console.log(
    'ok:   manifest provenance accepts committed and rejects dirty bytes'
  );
  console.log(
    'ok:   postpack rejects persistent, restored, malformed, and HEAD changes'
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
