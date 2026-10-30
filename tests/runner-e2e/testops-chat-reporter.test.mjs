import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifySelectionFile, reporter } from './testops-chat-reporter.mjs';
import { executionId, scenario, fullName } from './chat-feature-testops-api.mjs';
const context = { GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_REF: 'refs/heads/master', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', ALLURE_JOB_RUN_ID: '9',
  GITHUB_WORKFLOW_REF: 'paperclipai/paperclip/.github/workflows/chat-feature-testops.yml@refs/heads/master' };
async function fixture(t, change = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'testops-selection-')));
  t.after(() => rm(root, { recursive: true }));
  const value = { schema: 'paperclip.chat-feature-testops-selection/v1', runId: '123', attempt: '1', workflowSha: 'a'.repeat(40), targetSha: 'a'.repeat(40),
    allureJobRunId: '9', executionId, canonicalScenario: scenario, projectId: 1, planId: 8, jobId: 7, caseId: 91, fullName, launchId: 10, ...change };
  const bytes = Buffer.from(JSON.stringify(value));
  await mkdir(path.join(root, 'chat-testops-selection'));
  const file = path.join(root, 'chat-testops-selection', 'testops-selection.json'); await writeFile(file, bytes);
  return { file, env: { ...context, GITHUB_WORKSPACE: root, EXPECTED_SELECTION_SHA256: createHash('sha256').update(bytes).digest('hex') } };
}

test('actual worker verifier requires no token or network and accepts exact source-bound selection hash', async t => {
  const f = await fixture(t);
  assert.equal((await verifySelectionFile(f.file, f.env)).caseId, 91);
  assert.equal(await reporter('verify-selection', f.file, f.env), 0);
});

test('worker verifier rejects token contamination, hash mismatch and correctly-hashed foreign tuples', async t => {
  const f = await fixture(t);
  await assert.rejects(reporter('verify-selection', f.file, { ...f.env, ALLURE_TOKEN: 'SYNTHETIC_TOKEN' }));
  await assert.rejects(verifySelectionFile(f.file, { ...f.env, EXPECTED_SELECTION_SHA256: '0'.repeat(64) }));
  for (const change of [{ runId: '456' }, { targetSha: 'b'.repeat(40) }, { allureJobRunId: '10' }, { executionId: 'other' }, { projectId: 2 }]) {
    const foreign = await fixture(t, change);
    await assert.rejects(verifySelectionFile(foreign.file, foreign.env));
  }
});

test('actual upload facade copies authenticated workspace bytes to owned temp before successful synthetic export', async t => {
  const f = await fixture(t), workspace = f.env.GITHUB_WORKSPACE;
  const temporary = path.join(workspace, 'temp'); await mkdir(temporary);
  const root = path.join(workspace, 'safe-export'); await mkdir(root);
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const shot = { id: 'final-state', file: 'final-state.png', sha256: hash(png) };
  const result = { executionId, suiteId: 'chat-features', caseId: 'create-backlog', profileId: 'runner-opencode-deepseek-1017', provider: 'opencode',
    environmentId: 'local', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017', runtimeMode: 'native', attempt: 1,
    source: { sha: context.GITHUB_SHA }, status: 'passed', cleanup: 'passed', runIds: ['synthetic'], durationMs: 123,
    matcherResults: [{ matcher: { kind: 'json_path', path: 'chatFeature.createdTask', expected: true }, passed: true }], screenshots: [shot] };
  const files = new Map([['normalized-results.json', Buffer.from(JSON.stringify({ schema: 'paperclip.runner-e2e.campaign/v2', campaignId: 'gha-123-1', results: [result] }))],
    ['junit.xml', Buffer.from('<testsuite tests="1"/>')], [`evidence/${executionId}/attempt-1/final-state.png`, png]]);
  for (const [name, bytes] of files) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); }
  await writeFile(path.join(root, 'binding.json'), JSON.stringify({ schema: 'paperclip.chat-feature-testops-export/v1', runId: '123', attempt: '1',
    workflowSha: context.GITHUB_SHA, targetSha: context.GITHUB_SHA, executionId, campaignId: 'gha-123-1', resultStatus: 'passed', cleanup: 'passed',
    files: [...files].map(([name, bytes]) => ({ path: name, sha256: hash(bytes), bytes: bytes.length })) }));
  assert.equal(await reporter('upload', root, { ...f.env, RUNNER_TEMP: temporary }), 0);
  assert.deepEqual(await readFile(path.join(temporary, 'chat-testops-authenticated-selection.json')), await readFile(f.file));
  const exported = JSON.parse(await readFile(path.join(temporary, 'chat-testops-upload-state', 'export.json')));
  const jobRun = { id: 9, job: { id: 7, type: 'github' }, launchId: 10, stage: 'finished', url: 'https://github.com/paperclipai/paperclip/actions/runs/123' };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url), route = parsed.pathname;
    let value;
    if (route === '/api/uaa/oauth/token') { assert.equal(options.method, 'POST'); value = { access_token: 'MOCK_ACCESS_TOKEN' }; }
    else {
      assert.equal(options.method, 'GET');
      if (route === '/api/jobrun/9') value = jobRun;
      else if (route === '/api/launch/10') value = { id: 10, projectId: 1 };
      else if (route === '/api/testresult') value = { content: [{ id: 45, testCaseId: 91 }], totalElements: 1, totalPages: 1 };
      else if (route === '/api/testresult/45') value = { id: 45, projectId: 1, launchId: 10, testCaseId: 91, fullName, jobRun, status: 'passed',
        links: [{ url: jobRun.url }, { url: `https://github.com/paperclipai/paperclip/commit/${context.GITHUB_SHA}` }] };
      else if (route === '/api/testresult/attachment') value = { content: exported.attachmentMetadata.map((row, i) => ({ ...row, id: i + 1 })), totalElements: exported.attachmentMetadata.length, totalPages: 1 };
      else assert.fail(route);
    }
    return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
  };
  assert.equal(await reporter('verify-upload', root, { ...f.env, RUNNER_TEMP: temporary, ALLURE_TOKEN: 'MOCK_API_TOKEN' }, fetchImpl), 0);
  const verified = JSON.parse(await readFile(path.join(temporary, 'chat-testops-verify-upload-state', 'verification.json')));
  assert.equal(verified.verification, 'VERIFIED'); assert.equal(verified.caseId, 91); assert.equal(verified.status, 'passed');

});

test('actual launch-plan facade performs metadata-only plan launch once and exits without waiting for child', async t => {
  const f = await fixture(t), workspace = f.env.GITHUB_WORKSPACE;
  const temporary = path.join(workspace, 'temp'); await mkdir(temporary);
  const eventPath = path.join(workspace, 'event.json'); await writeFile(eventPath, JSON.stringify({ inputs: { operation: 'launch-plan', ALLURE_JOB_RUN_ID: '' } }));
  const nonce = '1'.repeat(32), calls = [];
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname, method = options.method; calls.push({ route, method });
    const response = value => ({ ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) });
    if (route === '/repos/paperclipai/paperclip') return response({ full_name: 'paperclipai/paperclip', private: false, default_branch: 'master' });
    if (route === '/repos/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml') return response({ id: 99, path: '.github/workflows/chat-feature-testops.yml', state: 'active' });
    if (route === '/repos/paperclipai/paperclip/actions/runs/123') return response({ id: 123, workflow_id: 99, run_attempt: 1, run_number: 2, head_sha: context.GITHUB_SHA, head_branch: 'master', event: 'workflow_dispatch', repository: { full_name: 'paperclipai/paperclip', private: false, default_branch: 'master' }, actor: { id: 34892728 }, triggering_actor: { id: 34892728 } });
    if (route === '/api/uaa/oauth/token') return response({ access_token: 'SYNTHETIC_TOKEN' });
    if (route === '/api/testcase/91') return response({ id: 91, projectId: 1, fullName, automated: true });
    if (route === '/api/testplan/8') return response({ id: 8, projectId: 1, name: 'Chat feature evals', testCasesCount: 1, treeSelection: { leafsInclude: [91] } });
    if (route === '/api/job/7') return response({ id: 7, type: 'github', url: 'https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml', parameters: [{ id: 17, value: 'evaluate' }] });
    if (route === '/api/integration/2/project/1') return response({ id: 2, projectId: 1, info: { type: 'github' }, disabled: false });
    if (route === '/api/environment/17') return response({ id: 17, name: 'operation' });
    if (route === '/api/testplan/8/job') return response([{ job: { id: 7, parameters: [{ id: 17, value: 'evaluate' }] }, testCasesCount: 1 }]);
    if (route === '/api/launch') return response({ content: [], totalPages: 0 });
    if (route === '/api/testplan/8/jobparameter') return { ok: true, status: 204 };
    assert.equal(route, '/api/testplan/8/run');
    return response({ id: 20, projectId: 1, name: `Chat feature evals · ${nonce}` });
  };
  assert.equal(await reporter('launch-plan', undefined, { ...f.env, RUNNER_TEMP: temporary, GITHUB_EVENT_PATH: eventPath,
    ALLURE_JOB_RUN_ID: '', ALLURE_TOKEN: 'SYNTHETIC_ONLY', CHAT_TESTOPS_CASE_ID: '91', CHAT_TESTOPS_PLAN_ID: '8', CHAT_TESTOPS_JOB_ID: '7',
    CHAT_TESTOPS_OPERATION_PARAMETER_ID: '17', CHAT_TESTOPS_INTEGRATION_ID: '2', CHAT_TESTOPS_LAUNCH_NONCE: nonce, CHAT_TESTOPS_LAUNCH_RUN_NUMBER: '2', GITHUB_RUN_NUMBER: '2',
    CHAT_TESTOPS_GITHUB_WORKFLOW_ID: '99', GITHUB_ACTOR_ID: '34892728', TESTOPS_TRIGGERING_ACTOR_ID: '34892728', TESTOPS_ALLOWED_ACTOR_IDS: '[34892728]', GH_TOKEN: 'SYNTHETIC_GH_TOKEN' }, fetchImpl), 0);
  const state = path.join(temporary, 'chat-testops-launch-plan-state');
  assert.equal(JSON.parse(await readFile(path.join(state, 'launch.json'))).status, 'REQUESTED');
  assert.equal(calls.filter(row => row.route === '/api/testplan/8/run').length, 1);
  assert.equal(calls.at(-1).route, '/api/testplan/8/run');
});

test('actual launch caller rejects five own-run contradictions before TestOps auth or mutation', async t => {
  const original = process.stderr.write; process.stderr.write = () => true;
  try {
    for (const changes of [{ run_number: 3 }, { actor: { id: 1 } }, { head_sha: 'b'.repeat(40) }, { workflow_id: 100 }, { run_attempt: 2 }]) {
      const f = await fixture(t), workspace = f.env.GITHUB_WORKSPACE;
      const temporary = path.join(workspace, 'temp'); await mkdir(temporary);
      const eventPath = path.join(workspace, 'event.json'); await writeFile(eventPath, JSON.stringify({ inputs: { operation: 'launch-plan' } }));
      let testopsCalls = 0;
      const fetchImpl = async url => {
        if (new URL(url).hostname !== 'api.github.com') { testopsCalls++; throw new Error('must not reach TestOps'); }
        const value = url.endsWith('/repos/paperclipai/paperclip') ? { full_name: 'paperclipai/paperclip', private: false, default_branch: 'master' } : url.includes('/actions/workflows/') ? { id: 99, path: '.github/workflows/chat-feature-testops.yml', state: 'active' }
          : { id: 123, workflow_id: 99, run_attempt: 1, run_number: 2, head_sha: context.GITHUB_SHA, head_branch: 'master', event: 'workflow_dispatch',
            repository: { full_name: 'paperclipai/paperclip', private: false, default_branch: 'master' }, actor: { id: 34892728 }, triggering_actor: { id: 34892728 }, ...changes };
        return { ok: true, text: async () => JSON.stringify(value) };
      };
      assert.equal(await reporter('launch-plan', undefined, { ...f.env, RUNNER_TEMP: temporary, GITHUB_EVENT_PATH: eventPath,
        ALLURE_JOB_RUN_ID: '', ALLURE_TOKEN: 'SYNTHETIC_ONLY', CHAT_TESTOPS_LAUNCH_RUN_NUMBER: '2', GITHUB_RUN_NUMBER: '2',
        CHAT_TESTOPS_GITHUB_WORKFLOW_ID: '99', GITHUB_ACTOR_ID: '34892728', TESTOPS_TRIGGERING_ACTOR_ID: '34892728', TESTOPS_ALLOWED_ACTOR_IDS: '[34892728]', GH_TOKEN: 'SYNTHETIC_GH_TOKEN' }, fetchImpl), 1);
      assert.equal(testopsCalls, 0);
      const error = JSON.parse(await readFile(path.join(temporary, 'chat-testops-launch-plan-state', 'failure.json')));
      assert.equal(error.stage, 'launch_admission'); assert.equal(error.code, 'chat_testops_launch_admission');
    }
  } finally { process.stderr.write = original; }
});
