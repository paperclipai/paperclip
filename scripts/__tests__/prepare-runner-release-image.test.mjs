import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { validateReleaseRun, selectReleaseArtifacts, validateReleaseImageBase, validateImageBindings, decodeReleaseJson } from '../prepare-runner-release-image.mjs';

const source = 'a'.repeat(40);
const run = { head_sha: source, conclusion: 'success', path: '.github/workflows/release-smoke.yml', repository: { full_name: 'paperclipai/paperclip' } };
const artifacts = ['runner-provider-packs-123-2-linux-x64', 'runner-release-123-2-linux-x64', 'claude-qualification-public-packages']
  .map((name, index) => ({ id: index + 1, name, expired: false, digest: 'sha256:' + 'b'.repeat(64), size_in_bytes: 100 }));

test('release image consumes one successful exact-source producer set', () => {
  assert.doesNotThrow(() => validateReleaseRun(run, source));
  assert.deepEqual(selectReleaseArtifacts(artifacts, '123', 2), artifacts);
});

test('frozen runtime source can differ from workflow dispatch source', () => {
  assert.doesNotThrow(() => validateReleaseRun({ ...run, head_sha: 'c'.repeat(40) }, source));
});

for (const [name, patch] of [
  ['invalid workflow source', { head_sha: 'not-a-sha' }],
  ['incomplete producer', { conclusion: null }],
  ['failed producer', { conclusion: 'failure' }],
  ['unrelated workflow', { path: '.github/workflows/ci.yml' }],
  ['fork artifact', { repository: { full_name: 'fork/paperclip' } }],
]) test('rejects ' + name, () => assert.throws(() => validateReleaseRun({ ...run, ...patch }, source)));

for (const [name, values] of [
  ['missing pack', artifacts.slice(1)],
  ['duplicate authority', [...artifacts, artifacts[0]]],
  ['expired artifact', artifacts.map((a, i) => i ? a : { ...a, expired: true })],
  ['unbound digest', artifacts.map((a, i) => i ? a : { ...a, digest: null })],
  ['oversized archive', artifacts.map((a, i) => i ? a : { ...a, size_in_bytes: 3 * 1024 ** 3 })],
  ['wrong attempt', artifacts.map((a, i) => i ? a : { ...a, name: 'runner-provider-packs-123-1-linux-x64' })],
]) test('rejects ' + name, () => assert.throws(() => selectReleaseArtifacts(values, '123', 2)));

test('base image must be immutable and repository-owned', () => {
  assert.equal(validateReleaseImageBase('ghcr.io/paperclipai/paperclip-daytona-runner@sha256:' + source + 'b'.repeat(24)), 'ghcr.io/paperclipai/paperclip-daytona-runner@sha256:' + source + 'b'.repeat(24));
  for (const base of ['ghcr.io/paperclipai/paperclip-daytona-runner:latest', 'ghcr.io/fork/paperclip-daytona-runner@sha256:' + 'a'.repeat(64), 'ubuntu:latest']) {
    assert.throws(() => validateReleaseImageBase(base));
  }
});

const daemonBytes = Buffer.alloc(64);
daemonBytes.write('7f454c46', 0, 'hex');
daemonBytes[4] = 2;
daemonBytes[5] = 1;
daemonBytes.writeUInt16LE(62, 18);
const daemonDigest = 'sha256:' + createHash('sha256').update(daemonBytes).digest('hex');
const binding = { source, pack: { digest: 'release', payload: { productionLock: 'original', candidateProviders: { pi: 'qualified' } } },
  receipt: { schema: 'paperclip.runner.release-artifact.v1', sourceRevision: source, target: 'linux-x64', sha256: daemonDigest },
  release: { sourceRevision: source, platforms: { 'linux-x64': { sha256: daemonDigest } } }, daemonBytes };
binding.publicPack = structuredClone(binding.pack);

test('image pack must equal the authority shipped in the public package', () => {
  assert.equal(validateImageBindings(binding), daemonDigest.slice(7));
  for (const changed of [{ productionLock: 'regenerated' }, { candidateProviders: {} }]) {
    const different = structuredClone(binding.pack);
    Object.assign(different.payload, changed);
    assert.throws(() => validateImageBindings({ ...binding, publicPack: different }), /public package authority/);
  }
});

test('image daemon must match source, receipt, public package and actual architecture', () => {
  for (const changed of [{ sourceRevision: 'c'.repeat(40) }, { sha256: 'sha256:' + 'c'.repeat(64) }, { target: 'linux-arm64' }]) {
    assert.throws(() => validateImageBindings({ ...binding, receipt: { ...binding.receipt, ...changed } }));
  }
  assert.throws(() => validateImageBindings({ ...binding, release: { ...binding.release, sourceRevision: 'c'.repeat(40) } }));
  const wrongArch = Buffer.from(daemonBytes); wrongArch.writeUInt16LE(183, 18);
  const digest = 'sha256:' + createHash('sha256').update(wrongArch).digest('hex');
  assert.throws(() => validateImageBindings({ ...binding, daemonBytes: wrongArch,
    receipt: { ...binding.receipt, sha256: digest }, release: { ...binding.release, platforms: { 'linux-x64': { sha256: digest } } } }));
});

test('frozen release JSON must be the bounded requested source file', () => {
  const path = 'packages/paperclip-runner/acpx-profiles.json';
  const content = Buffer.from(JSON.stringify({ acpxVersion: 'frozen' }));
  const file = { type: 'file', path, encoding: 'base64', size: content.length, content: content.toString('base64') };
  assert.deepEqual(decodeReleaseJson(file, path), { acpxVersion: 'frozen' });
  for (const patch of [{ type: 'symlink' }, { path: 'other.json' }, { size: content.length + 1 }, { size: 1024 * 1024 + 1 }, { encoding: 'none' }]) {
    assert.throws(() => decodeReleaseJson({ ...file, ...patch }, path));
  }
});
