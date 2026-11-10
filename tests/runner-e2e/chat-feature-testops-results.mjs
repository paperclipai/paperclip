import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { aliases, executionId } from './chat-feature-testops-api.mjs';

export class ExportFailure extends Error {}
const fail = () => { throw new ExportFailure('chat_testops_export_rejected'); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const model = 'openrouter/deepseek/deepseek-v4.1-flash-1017';
const pngPath = new RegExp(`^evidence/${executionId.replaceAll('.', '\\.')}/attempt-1/[A-Za-z0-9][A-Za-z0-9._-]{0,199}\\.png$`);

async function inventory(root, relative = '') {
  const output = [];
  const entries = await readdir(path.join(root, relative));
  if (entries.length > 12) fail();
  for (const name of entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') fail();
    const file = relative ? `${relative}/${name}` : name;
    const stat = await lstat(path.join(root, file));
    if (stat.isSymbolicLink()) fail();
    if (stat.isDirectory()) {
      if (!['evidence', `evidence/${executionId}`, `evidence/${executionId}/attempt-1`].includes(file)) fail();
      output.push(...await inventory(root, file));
    }
    else if (stat.isFile() && stat.nlink === 1 && stat.size <= 12 * 1024 * 1024) output.push(file);
    else fail();
    if (output.length > 12) fail();
  }
  return output;
}

export async function readBoundChatExport(root, expected) {
  if (!/^[1-9][0-9]{0,19}$/.test(expected.runId ?? '') || expected.attempt !== '1'
    || !/^[a-f0-9]{40}$/.test(expected.workflowSha ?? '') || expected.targetSha !== expected.workflowSha) fail();
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== path.resolve(root)) fail();
  const files = await inventory(root);
  if (!files.includes('binding.json')) fail();
  const bindingBytes = await readFile(path.join(root, 'binding.json'));
  if (bindingBytes.length > 128_000) fail();
  const binding = JSON.parse(bindingBytes);
  if (binding.schema !== 'paperclip.chat-feature-testops-export/v1' || binding.attempt !== '1'
    || binding.runId !== expected.runId || binding.workflowSha !== expected.workflowSha || binding.targetSha !== expected.targetSha
    || binding.executionId !== executionId || binding.campaignId !== `gha-${expected.runId}-1`
    || !Array.isArray(binding.files) || binding.files.length < 2 || binding.files.length > 10) fail();
  const names = binding.files.map(row => row.path);
  if (new Set(names).size !== names.length || !names.includes('normalized-results.json') || !names.includes('junit.xml')
    || names.some(name => !['normalized-results.json', 'junit.xml'].includes(name) && !pngPath.test(name))
    || JSON.stringify([...names, 'binding.json'].sort()) !== JSON.stringify(files.sort())) fail();
  const retained = new Map();
  let total = 0;
  for (const row of binding.files) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256 ?? '') || !Number.isSafeInteger(row.bytes) || row.bytes < 0) fail();
    const bytes = await readFile(path.join(root, row.path));
    total += bytes.length;
    if (total > 32 * 1024 * 1024 || bytes.length !== row.bytes || hash(bytes) !== row.sha256) fail();
    retained.set(row.path, bytes);
  }
  const bytes = retained.get('normalized-results.json');
  if (bytes.length > 2_000_000) fail();
  const campaign = JSON.parse(bytes);
  if (campaign.schema !== 'paperclip.runner-e2e.campaign/v2' || campaign.campaignId !== binding.campaignId
    || !Array.isArray(campaign.results) || campaign.results.length !== 1) fail();
  const result = campaign.results[0];
  if (result.executionId !== executionId || result.suiteId !== 'chat-features' || result.caseId !== 'create-backlog'
    || result.profileId !== 'runner-opencode-deepseek-1017' || result.provider !== 'opencode' || result.environmentId !== 'local'
    || result.model !== model || result.runtimeMode !== 'native' || result.attempt !== 1 || result.source?.sha !== expected.targetSha
    || !['passed', 'failed'].includes(result.status) || result.status !== binding.resultStatus
    || !['passed', 'failed', 'not_started'].includes(result.cleanup) || result.cleanup !== binding.cleanup
    || !Array.isArray(result.matcherResults) || result.matcherResults.length > 200 || !Array.isArray(result.screenshots) || result.screenshots.length > 8) fail();
  for (const check of result.matcherResults) if (check.matcher?.kind !== 'json_path' || !/^[A-Za-z0-9._-]{1,150}$/.test(check.matcher.path)
    || check.matcher.expected !== true || typeof check.passed !== 'boolean') fail();
  for (const shot of result.screenshots) {
    const name = `evidence/${executionId}/attempt-1/${shot.file}`;
    const png = retained.get(name);
    if (!png || !png.subarray(0, 8).equals(pngMagic) || png.subarray(12, 16).toString('ascii') !== 'IHDR' || hash(png) !== shot.sha256) fail();
  }
  if (names.filter(name => pngPath.test(name)).length !== result.screenshots.length) fail();
  if (result.status === 'passed' && (result.cleanup !== 'passed' || result.matcherResults.length === 0
    || result.matcherResults.some(check => !check.passed) || result.runIds?.length !== 1
    || !result.screenshots.some(shot => shot.id === 'final-state' && shot.file === 'final-state.png'))) fail();
  return { binding, result, retained };
}

export async function exportChatAllure({ root, output, expected, selected }) {
  if (selected.projectId !== 1 || !Number.isSafeInteger(selected.caseId) || selected.caseId < 1 || !aliases.includes(selected.fullName)
    || selected.runId !== expected.runId || selected.attempt !== '1' || selected.workflowSha !== expected.workflowSha || selected.targetSha !== expected.targetSha
    || selected.executionId !== executionId) fail();
  const { binding, result, retained } = await readBoundChatExport(root, expected);
  await mkdir(output, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const outputStat = await lstat(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || (process.getuid && outputStat.uid !== process.getuid()) || (await readdir(output)).length !== 0) fail();
  const status = result.status === 'passed' && result.cleanup === 'passed' ? 'passed' : 'failed';
  const attachments = [];
  const attachmentMetadata = [];
  for (const shot of result.screenshots) {
    const source = `${randomUUID()}-attachment.png`;
    await writeFile(path.join(output, source), retained.get(`evidence/${executionId}/attempt-1/${shot.file}`), { flag: 'wx', mode: 0o600 });
    attachments.push({ name: 'Synthetic task and source conversation', source, type: 'image/png' });
    attachmentMetadata.push({ name: 'Synthetic task and source conversation', contentType: 'image/png', contentLength: retained.get(`evidence/${executionId}/attempt-1/${shot.file}`).length });
  }
  const projection = { campaignId: binding.campaignId, executionId, runId: expected.runId, attempt: 1,
    workflowSha: expected.workflowSha, sourceSha: expected.targetSha, status: result.status, cleanup: result.cleanup,
    profile: result.profileId, model: result.model, environment: result.environmentId, runtime: result.runtimeMode,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
    failureClass: typeof result.failureClass === 'string' && /^[a-z_]{1,80}$/.test(result.failureClass) ? result.failureClass : null,
    billingComplete: typeof result.billing?.complete === 'boolean' ? result.billing.complete : null,
    checks: result.matcherResults.map(check => ({ path: check.matcher.path, passed: check.passed })),
    note: 'Setup usage and AWS billing are not qualified by this result; missing accounting remains unknown.' };
  const source = `${randomUUID()}-attachment.json`;
  const projectionBytes = Buffer.from(JSON.stringify(projection, null, 2));
  await writeFile(path.join(output, source), projectionBytes, { flag: 'wx', mode: 0o600 });
  attachmentMetadata.push({ name: 'Execution provenance and checks', contentType: 'application/json', contentLength: projectionBytes.length });
  attachments.push({ name: 'Execution provenance and checks', source, type: 'application/json' });
  const normalizedSource = `${randomUUID()}-attachment.json`;
  await writeFile(path.join(output, normalizedSource), retained.get('normalized-results.json'), { flag: 'wx', mode: 0o600 });
  attachments.push({ name: 'Sanitized Product E2E record and accounting', source: normalizedSource, type: 'application/json' });
  attachmentMetadata.push({ name: 'Sanitized Product E2E record and accounting', contentType: 'application/json', contentLength: retained.get('normalized-results.json').length });
  const value = { uuid: randomUUID(), name: 'Create a task backlog through chat', fullName: selected.fullName,
    testCaseId: hash(`${JSON.stringify(selected.fullName)}\n`),
    historyId: hash(JSON.stringify([selected.fullName, result.profileId, result.model, result.environmentId])), status, stage: 'finished',
    statusDetails: { message: status === 'passed' ? 'Real Product E2E assertions and cleanup passed' : 'Real Product E2E evaluation or cleanup failed; original verdict preserved' },
    labels: [{ name: 'AS_ID', value: String(selected.caseId) }, { name: 'parentSuite', value: 'Product E2E' },
      { name: 'suite', value: 'chat-features' }, { name: 'area', value: 'Chat and collaboration' },
      { name: 'framework', value: 'Paperclip Evals' }, { name: 'tag', value: 'chat-feature-testops' }],
    parameters: [{ name: 'canonicalScenario', value: 'tasks.create-backlog' }, { name: 'model', value: model }, { name: 'environment', value: 'GitHub Actions / AWS' }],
    links: [{ name: 'GitHub Actions run', type: 'custom', url: `https://github.com/paperclipai/paperclip/actions/runs/${expected.runId}` },
      { name: 'Evaluated source', type: 'custom', url: `https://github.com/paperclipai/paperclip/commit/${expected.targetSha}` }],
    steps: result.matcherResults.map(check => ({ name: check.matcher.path, status: check.passed ? 'passed' : 'failed', stage: 'finished' })), attachments };
  for (const [key, time] of [['start', result.startedAt], ['stop', result.finishedAt]]) if (Number.isFinite(Date.parse(time))) value[key] = Date.parse(time);
  await writeFile(path.join(output, `${value.uuid}-result.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  return { status, cleanup: result.cleanup, caseId: selected.caseId, campaignId: binding.campaignId, count: 1, attachmentMetadata };
}
