import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifySelectionFile, reporter, parseOfficialBootstrapContext } from './testops-chat-reporter.mjs';
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

async function bootstrapContextFixture(t, inputs = { operation: 'bootstrap', ALLURE_JOB_RUN_ID: '' }) {
  const f = await fixture(t), workspace = f.env.GITHUB_WORKSPACE;
  const temporary = path.join(workspace, 'temp'); await mkdir(temporary);
  const state = path.join(temporary, 'chat-testops-bootstrap-state'); await mkdir(state, { mode: 0o700 });
  const originalJob = Buffer.from('{"status":"official_job_run_id_missing","actualResult":null}');
  await writeFile(path.join(state, 'job.json'), originalJob, { mode: 0o600 });
  const event = path.join(workspace, 'event.json'); await writeFile(event, JSON.stringify({ inputs }));
  return { ...f, state, originalJob, env: { ...f.env, RUNNER_TEMP: temporary, GITHUB_EVENT_PATH: event, ALLURE_JOB_RUN_ID: '',
    ALLURE_ENDPOINT: 'https://paperclip.testops.cloud', ALLURE_PROJECT_ID: '1', ALLURE_TOKEN: 'SYNTHETIC_REPORTER_TOKEN', CHAT_TESTOPS_GITHUB_WORKFLOW_ID: '99' } };
}
function bootstrapContextFetch(change = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const route = new URL(url).pathname; calls.push({ route, method: options.method });
    let value;
    if (route === '/api/uaa/oauth/token') { assert.equal(options.method, 'POST'); value = { access_token: 'SYNTHETIC_ACCESS' }; }
    else {
      assert.equal(options.method, 'GET');
      if (route === '/api/jobrun/9') value = { id: 9, job: { id: 7, type: 'github' }, launchId: 10,
        url: 'https://github.com/paperclipai/paperclip/actions/runs/123', ...change };
      else if (route === '/api/launch/10') value = { id: 10, projectId: 1 };
      else if (route === '/api/job/7') value = { id: 7, type: 'github', url: 'https://github.com/paperclipai/paperclip/actions/workflows/99',
        parameters: [{ id: 17, value: 'bootstrap' }] };
      else if (route === '/api/environment/17') value = { id: 17, name: 'operation' };
      else assert.fail(route);
    }
    return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
  };
  return { fetchImpl, calls };
}
async function captureSafeErrors(callback) {
  const original = process.stderr.write;
  let text = '';
  process.stderr.write = chunk => { text += String(chunk); return true; };
  try { return { value: await callback(), text }; } finally { process.stderr.write = original; }
}

test('official context parser admits only unique positive numeric job-run and launch assignments', () => {
  const text = 'ALLURE_TOKEN=SYNTHETIC_SECRET\nALLURE_JOB_RUN_URL=untrusted\nALLURE_JOB_RUN_ID=9\r\nALLURE_LAUNCH_ID=10\n';
  assert.deepEqual(parseOfficialBootstrapContext(text), { jobRunId: '9', launchId: 10 });
  for (const text of ['', 'ALLURE_JOB_RUN_ID=9\n', 'ALLURE_JOB_RUN_ID=0\nALLURE_LAUNCH_ID=10',
    'ALLURE_JOB_RUN_ID=9\nALLURE_LAUNCH_ID=10\nALLURE_JOB_RUN_ID=9', 'ALLURE_JOB_RUN_ID=9\nALLURE_LAUNCH_ID=$(secret)',
    'ALLURE_JOB_RUN_ID=9007199254740992\nALLURE_LAUNCH_ID=10', 'ALLURE_JOB_RUN_ID=9; secret\nALLURE_LAUNCH_ID=10', 'x'.repeat(16_385)]) {
    assert.throws(() => parseOfficialBootstrapContext(text), /chat_testops_bootstrap_context_invalid/);
  }
});

test('post-watch facade runs exact official command with bounded pipes and preserves original missing-child artifact', async t => {
  const f = await bootstrapContextFixture(t), server = bootstrapContextFetch(); let executions = 0;
  const execImpl = async (command, args, options) => {
    executions++; assert.equal(command, 'allurectl'); assert.deepEqual(args, ['job-run', 'env']);
    assert.equal(options.shell, false); assert.equal(options.timeout, 30_000); assert.equal(options.maxBuffer, 16_384);
    assert.equal(options.encoding, 'utf8'); assert.equal(options.cwd, f.env.GITHUB_WORKSPACE); assert.equal(options.env, f.env);
    return { stdout: 'ALLURE_TOKEN=SYNTHETIC_SECRET\nALLURE_JOB_RUN_ID=9\nALLURE_LAUNCH_ID=10\n', stderr: 'SYNTHETIC_SECRET_STDERR' };
  };
  assert.equal(await reporter('bootstrap-context', undefined, f.env, server.fetchImpl, execImpl), 0);
  const bytes = await readFile(path.join(f.state, 'registration.json'));
  const result = JSON.parse(bytes);
  assert.equal(result.schema, 'paperclip.chat-feature-testops-bootstrap-registration/v1');
  assert.equal(result.jobId, 7); assert.equal(result.allureJobRunId, '9'); assert.equal(result.launchId, 10);
  assert.equal(result.runId, '123'); assert.equal(result.workflowSha, context.GITHUB_SHA); assert.equal(result.targetSha, context.GITHUB_SHA);
  assert.equal(result.currentRunUrlMatches, true); assert.equal(result.publicWorkflowMatches, true);
  assert.equal(result.capturedAfterWatch, true); assert.equal(result.runnableBindingQualified, false); assert.equal(result.actualResult, null);
  assert.deepEqual(result.parameters, [{ id: 17, kind: 'UNRESOLVED', value: 'NOT_PROJECTED' }]);
  assert.ok(!bytes.toString().includes('SYNTHETIC')); assert.equal(f.env.ALLURE_JOB_RUN_ID, '');
  assert.deepEqual(await readFile(path.join(f.state, 'job.json')), f.originalJob);
  const second = await captureSafeErrors(() => reporter('bootstrap-context', undefined, f.env, () => assert.fail('no second auth'), () => assert.fail('no second CLI')));
  assert.equal(second.value, 1); assert.equal(executions, 1);
  assert.deepEqual(await readFile(path.join(f.state, 'registration.json')), bytes);
  assert.equal(server.calls.filter(row => row.method === 'POST').length, 1);
  assert.equal(server.calls[0].route, '/api/uaa/oauth/token');
});

test('post-watch missing official IDs fails closed without API auth or invented registration', async t => {
  const f = await bootstrapContextFixture(t);
  const result = await captureSafeErrors(() => reporter('bootstrap-context', undefined, f.env, () => assert.fail('no API'),
    async () => ({ stdout: 'ALLURE_TOKEN=SYNTHETIC_SECRET\n', stderr: 'PRIVATE_STDERR' })));
  assert.equal(result.value, 1); assert.ok(!result.text.includes('SYNTHETIC')); assert.ok(!result.text.includes('PRIVATE'));
  assert.equal(JSON.parse(await readFile(path.join(f.state, 'registration-failure.json'))).code, 'chat_testops_bootstrap_context_invalid');
  await assert.rejects(readFile(path.join(f.state, 'registration.json')), { code: 'ENOENT' });
});

test('post-watch command errors discard stdout stderr and raw exception without retry or API', async t => {
  const f = await bootstrapContextFixture(t); let calls = 0;
  const result = await captureSafeErrors(() => reporter('bootstrap-context', undefined, f.env, () => assert.fail('no API'), async () => {
    calls++; throw Object.assign(new Error('SYNTHETIC_PRIVATE_EXCEPTION'), { stdout: 'SYNTHETIC_PRIVATE_STDOUT', stderr: 'SYNTHETIC_PRIVATE_STDERR' });
  }));
  assert.equal(result.value, 1); assert.equal(calls, 1); assert.ok(!result.text.includes('SYNTHETIC'));
  assert.equal(JSON.parse(await readFile(path.join(f.state, 'registration-failure.json'))).code, 'chat_testops_bootstrap_command_failed');
});

test('post-watch wrong original operation or extra source input stops before official command and auth', async t => {
  for (const inputs of [{ operation: 'evaluate' }, { operation: 'launch-plan' }, { operation: 'bootstrap', ALLURE_JOB_RUN_ID: '9' }, { operation: 'bootstrap', model: 'foreign/model' }]) {
    const f = await bootstrapContextFixture(t, inputs);
    const result = await captureSafeErrors(() => reporter('bootstrap-context', undefined, f.env, () => assert.fail('no API'), () => assert.fail('no CLI')));
    assert.equal(result.value, 1);
  }
});

test('post-watch foreign backend binding returns safe nonzero and preserves original job evidence', async t => {
  const f = await bootstrapContextFixture(t), server = bootstrapContextFetch({ url: 'https://github.com/paperclipai/paperclip/actions/runs/999' });
  const result = await captureSafeErrors(() => reporter('bootstrap-context', undefined, f.env, server.fetchImpl,
    async () => ({ stdout: 'ALLURE_JOB_RUN_ID=9\nALLURE_LAUNCH_ID=10\n' })));
  assert.equal(result.value, 1); assert.equal(JSON.parse(await readFile(path.join(f.state, 'registration-failure.json'))).code, 'chat_testops_jobrun_mismatch');
  assert.deepEqual(await readFile(path.join(f.state, 'job.json')), f.originalJob);
});

test('bootstrap workflow captures official context only after watch and retains exactly named closed receipts', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/chat-feature-testops.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf('      - name: Register the public job without an evaluation or a synthetic result');
  const end = workflow.indexOf('      - name: Validate the one real TestOps selection', start);
  const step = workflow.slice(start, end);
  assert.ok(step.includes("if: needs.authorize.outputs.operation == 'bootstrap'"));
  assert.match(step, /allurectl watch -- node tests\/runner-e2e\/testops-chat-reporter\.mjs bootstrap\n\s+node tests\/runner-e2e\/testops-chat-reporter\.mjs bootstrap-context/);
  assert.equal((step.match(/allurectl watch/g) ?? []).length, 1); assert.ok(!step.includes('continue-on-error'));
  assert.ok(workflow.includes('${{ runner.temp }}/chat-testops-bootstrap-state/registration.json'));
  assert.ok(workflow.includes('${{ runner.temp }}/chat-testops-bootstrap-state/registration-failure.json'));
});

test('post-watch refuses nonprivate state custody before any command auth or receipt write', async t => {
  const f = await bootstrapContextFixture(t); await chmod(f.state, 0o755);
  const result = await captureSafeErrors(() => reporter('bootstrap-context', undefined, f.env, () => assert.fail('no API'), () => assert.fail('no CLI')));
  assert.equal(result.value, 1);
  await assert.rejects(readFile(path.join(f.state, 'registration.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(f.state, 'registration-failure.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(path.join(f.state, 'job.json')), f.originalJob);
});

test('post-watch authentication failure retains only fixed HTTP diagnostic and never reads body', async t => {
  const f = await bootstrapContextFixture(t); let calls = 0;
  const result = await captureSafeErrors(() => reporter('bootstrap-context', undefined, f.env, async () => {
    calls++; return { ok: false, status: 403, json: () => assert.fail('no auth body read'), text: () => assert.fail('no auth body read') };
  }, async () => ({ stdout: 'ALLURE_JOB_RUN_ID=9\nALLURE_LAUNCH_ID=10\n' })));
  assert.equal(result.value, 1); assert.equal(calls, 1);
  const failure = JSON.parse(await readFile(path.join(f.state, 'registration-failure.json')));
  assert.deepEqual(failure, { stage: 'bootstrap_context', code: 'testops_auth_http', httpStatus: 403 });
});
