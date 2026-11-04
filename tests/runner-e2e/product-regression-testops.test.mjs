import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { productRegressionCases, selectProductRegression, validateSelection, projectProductResults, workflowUrl } from './product-regression-testops.mjs';
import { admitProductTestOps, officialProductContext, verifyProductJob } from './product-regression-testops-cli.mjs';

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
  status: 'passed', cleanup: 'passed', model: 'gpt-6.1-sol', suiteDefinitionHash: 'c'.repeat(64),
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
  assert.deepEqual(projected.summary, { selected: 20, passed: 0, failed: 0, broken: 20, fullPlan: true });
  assert.equal(projected.records.filter(row => row.file.endsWith('-result.json')).length, 20);
  const partial = projectProductResults(campaign([]), selection([selected]), targetSha);
  assert.equal(partial.summary.broken, 1);
  assert.equal(partial.summary.fullPlan, false);
  const missing = result({ attempt: 0, status: 'failed', failureClass: 'permanent_infrastructure', cleanup: 'not_started',
    error: 'No result artifact was uploaded', matcherResults: undefined, source: undefined });
  assert.equal(projectProductResults(campaign([missing]), selection([selected]), targetSha).summary.broken, 1);
  assert.throws(() => projectProductResults(campaign([{ ...missing, status: 'passed' }]), selection([selected]), targetSha));
});

test('original functional and infrastructure failures survive, and earlier failed retries remain in the export', () => {
  for (const [failureClass, expected] of [['candidate_failure', 'failed'], ['permanent_infrastructure', 'broken'], ['transient_infrastructure', 'broken']]) {
    const projected = projectProductResults(campaign([result({ status: 'failed', failureClass })]), selection([selected]), targetSha);
    assert.equal(projected.records[0].value.status, expected);
  }
  const projected = projectProductResults(campaign([result({ status: 'failed', failureClass: 'candidate_failure' }), result({ attempt: 2 })]), selection([selected]), targetSha);
  assert.deepEqual(projected.records.filter(row => row.file.endsWith('-result.json')).map(row => row.value.status), ['failed', 'passed']);
  assert.equal(projected.summary.passed, 1);
  assert.throws(() => projectProductResults(campaign([result(), result()]), selection([selected]), targetSha));
});

test('the transmission projection excludes raw errors, provider IDs, narratives and unexpected fields', () => {
  const dirty = result({ error: 'secret-error', runIds: ['private-provider-session'], detail: 'private-context',
    usage: { credential: 'private-token' }, matcherResults: [{ passed: true, detail: 'secret-detail',
      matcher: { kind: 'contains', expected: 'fixture-answer-secret', path: 'unsafe narrative with secrets' } }] });
  const text = JSON.stringify(projectProductResults(campaign([dirty]), selection([selected]), targetSha));
  for (const secret of ['secret-error', 'private-provider-session', 'private-context', 'private-token', 'secret-detail', 'fixture-answer-secret', 'unsafe narrative']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('a TestOps job run must belong to this workflow, source launch and GitHub execution', async () => {
  const values = { '/api/jobrun/456': { id: 456, launchId: 789, job: { id: 50, type: 'github' }, url: 'https://github.com/paperclipai/paperclip/actions/runs/123' },
    '/api/job/50': { id: 50, type: 'github', url: workflowUrl }, '/api/launch/789': { id: 789, projectId: 1 } };
  assert.deepEqual(await verifyProductJob(route => values[route], { jobRunId: '456', launchId: 789 }, env), { jobId: 50, launchId: 789 });
  await assert.rejects(verifyProductJob(route => route === '/api/launch/789' ? { id: 789, projectId: 2 } : values[route], { jobRunId: '456', launchId: 789 }, env));
  await assert.rejects(verifyProductJob(route => route === '/api/job/50' ? { ...values[route], url: 'https://github.com/other/repo' } : values[route], { jobRunId: '456', launchId: 789 }, env));
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
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf('\njobs:')), /workflow_call:/);
});
