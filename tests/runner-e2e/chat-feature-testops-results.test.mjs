import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportChatAllure, readBoundChatExport } from './chat-feature-testops-results.mjs';
import { executionId, fullName } from './chat-feature-testops-api.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = { runId: '123', attempt: '1', workflowSha: 'a'.repeat(40), targetSha: 'a'.repeat(40) };
const selected = { ...expected, projectId: 1, caseId: 91, fullName, executionId };
async function fixture(t, changes = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'chat-testops-export-')));
  t.after(() => rm(directory, { recursive: true }));
  const root = path.join(directory, 'export'); await mkdir(root);
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  const shot = { id: 'final-state', file: 'final-state.png', sha256: hash(png) };
  const result = { executionId, suiteId: 'chat-features', caseId: 'create-backlog', profileId: 'runner-opencode-deepseek-1017', provider: 'opencode',
    environmentId: 'local', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017', runtimeMode: 'native', attempt: 1,
    source: { sha: expected.targetSha }, status: 'passed', cleanup: 'passed', runIds: ['synthetic-run'], durationMs: 1234,
    matcherResults: [{ matcher: { kind: 'json_path', path: 'chatFeature.createdTask', expected: true }, passed: true }], screenshots: [shot], ...changes };
  const files = new Map([['normalized-results.json', Buffer.from(JSON.stringify({ schema: 'paperclip.runner-e2e.campaign/v2', campaignId: 'gha-123-1', complete: false, results: [result] }))],
    ['junit.xml', Buffer.from('<testsuite tests="1"/>')], [`evidence/${executionId}/attempt-1/final-state.png`, png]]);
  const binding = { schema: 'paperclip.chat-feature-testops-export/v1', ...expected, executionId, campaignId: 'gha-123-1', resultStatus: result.status, cleanup: result.cleanup,
    files: [...files].map(([name, bytes]) => ({ path: name, sha256: hash(bytes), bytes: bytes.length })) };
  for (const [name, bytes] of files) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); }
  await writeFile(path.join(root, 'binding.json'), JSON.stringify(binding));
  return { directory, root, output: path.join(directory, 'allure'), result, binding };
}

test('bound synthetic selected result maps to existing Allure case, independent of whole-suite complete', async t => {
  const f = await fixture(t);
  const value = await exportChatAllure({ ...f, expected, selected });
  assert.equal(value.status, 'passed'); assert.equal(value.count, 1);
  const name = (await readdir(f.output)).find(name => name.endsWith('-result.json'));
  const result = JSON.parse(await readFile(path.join(f.output, name)));
  assert.equal(result.fullName, fullName); assert.deepEqual(result.labels[0], { name: 'AS_ID', value: '91' });
  assert.equal(result.attachments.filter(row => row.type === 'image/png').length, 1);
});

test('real failed outcome stays failed and no absence can synthesize a pass', async t => {
  const f = await fixture(t, { status: 'failed', cleanup: 'failed' });
  assert.equal((await exportChatAllure({ ...f, expected, selected })).status, 'failed');
  await assert.rejects(exportChatAllure({ root: path.join(f.directory, 'absent'), output: path.join(f.directory, 'missing'), expected, selected }));
});

test('foreign source or selection and tampered file hash reject', async t => {
  const f = await fixture(t);
  await assert.rejects(readBoundChatExport(f.root, { ...expected, runId: '456' }));
  await assert.rejects(exportChatAllure({ ...f, expected, selected: { ...selected, projectId: 2 } }));
  await writeFile(path.join(f.root, 'junit.xml'), 'tampered');
  await assert.rejects(readBoundChatExport(f.root, expected));
});

test('an unmanifested file, unknown directory or symlink is rejected before upload', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'provider-raw.txt'), 'SYNTHETIC_PRIVATE_NEVER_READ');
  await assert.rejects(readBoundChatExport(f.root, expected));
  await rm(path.join(f.root, 'provider-raw.txt'));
  await mkdir(path.join(f.root, 'unknown-empty'));
  await assert.rejects(readBoundChatExport(f.root, expected));
  await rm(path.join(f.root, 'unknown-empty'), { recursive: true });
  await rm(path.join(f.root, 'junit.xml')); await symlink(path.join(f.root, 'normalized-results.json'), path.join(f.root, 'junit.xml'));
  await assert.rejects(readBoundChatExport(f.root, expected));
});

test('passing result cannot omit independent checks, cleanup or actual feature capture', async t => {
  for (const changes of [{ matcherResults: [] }, { cleanup: 'failed' }, { runIds: [] }, { screenshots: [] },
    { matcherResults: [{ matcher: { kind: 'json_path', path: 'chatFeature.createdTask', expected: true }, passed: false }] }]) {
    const f = await fixture(t, changes);
    await assert.rejects(exportChatAllure({ ...f, expected, selected }));
  }
});
