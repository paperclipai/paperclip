import test from 'node:test';
import assert from 'node:assert/strict';
import { fullCatalogCases, fullCatalogPlanName, catalogTargetSha } from './chat-full-catalog-testops-manifest.mjs';
import { admitDispatch, validateSelection, evidencePolicy, catalogWorkflow, catalogDefinition } from './chat-completion-testops-contract.mjs';
import { bindingFromEnv, validatePilotSelection, verifyPilotUpload, completePilotRegistration } from './chat-completion-testops-api.mjs';
import { executionMatrix, executionPartition, run } from './chat-completion-testops-cli.mjs';
import { mkdtemp, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const context = { catalog: 'full', runId: '123', attempt: '1', workflowSha: 'a'.repeat(40), targetSha: catalogTargetSha };
const runUrl = 'https://github.com/paperclipai/paperclip/actions/runs/123';
const selected = fullCatalogCases.map((row, index) => ({ ...row, caseId: row.key === 'tasks.create-backlog' ? 388 : 1000 + index,
  registeredFullName: row.aliases[0] ?? row.fullName }));
const compact = row => ({ key: row.key, caseId: row.caseId, registeredFullName: row.registeredFullName });
const binding = { planId: 10, jobId: 11, integrationId: 1, cases: selected.map(compact) };
const selection = { schema: 'paperclip.chat-completion-testops-selection/v1', ...context,
  projectId: 1, planId: 10, jobId: 11, launchId: 12, allureJobRunId: '77', cases: selected };
const env = { CHAT_FULL_CATALOG_TESTOPS_BINDING: JSON.stringify(binding), ALLURE_JOB_RUN_ID: '77' };
const attachments = [
  { name: 'Execution provenance and checks', contentType: 'application/json', contentLength: 100 },
  { name: 'Private evidence receipt', contentType: 'application/json', contentLength: 200 },
];
const exported = selected.map(row => ({ executionId: row.executionId, caseId: row.caseId, status: 'passed', cleanup: 'passed', attachments }));
function api(replace = {}) {
  const calls = [];
  const get = async route => {
    calls.push(route);
    if (Object.hasOwn(replace, route)) return structuredClone(replace[route]);
    let match;
    if ((match = route.match(/^\/api\/testcase\/(\d+)$/))) {
      const row = selected.find(value => value.caseId === Number(match[1]));
      return { id: row.caseId, projectId: 1, fullName: row.registeredFullName, automated: true };
    }
    if (route === '/api/testplan/10') return { id: 10, projectId: 1, name: fullCatalogPlanName,
      testCasesCount: 244, treeSelection: { inverted: false, leafsInclude: selected.map(row => row.caseId) } };
    if (route === '/api/testplan/10/job') return [{ job: { id: 11 }, testCasesCount: 244 }];
    if (route === '/api/job/11') return { id: 11, type: 'github', url: 'https://github.com/paperclipai/paperclip/actions/workflows/chat-catalog-testops.yml',
      parameters: [{ id: 34, name: 'Branch', defaultValue: 'refs/heads/master' }] };
    if (route === '/api/jobrun/77') return { id: 77, job: { id: 11, type: 'github' }, stage: 'in_progress', launchId: 12, url: runUrl };
    if (route === '/api/launch/12') return { id: 12, projectId: 1, closed: false };
    if (route === '/api/jobrun/77/plan?expected=true') return selected.map(row => ({ id: row.caseId, selector: row.registeredFullName }));
    if ((match = route.match(/^\/api\/testresult\?launchId=12&page=(\d)&size=100$/))) {
      const index = Number(match[1]);
      return { content: selected.slice(index * 100, (index + 1) * 100).map((row, offset) => ({ id: 2000 + index * 100 + offset, testCaseId: row.caseId })),
        totalElements: 244, totalPages: 3, number: index };
    }
    if ((match = route.match(/^\/api\/testresult\/(\d+)$/))) {
      const id = Number(match[1]), row = selected[id - 2000];
      return { id, projectId: 1, launchId: 12, testCaseId: row.caseId, fullName: row.registeredFullName,
        jobRun: { id: 77, launchId: 12, url: runUrl }, links: [], status: 'passed' };
    }
    if (route.startsWith('/api/testresult/attachment?')) return { content: attachments.map((row, index) => ({ ...row, id: 3000 + index,
      missed: false, fromTestCase: false })), totalElements: 2, totalPages: 1 };
    throw new Error(`Unexpected route ${route}`);
  };
  return { get, calls };
}

test('the complete 244 mapping uses compact actual IDs and preserves the legacy case388 alias', async () => {
  assert.ok(Buffer.byteLength(env.CHAT_FULL_CATALOG_TESTOPS_BINDING) < 48_000);
  assert.equal(bindingFromEnv(env, context).cases.length, 244);
  const f = api(), value = await validatePilotSelection(f.get, env, context, 99);
  assert.equal(validateSelection(value, context, '77').length, 244);
  assert.equal(value.cases.find(row => row.caseId === 388).registeredFullName, 'paperclip.Product E2E.chat-features.create-backlog');
  assert.equal(value.targetSha, catalogTargetSha);
});

test('the actual full registration receipt fits one protected variable without a later source change', async () => {
  const prepared = { planId: 10, integrationId: 1, cases: selected.map(row => Object.fromEntries(
    ['key', 'scenario', 'executionId', 'fullName', 'registeredFullName', 'caseId'].map(key => [key, row[key]]))) };
  const f = api();
  const receipt = await completePilotRegistration(f.get, prepared, { jobRunId: '77', launchId: 12 }, context, 99, async () => {});
  assert.ok(Buffer.byteLength(JSON.stringify(receipt.binding)) < 48_000);
  assert.equal(bindingFromEnv({ CHAT_FULL_CATALOG_TESTOPS_BINDING: JSON.stringify(receipt.binding) }, context).cases.length, 244);
  assert.equal(receipt.binding.cases.find(row => row.caseId === 388).registeredFullName, 'paperclip.Product E2E.chat-features.create-backlog');
});

test('every case has a singleton private approval instead of broadening the original eight-cell authority', () => {
  const matrix = executionMatrix(selection, context, '77');
  assert.equal(matrix.include.length, 244);
  for (const row of selected) {
    const policy = evidencePolicy({ ...selection, cases: [row] }, context, '77');
    assert.deepEqual(policy.approvals[0].executionIds, [row.executionId]);
    assert.equal(policy.approvals[0].targetSha, catalogTargetSha);
    const cell = matrix.include.find(value => value.executionId === row.executionId);
    assert.deepEqual(JSON.parse(cell.private_ids), [row.executionId]);
    assert.deepEqual(JSON.parse(cell.private_policy), policy);
    assert.deepEqual(cell.required_credentials, row.requiredCredentials);
  }
});

test('full catalog source admission is independent from the old three-case workflow', () => {
  const event = { repository: { full_name: 'paperclipai/paperclip', private: false, default_branch: 'master' }, ref: 'refs/heads/master',
    sender: { id: 42 }, inputs: { operation: 'evaluate', ALLURE_JOB_RUN_ID: '77' } };
  const dispatchEnv = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: event.repository.full_name,
    GITHUB_REF: event.ref, GITHUB_WORKFLOW_REF: `paperclipai/paperclip/${catalogWorkflow}@refs/heads/master`, GITHUB_SHA: context.workflowSha,
    GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_ACTOR_ID: '42', TESTOPS_ALLOWED_ACTOR_IDS: '[42]' };
  assert.equal(admitDispatch(dispatchEnv, event, 42).targetSha, catalogTargetSha);
  assert.equal(catalogDefinition({}).cases.length, 3);
  assert.throws(() => admitDispatch({ ...dispatchEnv, GITHUB_RUN_ATTEMPT: '2' }, event, 42), /dispatch/);
  assert.throws(() => admitDispatch(dispatchEnv, { ...event, inputs: { operation: 'launch-plan' } }, 42), /dispatch/);
  assert.throws(() => validateSelection({ ...selection, targetSha: 'b'.repeat(40) }, context, '77'), /selection_binding/);
});

test('native and external partitions preserve exact selections, serial small runs and the GitHub output bound', () => {
  for (const rows of [selected, selected.slice(0, 3), selected.filter(row => row.externalInput), [selected[0], selected.find(row => row.externalInput)]]) {
    const input = { ...selection, cases: rows }, partition = executionPartition(input, context, '77');
    const merged = [...partition.native.include, ...partition.external.include].map(row => row.executionId);
    assert.equal(new Set(merged).size, rows.length);
    assert.deepEqual(merged.sort(), rows.map(row => row.executionId).sort());
    if (rows.length <= 3) {
      assert.equal(partition.parallelism, '1'); assert.equal(partition.external.include.length, 0);
    } else {
      assert.equal(partition.parallelism, '8'); assert.ok(partition.external.include.every(row => row.external));
    }
    assert.ok([partition.matrix, partition.native, partition.external, rows.map(row => row.executionId)]
      .reduce((sum, value) => sum + JSON.stringify(value).length * 2, 0) < 1_000_000);
    for (const cell of merged) assert.ok(partition.matrix.include.find(row => row.executionId === cell).timeout_minutes <= 45);
  }
});

test('full server readback verifies every result across three complete pages', async () => {
  const f = api();
  const value = await verifyPilotUpload(f.get, selection, context, exported);
  assert.equal(value.verification, 'VERIFIED'); assert.equal(value.results.length, 244);
  assert.ok(f.calls.includes('/api/testresult?launchId=12&page=2&size=100'));
});

test('a full ready snapshot fits its read budget while a late snapshot still fails closed', async t => {
  async function replay(latency) {
    let clock = 0, outcome; const pending = [], f = api();
    const verification = verifyPilotUpload(route => new Promise((resolve, reject) => {
      pending.push({ at: clock + latency, complete: () => { f.get(route).then(resolve, reject); } });
    }), selection, context, exported, { now: () => clock });
    verification.then(value => { outcome = { value }; }, error => { outcome = { error }; });
    for (let tick = 0; tick < 600 && !outcome; tick++) {
      await new Promise(resolve => setImmediate(resolve));
      if (outcome) break;
      assert.ok(pending.length > 0, 'the controlled response chain must make progress');
      clock = Math.min(...pending.map(row => row.at));
      const ready = pending.filter(row => row.at <= clock);
      for (const row of ready) { pending.splice(pending.indexOf(row), 1); row.complete(); }
    }
    assert.ok(outcome, 'bounded controlled snapshot replay must settle');
    return { ...outcome, clock };
  }
  const ready = await replay(1000);
  assert.ifError(ready.error);
  assert.equal(ready.value.verification, 'VERIFIED'); assert.equal(ready.value.results.length, 244);
  assert.ok(ready.clock > 120_000);
  const late = await replay(3000);
  assert.match(late.error?.message ?? '', /upload_unverified/);
  t.diagnostic(JSON.stringify({ fixtureOnly: true, selectedCases: 244, readyElapsedMs: ready.clock, lateElapsedMs: late.clock }));
});

test('an incomplete last page and a wrong registered selector cannot qualify a full catalog run', async () => {
  const missing = api({ '/api/testresult?launchId=12&page=2&size=100': { content: [], totalElements: 244, totalPages: 3, number: 2 } });
  await assert.rejects(verifyPilotUpload(missing.get, selection, context, exported), /result_page/);
  const wrong = api({ '/api/jobrun/77/plan?expected=true': [{ id: 388, selector: fullCatalogCases[0].fullName }] });
  await assert.rejects(validatePilotSelection(wrong.get, env, context, 99), /foreign_selection/);
});

test('the real bootstrap facade preserves fixed reconciliation failures and discards unknown lookalike messages', async t => {
  for (const unknown of [false, true]) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'catalog-bootstrap-failure-')));
    let stderr = ''; const capture = t.mock.method(process.stderr, 'write', value => { stderr += value; return true; });
    try {
      const event = { repository: { full_name: 'paperclipai/paperclip', private: false, default_branch: 'master' },
        ref: 'refs/heads/master', sender: { id: 42 }, inputs: { operation: 'bootstrap' } };
      const eventPath = path.join(root, 'event.json'); await writeFile(eventPath, JSON.stringify(event));
      const runtime = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: event.repository.full_name,
        GITHUB_REF: event.ref, GITHUB_WORKFLOW_REF: `paperclipai/paperclip/${catalogWorkflow}@refs/heads/master`, GITHUB_SHA: context.workflowSha,
        GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_ACTOR_ID: '42', TESTOPS_ALLOWED_ACTOR_IDS: '[42]', GITHUB_RUN_NUMBER: '1',
        GITHUB_EVENT_PATH: eventPath, GH_TOKEN: 'SYNTHETIC_GITHUB_SECRET', ALLURE_TOKEN: 'SYNTHETIC_REPORTING_SECRET',
        RUNNER_TEMP: root, GITHUB_WORKSPACE: root, CHAT_TESTOPS_INTEGRATION_ID: '1' };
      const exec = async () => ({ stdout: JSON.stringify({ id: 123, run_attempt: 1, run_number: 1, workflow_id: 99,
        head_sha: context.workflowSha, head_branch: 'master', event: 'workflow_dispatch', path: catalogWorkflow,
        repository: event.repository, actor: { id: 42 }, triggering_actor: { id: 42 } }) });
      const fetchImpl = async (url, options) => {
        if (unknown) throw new Error('chat_full_catalog_testops_catalog_page_private_body');
        if (url.endsWith('/api/uaa/oauth/token')) return Response.json({ access_token: 'SYNTHETIC_BEARER_SECRET' });
        assert.equal(options.method, 'GET');
        if (url.endsWith('/api/integration/1/project/1')) return Response.json({ id: 1, projectId: 1, info: { type: 'github' }, disabled: false });
        assert.ok(url.includes('/api/testcase?'));
        return Response.json({ content: [], number: 0, totalPages: 2, totalElements: 0, private: 'SYNTHETIC_PRIVATE_BODY' });
      };
      assert.equal(await run('bootstrap', undefined, runtime, { exec, fetchImpl }), 1);
      const state = path.join(root, 'chat-completion-testops-bootstrap');
      const failure = JSON.parse(await readFile(path.join(state, 'failure.json'), 'utf8'));
      assert.equal(failure.code, unknown ? 'chat_completion_testops_unknown' : 'chat_full_catalog_testops_catalog_page');
      assert.deepEqual(await readdir(state), ['failure.json']);
      assert.doesNotMatch(stderr + JSON.stringify(failure), /SYNTHETIC_|PRIVATE_BODY|catalog_page_private_body/);
    } finally { capture.mock.restore(); await rm(root, { recursive: true, force: true }); }
  }
});
