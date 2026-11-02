import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { targetSha, model, hash, validateSelection, validRunCount, reject } from './chat-completion-testops-contract.mjs';

async function inventory(root, relative = '') {
  const found = []; const entries = await readdir(path.join(root, relative));
  if (entries.length > 12) reject('export_inventory');
  for (const name of entries) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || ['.', '..'].includes(name)) reject('export_path');
    const file = relative ? `${relative}/${name}` : name, stat = await lstat(path.join(root, file));
    if (stat.isSymbolicLink() || stat.nlink !== 1 && !stat.isDirectory()) reject('export_path');
    if (stat.isDirectory()) {
      reject('export_path');
    } else if (stat.isFile() && stat.size <= 12 * 1024 * 1024) found.push(file);
    else reject('export_path');
    if (found.length > 8) reject('export_inventory');
  }
  return found;
}

export async function readPilotExport(root, context, selection) {
  const selected = validateSelection(selection, context, selection.allureJobRunId);
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== path.resolve(root)) reject('export_path');
  const files = await inventory(root);
  if (!files.includes('binding.json')) reject('export_binding');
  const bindingBytes = await readFile(path.join(root, 'binding.json'));
  if (bindingBytes.length > 32_768) reject('export_binding');
  const binding = JSON.parse(bindingBytes);
  if (binding.schema !== 'paperclip.chat-completion-testops-export/v1' || binding.runId !== context.runId || binding.attempt !== '1'
    || binding.workflowSha !== context.workflowSha || binding.targetSha !== targetSha || binding.campaignId !== `gha-${context.runId}-1`
    || JSON.stringify(binding.executionIds) !== JSON.stringify(selected.map(row => row.executionId)) || !Array.isArray(binding.files)
    || binding.files.length !== 2 || !Array.isArray(binding.privateEvidence) || binding.privateEvidence.length !== selected.length
    || new Set(binding.privateEvidence.map(row => row.executionId)).size !== selected.length) reject('export_binding');
  const names = binding.files.map(row => row.path);
  const allowed = ['normalized-results.json', 'junit.xml'];
  if (new Set(names).size !== names.length || names.some(name => !allowed.includes(name)) || !names.includes('normalized-results.json')
    || !names.includes('junit.xml') || JSON.stringify([...names, 'binding.json'].sort()) !== JSON.stringify(files.sort())) reject('export_inventory');
  const retained = new Map(); let total = 0;
  for (const row of binding.files) {
    if (!/^[a-f0-9]{64}$/.test(row.sha256 ?? '') || !Number.isSafeInteger(row.bytes) || row.bytes < 0) reject('export_inventory');
    const before = await lstat(path.join(root, row.path)), bytes = await readFile(path.join(root, row.path)), after = await lstat(path.join(root, row.path));
    total += bytes.length;
    if (total > 32 * 1024 * 1024 || bytes.length !== row.bytes || hash(bytes) !== row.sha256 || before.ino !== after.ino
      || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) reject('export_changed');
    retained.set(row.path, bytes);
  }
  const normalized = retained.get('normalized-results.json');
  if (normalized.length > 2_000_000) reject('export_inventory');
  const campaign = JSON.parse(normalized);
  if (campaign.schema !== 'paperclip.runner-e2e.campaign/v2' || campaign.campaignId !== binding.campaignId || campaign.retries !== 0
    || !Array.isArray(campaign.results) || campaign.results.length !== selected.length
    || new Set(campaign.results.map(row => row.executionId)).size !== selected.length) reject('export_results');
  for (const row of campaign.results) {
    const expected = selected.find(value => value.executionId === row.executionId);
    if (!expected || row.suiteId !== 'chat-features' || row.caseId !== expected.scenario || row.profileId !== 'runner-opencode'
      || row.provider !== 'opencode' || row.environmentId !== 'local' || row.model !== model || row.runtimeMode !== 'native'
      || row.attempt !== 1 || row.source?.sha !== targetSha || row.source?.workflowRunUrl !== `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}`
      || !['passed', 'failed'].includes(row.status) || !['passed', 'failed', 'not_started'].includes(row.cleanup)
      || !Array.isArray(row.matcherResults) || row.matcherResults.length > 200 || !Array.isArray(row.screenshots) || row.screenshots.length !== 0) reject('export_result');
    if (row.matcherResults.some(check => check.matcher?.kind !== 'json_path' || !/^[A-Za-z0-9._-]{1,150}$/.test(check.matcher.path)
      || check.matcher.expected !== true || typeof check.passed !== 'boolean')) reject('export_checks');
    const evidence = binding.privateEvidence.find(value => value.executionId === row.executionId);
    if (!evidence || ![true, false, null].includes(evidence.requiredEvidenceComplete)
      || evidence.finalScreenshot !== null && (!/^[a-f0-9]{64}$/.test(evidence.finalScreenshot?.sha256 ?? '')
        || !Number.isSafeInteger(evidence.finalScreenshot.bytes) || evidence.finalScreenshot.bytes < 24 || evidence.finalScreenshot.bytes > 12 * 1024 * 1024)) reject('private_evidence_receipt');
    if (row.status === 'passed' && (row.cleanup !== 'passed' || row.matcherResults.length !== expected.checks
      || row.matcherResults.some(check => !check.passed) || !validRunCount(row.runIds, expected)
      || evidence.requiredEvidenceComplete !== true || evidence.finalScreenshot === null)) reject('export_incomplete_pass');
  }
  return { campaign, selected, retained, privateEvidence: binding.privateEvidence };
}

export async function exportPilotAllure(root, output, context, selection) {
  const { campaign, selected, privateEvidence } = await readPilotExport(root, context, selection);
  await mkdir(output, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await lstat(output);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid() || (await readdir(output)).length) reject('allure_output');
  const exported = [];
  for (const selectedCase of selected) {
    const result = campaign.results.find(row => row.executionId === selectedCase.executionId);
    const status = result.status === 'passed' && result.cleanup === 'passed' ? 'passed' : 'failed';
    const attachments = [], metadata = [];
    const attach = async (name, type, bytes, suffix) => {
      const source = `${randomUUID()}-attachment.${suffix}`;
      await writeFile(path.join(output, source), bytes, { flag: 'wx', mode: 0o600 });
      attachments.push({ name, source, type }); metadata.push({ name, contentType: type, contentLength: bytes.length });
    };
    const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const provenance = { schema: 'paperclip.chat-completion-testops-provenance/v1', campaignId: campaign.campaignId,
      runId: context.runId, attempt: 1, workflowSha: context.workflowSha, sourceSha: targetSha,
      executionId: selectedCase.executionId, scenario: selectedCase.scenario, status: result.status, cleanup: result.cleanup,
      definitionHash: /^[a-f0-9]{64}$/.test(result.suiteDefinitionHash ?? '') ? result.suiteDefinitionHash : null,
      model, runtime: 'native', environment: 'local on GitHub Actions / AWS', durationMs: numeric(result.durationMs),
      billing: { complete: typeof result.billing?.complete === 'boolean' ? result.billing.complete : null,
        reportedCostUsd: numeric(result.billing?.reportedCostUsd), estimatedRuntimeCostUsd: numeric(result.billing?.estimatedRuntimeCostUsd),
        observedAndEstimatedCostUsd: numeric(result.billing?.observedAndEstimatedCostUsd) },
      checks: result.matcherResults.map(row => ({ path: row.matcher.path, passed: row.passed })),
      note: 'Original case clocks, one attempt and no eval retries. Setup usage and AWS accounting may be incomplete. Private original evidence remains separate.' };
    await attach('Execution provenance and checks', 'application/json', Buffer.from(JSON.stringify(provenance, null, 2)), 'json');
    const evidence = privateEvidence.find(row => row.executionId === result.executionId);
    const evidenceReceipt = { schema: 'paperclip.chat-completion-testops-private-evidence/v1', runId: context.runId, attempt: 1,
      executionId: result.executionId, ...evidence, storage: 'existing protected Runner E2E history',
      archiveKind: `manual-cell-${hash(result.executionId)}`,
      note: 'Only this availability receipt and checksum are attached. Original screenshots and diagnostics require authenticated private-history retrieval.' };
    await attach('Private evidence receipt', 'application/json', Buffer.from(JSON.stringify(evidenceReceipt, null, 2)), 'json');
    const value = { uuid: randomUUID(), name: selectedCase.name, fullName: selectedCase.fullName,
      testCaseId: hash(`${JSON.stringify(selectedCase.fullName)}\n`),
      historyId: hash(JSON.stringify([selectedCase.fullName, 'runner-opencode', model, 'local'])), status, stage: 'finished',
      statusDetails: { message: status === 'passed' ? 'Real Product E2E assertions and cleanup passed' : 'Original evaluation or cleanup failed' },
      labels: [{ name: 'AS_ID', value: String(selectedCase.caseId) }, { name: 'parentSuite', value: 'Product E2E' },
        { name: 'suite', value: 'chat-features' }, { name: 'area', value: 'Chat and collaboration' },
        { name: 'framework', value: 'Paperclip Evals' }, { name: 'tag', value: 'chat-completion-testops' }],
      parameters: [{ name: 'canonicalScenario', value: selectedCase.scenario }, { name: 'model', value: model },
        { name: 'environment', value: 'GitHub Actions / AWS' }],
      links: [{ name: 'GitHub Actions run', type: 'custom', url: `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}` },
        { name: 'Evaluated source', type: 'custom', url: `https://github.com/paperclipai/paperclip/commit/${targetSha}` }],
      steps: result.matcherResults.map(row => ({ name: row.matcher.path, status: row.passed ? 'passed' : 'failed', stage: 'finished' })), attachments };
    for (const [key, time] of [['start', result.startedAt], ['stop', result.finishedAt]]) if (Number.isFinite(Date.parse(time))) value[key] = Date.parse(time);
    await writeFile(path.join(output, `${value.uuid}-result.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    exported.push({ caseId: selectedCase.caseId, executionId: selectedCase.executionId, status, cleanup: result.cleanup, attachments: metadata });
  }
  return exported;
}
