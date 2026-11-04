import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productRegressionCases, selectProductRegression, validateSelection, projectProductResults, workflowUrl, workflowUrls } from './product-regression-testops.mjs';
import { admitProductTestOps, officialProductContext, verifyProductJob, validateUploadedProductResults, productTestOps } from './product-regression-testops-cli.mjs';

const workflowSha = 'a'.repeat(40), targetSha = 'b'.repeat(40);
const env = {
  GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_REF: 'refs/heads/master', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: workflowSha, SOURCE_SHA: targetSha,
  ALLURE_ENDPOINT: 'https://paperclip.testops.cloud', ALLURE_PROJECT_ID: '1',
};
const selected = productRegressionCases.find(row => row.id === 66);
const selection = cases => ({ schema: 'paperclip.product-regression-testops-selection/v1', runId: '123', attempt: '1',
  workflowSha, targetSha, jobRunId: '456', launchId: 789, cases });
const result = (overrides = {}) => ({
  executionId: selected.executionId, suiteId: selected.suite, caseId: selected.name,
  profileId: selected.profile, environmentId: 'local', source: { sha: targetSha }, attempt: 1,
  status: 'passed', cleanup: 'passed', model: 'gpt-5.6-sol', suiteDefinitionHash: 'c'.repeat(64),
  matcherResults: [{ matcher: { kind: 'json_path', path: 'observed.outputVerified', expected: true }, passed: true }],
  ...overrides,
});
const campaign = (results = [result()]) => ({ schema: 'paperclip.runner-e2e.campaign/v2', campaignId: 'gha-123-1',
  source: { sha: targetSha }, expected: [selected.executionId], results });
const allPlan = { version: '1.0', tests: productRegressionCases.map(row => ({ id: String(row.id), selector: row.fullName })) };

test('standing plan has 20 unique imported identities and one existing local cell per case', () => {
  assert.equal(productRegressionCases.length, 20);
  assert.equal(new Set(productRegressionCases.map(row => row.id)).size, 20);
  assert.equal(new Set(productRegressionCases.map(row => row.executionId)).size, 20);
  assert.deepEqual(productRegressionCases.filter(row => row.profile !== 'runner-codex').map(row => row.id), [54]);
  assert.equal(selectProductRegression(allPlan, 'message-marker', true).length, 20);
  assert.equal(selectProductRegression(undefined, 'message-marker')[0].id, 66);
});

test('a TestOps subset selects only its exact original case; unknown, duplicate and mismatched identities fail', () => {
  const subset = { version: '1.0', tests: [{ id: '66', selector: selected.fullName }] };
  assert.deepEqual(selectProductRegression(subset, 'all', true), [selected]);
  for (const invalid of [undefined, { version: '1.0', tests: [] },
    { version: '1.0', tests: [{ id: '66', selector: productRegressionCases[0].fullName }] },
    { version: '1.0', tests: [...subset.tests, ...subset.tests] },
    { version: '1.0', tests: [{ id: '9999', selector: selected.fullName }] }]) {
    assert.throws(() => selectProductRegression(invalid, 'all', true));
  }
});

test('selection authority cannot enter through an untrusted workflow, foreign ref, mixed selector or recurring mode', () => {
  admitProductTestOps(env);
  for (const mutation of [{ GITHUB_REF: 'refs/heads/candidate' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_WORKFLOW_REF: 'paperclipai/paperclip/.github/workflows/other.yml@refs/heads/master' },
    { ALLURE_ENDPOINT: 'https://attacker.invalid' }, { SELECT_SUITE: 'core-compatibility' },
    { EVAL_CADENCE: 'daily' }, { SOURCE_SHA: '' }]) assert.throws(() => admitProductTestOps({ ...env, ...mutation }));
  validateSelection(selection([selected]), env);
  assert.throws(() => validateSelection(selection([selected]), { ...env, GITHUB_RUN_ID: '124' }));
  assert.throws(() => validateSelection(selection([selected]), { ...env, SOURCE_SHA: workflowSha }));
});

test('official environment parsing keeps only bound IDs and rejects duplicate or malformed context', () => {
  assert.deepEqual(officialProductContext('ALLURE_TOKEN=private\nALLURE_JOB_RUN_ID=456\nALLURE_LAUNCH_ID=789\n'), { jobRunId: '456', launchId: 789 });
  for (const stdout of ['ALLURE_JOB_RUN_ID=456\n', 'ALLURE_JOB_RUN_ID=456\nALLURE_JOB_RUN_ID=456\nALLURE_LAUNCH_ID=789',
    'ALLURE_JOB_RUN_ID=456\nALLURE_LAUNCH_ID=not-an-id']) assert.throws(() => officialProductContext(stdout));
});

test('reported pass requires real assertions, successful cleanup and exact current source', () => {
  const projected = projectProductResults(campaign(), selection([selected]), targetSha);
  assert.equal(projected.summary.passed, 1);
  assert.equal(projected.records[0].value.labels.find(row => row.name === 'AS_ID').value, '66');
  assert.equal(projected.records[0].value.fullName, selected.fullName);
  for (const partial of [{ cleanup: 'failed' }, { matcherResults: [] },
    { matcherResults: [{ matcher: { kind: 'json_path', path: 'output' }, passed: false }] }]) {
    assert.equal(projectProductResults(campaign([result(partial)]), selection([selected]), targetSha).summary.passed, 0);
  }
  assert.throws(() => projectProductResults(campaign([result({ source: { sha: workflowSha } })]), selection([selected]), targetSha));
  assert.throws(() => projectProductResults({ ...campaign(), campaignId: 'gha-older-1' }, selection([selected]), targetSha));
});

test('missing results remain explicit broken cases and cannot improve the denominator', () => {
  const projected = projectProductResults(undefined, selection(productRegressionCases), targetSha);
  const { cases, ...counts } = projected.summary;
  assert.deepEqual(counts, { selected: 20, passed: 0, failed: 0, broken: 20, fullPlan: true });
  assert.equal(cases.length, 20);
  assert.equal(cases.every(row => row.status === 'broken'), true);
  assert.equal(projected.records.filter(row => row.file.endsWith('-result.json')).length, 20);
  const partial = projectProductResults(campaign([]), selection([selected]), targetSha);
  assert.equal(partial.summary.broken, 1);
  assert.equal(partial.summary.fullPlan, false);
  const missing = result({ attempt: 0, status: 'failed', failureClass: 'permanent_infrastructure', cleanup: 'not_started',
    error: 'No result artifact was uploaded', matcherResults: undefined, source: undefined });
  assert.equal(projectProductResults(campaign([missing]), selection([selected]), targetSha).summary.broken, 1);
  assert.throws(() => projectProductResults(campaign([{ ...missing, status: 'passed' }]), selection([selected]), targetSha));
});

test('original functional and infrastructure failures survive', () => {
  for (const [failureClass, expected] of [['candidate_failure', 'failed'], ['permanent_infrastructure', 'broken'], ['transient_infrastructure', 'broken']]) {
    const projected = projectProductResults(campaign([result({ status: 'failed', failureClass })]), selection([selected]), targetSha);
    assert.equal(projected.records[0].value.status, expected);
  }
  assert.throws(() => projectProductResults(campaign([result(), result()]), selection([selected]), targetSha));
});

test('authoritative normalized accounting preserves earlier failed attempt verdicts beside the selected result', () => {
  const measured = { ...campaign([result({ attempt: 2 })]), accounting: { version: 1, scope: 'retained_attempts',
    missingAttempts: 0, excludedArtifacts: 0, attempts: [
      { id: 'retained-failure', executionId: selected.executionId, attempt: 1, status: 'failed', cleanup: 'passed', durationMs: 1000 },
      { id: 'selected-success', executionId: selected.executionId, attempt: 2, status: 'passed', cleanup: 'passed', durationMs: 1000 },
    ] } };
  const projected = projectProductResults(measured, selection([selected]), targetSha);
  assert.equal(projected.summary.passed, 1);
  assert.equal(projected.records.filter(row => row.file.endsWith('-result.json')).length, 1);
  assert.deepEqual(projected.records[1].value.retainedAttempts.map(row => row.status), ['failed', 'passed']);
  assert.deepEqual(projected.records[1].value.attemptAccounting, { scope: 'retained_attempts', missingAttempts: 0, excludedArtifacts: 0 });
  assert.throws(() => projectProductResults({ ...measured, accounting: { ...measured.accounting, attempts: [{ ...measured.accounting.attempts[0], status: 'unknown' }] } }, selection([selected]), targetSha));
  const openCode = productRegressionCases.find(row => row.id === 54);
  const model = 'openrouter/deepseek/deepseek-v4-flash-0731';
  const record = result({ executionId: openCode.executionId, suiteId: openCode.suite, caseId: openCode.name, profileId: openCode.profile, model });
  const openCodeCampaign = { ...campaign([record]), expected: [openCode.executionId] };
  assert.equal(projectProductResults(openCodeCampaign, selection([openCode]), targetSha).records[1].value.model, model);
});

test('the transmission projection excludes raw errors, provider IDs, narratives and unexpected fields', () => {
  const dirty = result({ error: 'secret-error', runIds: ['private-provider-session'], detail: 'private-context',
    usage: { credential: 'private-token' }, matcherResults: [{ passed: true, detail: 'secret-detail',
      matcher: { kind: 'message_contains', expected: 'fixture-answer-secret', path: 'unsafe narrative with secrets' } }] });
  const text = JSON.stringify(projectProductResults(campaign([dirty]), selection([selected]), targetSha));
  for (const secret of ['secret-error', 'private-provider-session', 'private-context', 'private-token', 'secret-detail', 'fixture-answer-secret', 'unsafe narrative']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('secret-shaped and unknown metadata cannot cross the reporting boundary', () => {
  const sentinel = 'sk-proj-syntheticcredentialabcdefghijklmnop';
  for (const mutation of [{ model: sentinel }, { model: 'gpt-6.1-sol' }, { failureClass: sentinel }, { cleanup: sentinel },
    { matcherResults: [{ passed: true, matcher: { kind: sentinel } }] }]) {
    assert.throws(() => projectProductResults(campaign([result(mutation)]), selection([selected]), targetSha),
      error => error.message === 'product_regression_testops_metadata_invalid');
  }
  const projected = projectProductResults(campaign([result({ matcherResults: [
    { passed: false, matcher: { kind: 'json_path', path: sentinel } },
  ] })]), selection([selected]), targetSha);
  assert.equal(JSON.stringify(projected).includes(sentinel), false);
  assert.equal(projected.summary.passed, 0);
  assert.equal(projected.records[1].value.checks[0].name, 'json_path');
  assert.equal(projected.records[1].value.checks[0].ordinal, 1);
  assert.equal(projected.records[1].value.checks[0].passed, false);
  assert.equal(projected.records[1].value.checks[0].pathSha256, createHash('sha256').update(sentinel).digest('hex'));
});

test('a TestOps job run must belong to this workflow, source launch and GitHub execution', async () => {
  const values = { '/api/jobrun/456': { id: 456, launchId: 789, job: { id: 50, type: 'github' }, url: 'https://github.com/paperclipai/paperclip/actions/runs/123' },
    '/api/job/50': { id: 50, type: 'github', url: workflowUrl }, '/api/launch/789': { id: 789, projectId: 1 } };
  assert.deepEqual(await verifyProductJob(route => values[route], { jobRunId: '456', launchId: 789 }, env), { jobId: 50, launchId: 789 });
  for (const url of workflowUrls) {
    assert.deepEqual(await verifyProductJob(route => route === '/api/job/50' ? { ...values[route], url } : values[route],
      { jobRunId: '456', launchId: 789 }, env), { jobId: 50, launchId: 789 });
  }
  const pending = route => route === '/api/jobrun/456' ? { ...values[route], url: null } : values[route];
  await verifyProductJob(pending, { jobRunId: '456', launchId: 789 }, env, true);
  await assert.rejects(verifyProductJob(pending, { jobRunId: '456', launchId: 789 }, env));
  await assert.rejects(verifyProductJob(route => route === '/api/launch/789' ? { id: 789, projectId: 2 } : values[route], { jobRunId: '456', launchId: 789 }, env));
  await assert.rejects(verifyProductJob(route => route === '/api/job/50' ? { ...values[route], url: 'https://github.com/other/repo' } : values[route], { jobRunId: '456', launchId: 789 }, env));
  await assert.rejects(verifyProductJob(route => route === '/api/job/50' ? { ...values[route], url: workflowUrl.replace('runner-full-stack-e2e', 'runner-protocol-live-evals') } : values[route], { jobRunId: '456', launchId: 789 }, env));
});

test('server verification accepts real Allure string statuses and rejects wrong verdicts or identities', () => {
  const rows = [{ testCaseId: selected.id, fullName: selected.fullName, projectId: 1, launchId: 789, jobRun: { id: 456 }, status: 'passed' }];
  const summary = { passed: 1, failed: 0, broken: 0, cases: [{ caseId: selected.id, status: 'passed' }] };
  validateUploadedProductResults(rows, selection([selected]), summary);
  assert.throws(() => validateUploadedProductResults([{ ...rows[0], status: 'failed' }], selection([selected]), summary));
  assert.throws(() => validateUploadedProductResults([{ ...rows[0], jobRun: { id: 999 } }], selection([selected]), summary));
  const other = productRegressionCases[0];
  const mixed = [rows[0], { ...rows[0], testCaseId: other.id, fullName: other.fullName, status: 'failed' }];
  const expected = { passed: 1, failed: 1, broken: 0, cases: [{ caseId: selected.id, status: 'passed' }, { caseId: other.id, status: 'failed' }] };
  validateUploadedProductResults(mixed, selection([selected, other]), expected);
  assert.throws(() => validateUploadedProductResults([{ ...mixed[0], status: 'failed' }, { ...mixed[1], status: 'passed' }],
    selection([selected, other]), expected), /uploaded_status_mismatch/);
});

test('the separated selection, retained-report projection and server verification preserve one TestOps subset', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'product-testops-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selectionFile = path.join(root, 'selection.json');
  const runtime = { ...env, RUNNER_TEMP: root, GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
    ALLURE_JOB_RUN_ID: '456', ALLURE_TOKEN: 'synthetic-test-token', TESTOPS_CASE: 'all',
    REPORT_DIR: path.join(root, 'report'), ALLURE_RESULTS: path.join(root, 'allure'), EXPORT_SUMMARY: path.join(root, 'export.json') };
  let uploadedStatus = 'passed';
  const fetchImpl = async url => {
    const parsed = new URL(url), route = parsed.pathname;
    const resources = {
      '/api/uaa/oauth/token': { access_token: 'synthetic-access-token' },
      '/api/jobrun/456': { id: 456, launchId: 789, job: { id: 50, type: 'github' }, url: 'https://github.com/paperclipai/paperclip/actions/runs/123' },
      '/api/job/50': { id: 50, type: 'github', url: [...workflowUrls][1] }, '/api/launch/789': { id: 789, projectId: 1 },
      '/api/testresult': { content: [{ id: 501, testCaseId: 66 }], totalPages: 1, totalElements: 1 },
      '/api/testresult/501': { id: 501, testCaseId: 66, fullName: selected.fullName, projectId: 1, launchId: 789, jobRun: { id: 456 }, status: uploadedStatus },
    };
    assert.ok(resources[route], route);
    return new Response(JSON.stringify(resources[route]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const exec = async (command, args) => {
    assert.equal(command, 'allurectl');
    if (args[1] === 'env') return { stdout: 'ALLURE_JOB_RUN_ID=456\nALLURE_LAUNCH_ID=789\n' };
    if (args[1] === 'plan') await writeFile(args.at(-1), JSON.stringify({ version: '1.0', tests: [{ id: '66', selector: selected.fullName }] }));
    return { stdout: '' };
  };
  assert.equal(await productTestOps('select', selectionFile, runtime, exec, fetchImpl), 0);
  const receipt = JSON.parse(await readFile(selectionFile));
  assert.deepEqual(receipt.cases, [selected]);
  runtime.SELECTION_SHA256 = (await readFile(runtime.GITHUB_OUTPUT, 'utf8')).match(/selection_sha256=([a-f0-9]{64})/)[1];
  await mkdir(path.join(runtime.REPORT_DIR, 'normalized'), { recursive: true });
  await writeFile(path.join(runtime.REPORT_DIR, 'normalized', 'normalized-results.json'), JSON.stringify(campaign()));
  assert.equal(await productTestOps('project', selectionFile, runtime, exec, fetchImpl), 0);
  const unsafeRuntime = { ...runtime, ALLURE_RESULTS: path.join(root, 'unsafe-results'), EXPORT_SUMMARY: path.join(root, 'unsafe-export.json') };
  for (const mutation of [{ model: 'sk-proj-syntheticcredentialabcdefghijklmnop' },
    { cleanup: 'sk-proj-syntheticcredentialabcdefghijklmnop' }]) {
    await writeFile(path.join(runtime.REPORT_DIR, 'normalized', 'normalized-results.json'), JSON.stringify(campaign([result(mutation)])));
    await assert.rejects(productTestOps('project', selectionFile, unsafeRuntime, exec, fetchImpl),
      error => error.message === 'product_regression_testops_metadata_invalid');
    await assert.rejects(lstat(unsafeRuntime.ALLURE_RESULTS), { code: 'ENOENT' });
    await assert.rejects(lstat(unsafeRuntime.EXPORT_SUMMARY), { code: 'ENOENT' });
  }
  await writeFile(path.join(runtime.REPORT_DIR, 'normalized', 'normalized-results.json'), JSON.stringify(campaign()));
  assert.equal(await productTestOps('verify', selectionFile, runtime, exec, fetchImpl), 0);
  uploadedStatus = 'unknown';
  let readinessWaits = 0;
  assert.equal(await productTestOps('verify', selectionFile, runtime, exec, fetchImpl, async () => { readinessWaits++; uploadedStatus = 'passed'; }), 0);
  assert.equal(readinessWaits, 1);
  uploadedStatus = 'unknown';
  let virtualMs = 0;
  assert.equal(await productTestOps('verify', selectionFile, runtime, exec, fetchImpl, async ms => {
    virtualMs += ms;
    if (virtualMs >= 40_000) uploadedStatus = 'passed';
  }), 0);
  assert.equal(virtualMs, 40_000);
  const failureOutput = path.join(root, 'failed-selection-output');
  const badPlan = async (command, args) => args[1] === 'plan'
    ? (await writeFile(args.at(-1), JSON.stringify({ version: '1.0', tests: [{ id: '999', selector: selected.fullName }] })), { stdout: '' })
    : exec(command, args);
  await assert.rejects(productTestOps('select', path.join(root, 'failed-selection.json'), { ...runtime, GITHUB_OUTPUT: failureOutput }, badPlan, fetchImpl), /case_mismatch/);
  const cleanupContext = await readFile(failureOutput, 'utf8');
  assert.match(cleanupContext, /job_run_started=true/);
  assert.match(cleanupContext, /job_run_id=456/);
  let opened = false;
  await assert.rejects(productTestOps('select', path.join(root, 'invalid-manual.json'),
    { ...runtime, ALLURE_JOB_RUN_ID: '', TESTOPS_CASE: 'unknown' }, async () => { opened = true; }, fetchImpl), /manual_selection_invalid/);
  assert.equal(opened, false);
  uploadedStatus = 'failed';
  let deadlineMs = 0;
  await assert.rejects(productTestOps('verify', selectionFile, runtime, exec, fetchImpl,
    async ms => { deadlineMs += ms; }), /uploaded_status_mismatch/);
  assert.equal(deadlineMs, 55_000);
  await writeFile(selectionFile, JSON.stringify({ ...receipt, targetSha: workflowSha }));
  await assert.rejects(productTestOps('project', selectionFile, runtime, exec, fetchImpl), /selection_hash/);
});

test('workflow keeps reporting credentials and trusted code outside candidate/provider jobs', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/runner-full-stack-e2e.yml', import.meta.url), 'utf8');
  const selectionJob = workflow.split('  testops_selection:\n')[1].split('\n  catalog:\n')[0];
  const reportingJob = workflow.split('  publish_testops:\n')[1].split('\n  publish_history:\n')[0];
  for (const block of [selectionJob, reportingJob]) {
    assert.match(block, /environment: runner-e2e-testops-reporting/);
    assert.match(block, /ref: \$\{\{ github.sha \}\}/);
    assert.doesNotMatch(block, /secrets\.(OPENAI|OPENROUTER|ANTHROPIC)|ref: \$\{\{ needs.authorize.outputs.target_sha/);
  }
  assert.match(workflow, /SELECT_ID: \$\{\{ needs.testops_selection.outputs.ids \|\| inputs.id \}\}/);
  assert.match(reportingJob.split('    steps:\n')[0], /if: always\(\) && needs.testops_selection.outputs.job_run_started == 'true'/);
  assert.doesNotMatch(reportingJob.split('    steps:\n')[0], /!cancelled\(\)/);
  assert.match(reportingJob, /Finish the original TestOps job run\n\s+if: always\(\)/);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\njobs:')), /workflow_call:/);
});
