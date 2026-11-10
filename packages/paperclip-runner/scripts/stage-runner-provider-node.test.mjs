import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { stageExecutableSnapshot, stageProviderNode } from './stage-runner-provider-node.mjs';

test('a writable executable becomes a byte-identical private snapshot without changing its source', t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-node-snapshot-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'host-node'); writeFileSync(source, 'same executable bytes'); chmodSync(source, 0o777);
  const receipt = stageExecutableSnapshot(source, join(root, 'private'));
  assert.deepEqual(readFileSync(receipt.staged.path), readFileSync(source));
  assert.equal(receipt.source.mode, 0o777); assert.equal(lstatSync(source).mode & 0o777, 0o777);
  assert.equal(receipt.staged.mode, 0o500); assert.equal(receipt.directoryMode, 0o700);
  assert.equal(receipt.source.sha256, receipt.staged.sha256);
});

test('links, directories, nonexecutables and reused output directories cannot become provider Node', t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-node-rejections-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'host-node'); writeFileSync(source, 'bytes'); chmodSync(source, 0o755);
  const linked = join(root, 'linked'); symlinkSync(source, linked);
  assert.throws(() => stageExecutableSnapshot(linked, join(root, 'link-output')), /regular file/u);
  assert.throws(() => stageExecutableSnapshot(root, join(root, 'directory-output')), /regular file/u);
  chmodSync(source, 0o644);
  assert.throws(() => stageExecutableSnapshot(source, join(root, 'not-executable')), /not executable/u);
  chmodSync(source, 0o755); const existing = join(root, 'existing'); mkdirSync(existing); writeFileSync(join(existing, 'sentinel'), 'preserve');
  assert.throws(() => stageExecutableSnapshot(source, existing), /EEXIST/u);
  assert.equal(readFileSync(join(existing, 'sentinel'), 'utf8'), 'preserve');
  assert.throws(() => stageExecutableSnapshot(source, 'relative'), /absolute/u);
  assert.throws(() => stageExecutableSnapshot(source, `${root}\ninjected`), /absolute/u);
});

test('the wrapper binds real Node on Linux and rejects other platforms or unsafe sidecars', t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-node-linux-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, 'sidecar.cjs'); writeFileSync(sidecar, '// fixture sidecar'); chmodSync(sidecar, 0o644);
  if (process.platform !== 'linux') {
    assert.throws(() => stageProviderNode({ directory: join(root, 'owned'), sidecar }), /requires Linux/u);
    return;
  }
  const receipt = stageProviderNode({ directory: join(root, 'owned'), sidecar });
  assert.equal(receipt.version, process.version); assert.equal(receipt.staged.path, join(root, 'owned/node'));
  assert.equal(receipt.source.sha256, receipt.staged.sha256); assert.equal(receipt.sidecar.mode, 0o644);
  assert.equal(execFileSync(receipt.staged.path, ['-p', 'process.execPath'], { encoding: 'utf8' }).trim(), receipt.staged.path);
  chmodSync(sidecar, 0o666);
  assert.throws(() => stageProviderNode({ directory: join(root, 'unsafe-sidecar'), sidecar }), /sidecar/u);
});

test('the workflow CLI records closed modes and hashes and exposes only the private executable directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'provider-node-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidecar = join(root, 'sidecar.cjs'); writeFileSync(sidecar, '// fixture sidecar'); chmodSync(sidecar, 0o644);
  const output = join(root, 'path'), receiptPath = join(root, 'receipt.json'), directory = join(root, 'owned');
  const args = [resolve(import.meta.dirname, 'stage-runner-provider-node.mjs'), directory, sidecar, receiptPath];
  if (process.platform !== 'linux') {
    assert.throws(() => execFileSync(process.execPath, args, { env: { PATH: process.env.PATH, GITHUB_PATH: output }, stdio: 'pipe' }));
    return;
  }
  execFileSync(process.execPath, args, { env: { PATH: process.env.PATH, GITHUB_PATH: output, ANTHROPIC_API_KEY: 'must-not-appear' }, stdio: 'pipe' });
  const raw = readFileSync(receiptPath, 'utf8'), receipt = JSON.parse(raw);
  assert.equal(receipt.schema, 'paperclip.runner-provider-node/v1'); assert.equal(receipt.staged.mode, 0o500);
  assert.equal(readFileSync(output, 'utf8'), `${directory}\n`); assert.doesNotMatch(raw, /must-not-appear|ANTHROPIC_API_KEY/u);
});
