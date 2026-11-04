import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageRoot, hash, verifyPackage } from './verify-package.mjs';
import { materializeResource } from './materialize-resource.mjs';

test('packaged source and fixture closure retains its sealed bytes', async () => {
  const result = await verifyPackage();
  assert.equal(result.complete, true);
  assert.equal(result.executionReleased, false);
});

test('template relocation preserves authorization and pins and refuses overwrites', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ingestion-template-paths-'));
  try {
    const input = path.join(packageRoot, 'snapshots/h5e-v4/templates/main-aa-b0.unauthorized.json');
    const original = JSON.parse(await readFile(input, 'utf8'));
    const mapping = path.join(temporary, 'paths.json'), output = path.join(temporary, 'release.json');
    await writeFile(mapping, JSON.stringify({ '/home/ubuntu/native-ingestion': '/fixture/owned' }));
    const args = [path.join(packageRoot, 'relocate-template.mjs'), '--template=' + input, '--path-map=' + mapping, '--output=' + output];
    execFileSync(process.execPath, args);
    const actual = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(actual.authorized, false);
    assert.equal(actual.harnessRoot, '/fixture/owned/harness-h5e');
    for (const name of ['orchestratorSha256', 'harnessRevision', 'protocolSha256', 'comparatorSha256',
      'workloadSha256', 'lockSha256', 'gatesSha256']) assert.equal(actual[name], original[name]);
    assert.deepEqual(actual.prerequisiteEvidence, original.prerequisiteEvidence);
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), error => error.status !== 0);
    const authorized = path.join(temporary, 'authorized.json');
    await writeFile(authorized, JSON.stringify({ ...original, authorized: true }));
    assert.throws(() => execFileSync(process.execPath, [args[0], '--template=' + authorized,
      '--path-map=' + mapping, '--output=' + path.join(temporary, 'must-not-exist.json')], { stdio: 'pipe' }),
    error => error.status !== 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('upstream manifest remains exact data and materializes at its original logical path', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ingestion-resource-stage-'));
  try {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'sources.json'), 'utf8'));
    const row = manifest.files.find(value => value.path.endsWith('/test-fixtures/postgres/package.json'));
    assert.equal(row.storagePath, row.path + '.fixture');
    const stored = await readFile(path.join(packageRoot, row.storagePath));
    assert.equal(JSON.parse(stored).engines.node, '>=12');
    await assert.rejects(readFile(path.join(packageRoot, row.path)), error => error.code === 'ENOENT');
    const output = path.join(temporary, 'resource');
    await materializeResource(output);
    assert.deepEqual(await readFile(path.join(output, 'test-fixtures/postgres/package.json')), stored);
    const packet = JSON.parse(await readFile(path.join(output, 'source-packet.json'), 'utf8'));
    for (const source of packet.sourceFiles) {
      assert.equal(hash(await readFile(path.join(output, source.path))), source.sha256, source.path);
    }
    await assert.rejects(materializeResource(output), error => error.code === 'EEXIST');
    await assert.rejects(materializeResource(path.join(packageRoot, 'must-not-stage-here')), /Stage outside the repository/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
