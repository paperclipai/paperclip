import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageRoot, verifyPackage } from './verify-package.mjs';

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
