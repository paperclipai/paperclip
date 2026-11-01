import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { endpoint, planName, fullName, inspectChatMetadata, ensureChatPlan, testopsClient, failureProjection } from './chat-feature-testops-api.mjs';

const caseRow = { id: 91, projectId: 1, fullName, automated: true };
const plan = { id: 8, projectId: 1, name: planName, testCasesCount: 1, treeSelection: { inverted: false, leafsInclude: [91] } };
const page = content => ({ content, totalPages: 1 });
const inspectApi = (cases = [caseRow], plans = [plan]) => async route => {
  if (route.startsWith('/api/testcase?')) return { content: cases.map(row => ({ id: row.id, name: 'Not exported', automated: row.automated })), totalElements: cases.length, totalPages: cases.length ? 1 : 0, number: 0 };
  if (/^\/api\/testcase\/[0-9]+$/.test(route)) return cases.find(row => row.id === Number(route.split('/').at(-1)));
  if (route.startsWith('/api/testplan?')) return page(plans);
  if (route.startsWith('/api/integration/project/1')) return page([{ id: 2, info: { type: 'github' }, disabled: false, settings: { secret: 'DO_NOT_EXPORT' } }]);
  assert.fail(route);
};

test('inspect reconciles exact historical case identity and discards integration settings', async () => {
  const result = await inspectChatMetadata(inspectApi());
  assert.deepEqual(result.cases, [{ id: 91, fullName, automated: true }]);
  assert.deepEqual(result.integrations, [{ id: 2, type: 'github', disabled: false }]);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPORT'));
});

test('multiple alias identities, foreign project and incomplete metadata stop before mutation', async () => {
  const conflicts = await inspectChatMetadata(inspectApi([caseRow, { ...caseRow, id: 92, fullName: 'paperclip.Product E2E.chat-features.tasks.create-backlog' }]));
  assert.equal(conflicts.caseConflict, true); assert.deepEqual(conflicts.cases.map(row => row.id), [91, 92]);
  await assert.rejects(ensureChatPlan(() => assert.fail('no ambiguous write'), conflicts, () => assert.fail('no ambiguous marker'))); 
  await assert.rejects(inspectChatMetadata(inspectApi([{ ...caseRow, projectId: 2 }])), /identity_invalid/);
  await assert.rejects(inspectChatMetadata(async () => ({ content: [], totalPages: 11, totalElements: 1100, number: 0 })), /catalog_incomplete/);
});

test('existing exact plan reuses case and plan without a write', async () => {
  const result = await ensureChatPlan(async route => { assert.equal(route, '/api/testplan/8'); return plan; },
    await inspectChatMetadata(inspectApi()), () => assert.fail('must not mark or write'));
  assert.equal(result.case.id, 91);
  assert.equal(result.plan.id, 8);
  assert.equal(result.actualResult, null);
});

test('bootstrap creates only the missing exact plan after exclusive marker and reads back scope', async () => {
  const calls = [];
  const result = await ensureChatPlan(async (route, method, body) => {
    calls.push({ route, method, body });
    if (method === 'POST') { assert.equal(calls[0].route, 'MARK'); assert.deepEqual(body, { projectId: 1, name: planName, treeSelection: { inverted: false, leafsInclude: [91] } }); }
    return plan;
  }, { projectId: 1, cases: [caseRow], plans: [] }, async () => calls.push({ route: 'MARK' }));
  assert.equal(calls.filter(row => row.method === 'POST').length, 1);
  assert.equal(result.plan.count, 1);
});

test('empty project bootstrap links the genuinely created case into only the new plan', async () => {
  const calls = [];
  const createdCase = { ...caseRow, id: 92 };
  const createdPlan = { ...plan, treeSelection: { inverted: false, leafsInclude: [92] } };
  const result = await ensureChatPlan(async (route, method, body) => {
    calls.push({ route, method, body });
    assert.equal(calls[0].route, 'MARK');
    if (route === '/api/testcase') {
      assert.equal(body.projectId, 1); assert.equal(body.fullName, fullName); assert.equal(body.automated, true);
      return createdCase;
    }
    if (route === '/api/testplan') {
      assert.deepEqual(body, { projectId: 1, name: planName, treeSelection: { inverted: false, leafsInclude: [92] } });
      return createdPlan;
    }
    assert.equal(route, '/api/testplan/8'); assert.equal(method, undefined); return createdPlan;
  }, { projectId: 1, cases: [], plans: [] }, async () => calls.push({ route: 'MARK' }));
  assert.equal(result.case.id, 92); assert.equal(result.plan.id, 8);
  assert.deepEqual(calls.map(call => call.route), ['MARK', '/api/testcase', '/api/testplan', '/api/testplan/8']);
});

test('known conflicting plan stops before creating an otherwise missing case or marker', async () => {
  await assert.rejects(ensureChatPlan(() => assert.fail('no API write or read needed'),
    { projectId: 1, cases: [], plans: [plan] }, () => assert.fail('must not mark')), /plan_without_matching_case/);
});

test('new case is created only after alias reconciliation; an uncertain mutation is never resent', async () => {
  let writes = 0, markers = 0;
  await assert.rejects(ensureChatPlan(async (_route, method) => {
    assert.equal(method, 'POST'); writes++; throw new Error('uncertain transport');
  }, { projectId: 1, cases: [], plans: [] }, async () => { markers++; }), /uncertain/);
  assert.equal(writes, 1); assert.equal(markers, 1);
});

test('existing broad or conflicting plan never expands or changes its scope', async () => {
  for (const actual of [{ ...plan, testCasesCount: 2 }, { ...plan, treeSelection: { leafsInclude: [92] } },
    { ...plan, treeSelection: { leafsInclude: [91], inverted: true } }, { ...plan, projectId: 2 }]) {
    await assert.rejects(ensureChatPlan(async (_route, method) => { assert.equal(method, undefined); return actual; },
      { projectId: 1, cases: [caseRow], plans: [plan] }, () => assert.fail('no writes')), /scope_mismatch/);
  }
});

test('API credential stays in memory, redirects fail closed and response text is not an error', async () => {
  const calls = [];
  const api = await testopsClient('PRIVATE_API_TOKEN', async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? { ok: true, json: async () => ({ access_token: 'PRIVATE_BEARER' }) }
      : { ok: false, status: 403, text: () => assert.fail('must not inspect arbitrary error body') };
  });
  await assert.rejects(api('/api/testplan?projectId=1'), error => { assert.deepEqual(failureProjection(error, 'metadata_inspection'), { stage: 'metadata_inspection', code: 'testops_api_http', httpStatus: 403 }); return true; });
  assert.equal(calls[0].url, `${endpoint}/api/uaa/oauth/token`);
  assert.equal(calls[1].options.redirect, 'error');
  await assert.rejects(api('https://foreign.invalid'), /route_invalid/);
  assert.equal(calls.length, 2);
});

test('unknown exception text is never copied into closed diagnostics', () => {
  const value = failureProjection(new Error('PRIVATE_RESPONSE_TOKEN_BODY'), 'untrusted raw stage');
  assert.deepEqual(value, { stage: 'unknown', code: 'unknown_failure', httpStatus: null });
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
});


import { validateChatSelection } from './chat-feature-testops-api.mjs';
const publicEnv = { GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_REF: 'refs/heads/master',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123',
  GITHUB_WORKFLOW_REF: 'paperclipai/paperclip/.github/workflows/chat-feature-testops.yml@refs/heads/master',
  ALLURE_JOB_RUN_ID: '9', CHAT_TESTOPS_CASE_ID: '91', CHAT_TESTOPS_PLAN_ID: '8', CHAT_TESTOPS_JOB_ID: '7' };
const selectedApi = replacements => async route => {
  const values = { '/api/testcase/91': caseRow, '/api/testplan/8': plan,
    '/api/testplan/8/job': [{ job: { id: 7 }, testCasesCount: 1 }],
    '/api/job/7': { id: 7, type: 'github', url: 'https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml' },
    '/api/jobrun/9': { id: 9, job: { id: 7, type: 'github' }, stage: 'scheduled', launchId: 10, url: 'https://github.com/paperclipai/paperclip/actions/runs/123' },
    '/api/launch/10': { id: 10, projectId: 1, closed: false },
    '/api/jobrun/9/plan?expected=true': [{ id: 91, selector: fullName }] };
  assert.ok(Object.hasOwn(values, route));
  return replacements?.[route] ?? values[route];
};

test('real API selection is exact singleton/project/job/launch and current source bound before model access', async () => {
  const selected = await validateChatSelection(selectedApi(), publicEnv);
  assert.equal(selected.runId, '123'); assert.equal(selected.workflowSha, 'a'.repeat(40));
  assert.equal(selected.executionId, 'chat-features.runner-opencode-deepseek-1017.local.create-backlog');
  assert.equal(selected.canonicalScenario, 'tasks.create-backlog'); assert.equal(selected.allureJobRunId, '9');
  assert.equal(selected.launchId, 10);
});

test('selection refuses missing correlation, a different case, broad plan, foreign job or closed launch', async () => {
  await assert.rejects(validateChatSelection(selectedApi(), { ...publicEnv, ALLURE_JOB_RUN_ID: '' }), /identity_missing/);
  for (const [route, value] of [
    ['/api/testcase/91', { ...caseRow, projectId: 2 }],
    ['/api/testplan/8', { ...plan, testCasesCount: 2 }],
    ['/api/job/7', { id: 7, type: 'github', url: 'https://github.com/paperclipai/paperclip-cloud/actions/workflows/qa-staging-smoke.yml' }],
    ['/api/testplan/8/job', [{ job: { id: 70 }, testCasesCount: 1 }]],
    ['/api/jobrun/9', { id: 9, job: { id: 70, type: 'github' }, stage: 'scheduled', launchId: 10 }],
    ['/api/jobrun/9', { id: 9, job: { id: 7, type: 'github' }, stage: 'scheduled', launchId: 10, url: 'https://github.com/paperclipai/paperclip/actions/runs/456' }],
    ['/api/launch/10', { id: 10, projectId: 1, closed: true }],
    ['/api/jobrun/9/plan?expected=true', [{ id: 92, selector: fullName }]],
  ]) await assert.rejects(validateChatSelection(selectedApi({ [route]: value }), publicEnv), /mismatch/);
});

test('selection rejects every non-master, foreign and second-attempt execution before API access', async () => {
  for (const change of [{ GITHUB_REF: 'refs/heads/feature' }, { GITHUB_REPOSITORY: 'foreign' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_WORKFLOW_REF: 'other' }]) {
    await assert.rejects(validateChatSelection(() => assert.fail('must stop before API'), { ...publicEnv, ...change }), /untrusted/);
  }
});

import { launchChatPlan, bootstrapJobMetadata, admitLaunchPlan } from './chat-feature-testops-api.mjs';
const launchEnv = { ...publicEnv, ALLURE_JOB_RUN_ID: '', CHAT_TESTOPS_OPERATION_PARAMETER_ID: '17', CHAT_TESTOPS_INTEGRATION_ID: '2', CHAT_TESTOPS_LAUNCH_NONCE: '1'.repeat(32), CHAT_TESTOPS_LAUNCH_RUN_NUMBER: '2', GITHUB_RUN_NUMBER: '2',
  CHAT_TESTOPS_GITHUB_WORKFLOW_ID: '99', GITHUB_ACTOR_ID: '34892728', TESTOPS_TRIGGERING_ACTOR_ID: '34892728', TESTOPS_ALLOWED_ACTOR_IDS: '[34892728]', GH_TOKEN: 'SYNTHETIC_GH_TOKEN' };
const ownRun = { id: 123, workflow_id: 99, run_attempt: 1, run_number: 2, head_sha: 'a'.repeat(40), head_branch: 'master', event: 'workflow_dispatch',
  repository: { full_name: 'paperclipai/paperclip', private: false }, actor: { id: 34892728 }, triggering_actor: { id: 34892728 } };
async function fence(env = launchEnv, changes = {}, workflowChanges = {}, repoChanges = {}) {
  return admitLaunchPlan(env, async url => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/repos/paperclipai/paperclip') ? { full_name: 'paperclipai/paperclip', private: false, default_branch: 'master', ...repoChanges }
    : url.includes('/actions/runs/') ? { ...ownRun, ...changes }
    : { id: 99, path: '.github/workflows/chat-feature-testops.yml', state: 'active', ...workflowChanges }) }));
}
function launchServer({ wrongAssignment = false, uncertainRun = false, integrationChange = {}, initialParameters = [{ id: 17, value: 'bootstrap' }], expectedParameters = [{ id: 17, value: 'evaluate' }], jobUrl = 'https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml' } = {}) {
  const calls = [], parameters = structuredClone(initialParameters); let assigned = false, launched = false, requests = 0;
  const api = async (route, method, body) => {
    calls.push({ route, method, body });
    if (route.startsWith('/api/launch?')) return { totalPages: 1, content: launched ? [{ id: 10, name: `Chat feature evals · ${'1'.repeat(32)}` }] : [] };
    if (route === '/api/integration/2/project/1') return { id: 2, projectId: 1, info: { type: 'github' }, disabled: false, ...integrationChange };
    if (route === '/api/job/7') {
      if (method === 'PATCH') { assert.deepEqual(body, { integrationId: 2, canRun: true, parameters: expectedParameters }); parameters.splice(0, parameters.length, ...structuredClone(body.parameters)); }
      return { id: 7, type: 'github', url: jobUrl, parameters };
    }
    if (route === '/api/testplan/8/job') return wrongAssignment ? [{ job: { id: 70 }, testCasesCount: 1 }]
      : assigned ? [{ job: { id: 7, parameters }, testCasesCount: 1 }] : [];
    if (route === '/api/testplan/8/assign') { assert.equal(method, 'POST'); assert.deepEqual(body, { jobId: 7, selection: { inverted: false, manual: false, leafsInclude: [91] } }); assigned = true; return null; }
    if (route === '/api/testplan/8/jobparameter') { assert.deepEqual(body, { jobId: 7, parameters: expectedParameters }); return null; }
    if (route === '/api/testplan/8/run') { requests++; assert.equal(method, 'POST'); if (uncertainRun) throw new Error('synthetic uncertain transport'); launched = true; return { id: 10, projectId: 1, name: body.launchName }; }
    return selectedApi()(route);
  };
  return { api, calls, requests: () => requests };
}

test('launch configures only the exact registered public job/plan then issues one run request and exits', async () => {
  const server = launchServer(); let markers = 0;
  const result = await launchChatPlan(server.api, launchEnv, async () => { markers++; assert.equal(server.calls.some(row => row.method), false); }, await fence());
  assert.equal(markers, 1); assert.equal(server.requests(), 1); assert.equal(result.status, 'REQUESTED');
  assert.equal(result.launchId, 10); assert.equal(result.actualRunId, null); assert.equal(result.actualResult, null);
  assert.ok(!server.calls.some(row => /jobrun.*rerun|dispatches/.test(row.route)));
});

test('observed launch nonce prevents a second run request across separate local entry attempts', async () => {
  const server = launchServer(); await launchChatPlan(server.api, launchEnv, async () => {}, await fence());
  const result = await launchChatPlan(server.api, launchEnv, () => assert.fail('existing launch must not mark or write'), await fence());
  assert.equal(result.status, 'EXISTING_NO_RESEND'); assert.equal(server.requests(), 1);
});

test('foreign assignment and unobserved operation parameter stop before any write', async () => {
  for (const options of [{ wrongAssignment: true }, { initialParameters: [{ id: 18, value: 'bootstrap' }] }]) {
    const server = launchServer(options);
    await assert.rejects(launchChatPlan(server.api, launchEnv, () => assert.fail('no marker'), await fence()));
    assert.equal(server.calls.some(row => row.method), false); assert.equal(server.requests(), 0);
  }
});

test('uncertain plan-run transport is sent once and never followed by another mutation', async () => {
  const server = launchServer({ uncertainRun: true });
  await assert.rejects(launchChatPlan(server.api, launchEnv, async () => {}, await fence()), /uncertain/);
  assert.equal(server.requests(), 1);
  assert.equal(server.calls.at(-1).route, '/api/testplan/8/run');
});

test('official bootstrap job metadata leaves opaque parameter labels unresolved and private values unprojected', async () => {
  const job = await bootstrapJobMetadata(async route => {
    if (route === '/api/jobrun/9') return { id: 9, job: { id: 7 }, launchId: 10, url: 'https://github.com/paperclipai/paperclip/actions/runs/123' };
    if (route === '/api/job/7') return { id: 7, type: 'github', url: 'https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml', parameters: [{ id: 17, value: 'bootstrap' }, { id: 18, value: 'SYNTHETIC_PRIVATE_VALUE' }] };
    assert.fail('no namespace lookup or unrelated request');
  }, publicEnv);
  assert.equal(job.publicWorkflowMatches, true); assert.deepEqual(job.parameters[0], { id: 17, kind: 'UNRESOLVED', value: 'NOT_PROJECTED' });
  assert.deepEqual(job.parameters[1], { id: 18, kind: 'UNRESOLVED', value: 'NOT_PROJECTED' });
  assert.ok(!JSON.stringify(job).includes('SYNTHETIC_PRIVATE_VALUE'));
});

test('documented stable-ID list pagination is complete before locally matching exact alias detail metadata', async () => {
  const calls = [];
  const api = async route => {
    calls.push(route);
    if (route.startsWith('/api/testcase?')) {
      const query = new URLSearchParams(route.split('?')[1]);
      assert.equal(query.get('projectId'), '1'); assert.equal(query.get('sort'), 'id,asc');
      const number = Number(query.get('page'));
      return { number, totalPages: 2, totalElements: 2, content: [{ id: number ? 92 : 91 }] };
    }
    if (route === '/api/testcase/91') return { ...caseRow, description: 'SYNTHETIC_PRIVATE_DESCRIPTION' };
    if (route === '/api/testcase/92') return { id: 92, projectId: 1, fullName: 'paperclip.Product E2E.unrelated.case', automated: true, expectedResult: 'DO_NOT_EXPORT' };
    return inspectApi([], [])(route);
  };
  const result = await inspectChatMetadata(api);
  assert.deepEqual(result.cases, [{ id: 91, fullName, automated: true }]);
  assert.ok(calls.some(route => route.includes('page=1')));
  assert.ok(!calls.some(route => route.includes('__search')));
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_DESCRIPTION'));
  assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPORT'));
});

test('changing catalog totals or repeated page IDs cannot become a not-found result', async () => {
  for (const duplicate of [false, true]) {
    await assert.rejects(inspectChatMetadata(async route => {
      if (route.startsWith('/api/testcase?')) {
        const number = Number(new URLSearchParams(route.split('?')[1]).get('page'));
        return { number, totalPages: 2, totalElements: number && !duplicate ? 3 : 2, content: [{ id: number && !duplicate ? 92 : 91 }] };
      }
      return caseRow;
    }), /catalog_incomplete/);
  }
});

test('catalog detail reads have a finite four-request concurrency bound', async () => {
  let active = 0, maximum = 0;
  const api = async route => {
    if (route.startsWith('/api/testcase?')) return { number: 0, totalPages: 1, totalElements: 7, content: Array.from({ length: 7 }, (_, index) => ({ id: index + 1 })) };
    if (/^\/api\/testcase\/[0-9]+$/.test(route)) {
      active++; maximum = Math.max(maximum, active); await new Promise(resolve => queueMicrotask(resolve)); active--;
      return { id: Number(route.split('/').at(-1)), projectId: 1, fullName: null, automated: false };
    }
    return inspectApi([], [])(route);
  };
  assert.deepEqual((await inspectChatMetadata(api)).cases, []);
  assert.equal(maximum, 4);
});

test('fresh dispatch or replay cannot acquire the fixed initial launch counter even with stale TestOps search', async () => {
  for (const env of [{ ...launchEnv, GITHUB_RUN_NUMBER: '3' }, { ...launchEnv, GITHUB_RUN_ATTEMPT: '2' },
    { ...launchEnv, CHAT_TESTOPS_LAUNCH_RUN_NUMBER: '' }]) {
    await assert.rejects(admitLaunchPlan(env, () => assert.fail('counter/refusal precedes all remote reads')));
  }
});

test('real own-run metadata rejects counter, source, workflow, actor and default-ref contradictions', async () => {
  for (const changes of [{ run_number: 3 }, { head_sha: 'b'.repeat(40) }, { workflow_id: 100 },
    { actor: { id: 1 } }, { triggering_actor: { id: 1 } }, { run_attempt: 2 }, { head_branch: 'feature' }]) {
    await assert.rejects(fence(launchEnv, changes), /launch_admission/);
  }
  await assert.rejects(fence(launchEnv, {}, {}, { default_branch: 'other' }), /launch_admission/);
  await assert.rejects(fence(launchEnv, {}, { state: 'disabled_manually' }), /launch_admission/);
});

test('no caller-supplied JSON can replace the source-owned GitHub launch admission receipt', async () => {
  const actual = await fence();
  await assert.rejects(launchChatPlan(() => assert.fail('no API mutation'), launchEnv, () => assert.fail('no marker'), JSON.parse(JSON.stringify(actual))), /launch_admission/);
});

test('GitHub metadata denial retains only its fixed code and HTTP status', async () => {
  await assert.rejects(admitLaunchPlan(launchEnv, async () => ({ ok: false, status: 403, text: () => assert.fail('must not read denial body') })), error => {
    assert.deepEqual(failureProjection(error, 'launch_admission'), { stage: 'launch_admission', code: 'chat_testops_github_http', httpStatus: 403 }); return true;
  });
});

test('new job receives only the reviewed enabled GitHub integration; disabled/foreign identities stop before writes', async () => {
  for (const integrationChange of [{ id: 3 }, { projectId: 2 }, { disabled: true }, { disabled: null }, { info: { type: 'gitlab' } }]) {
    const server = launchServer({ integrationChange });
    await assert.rejects(launchChatPlan(server.api, launchEnv, () => assert.fail('no marker'), await fence()), /integration_mismatch/);
    assert.equal(server.calls.some(row => row.method), false);
  }
});

const uploadContext = { GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_REF: 'refs/heads/master', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', ALLURE_JOB_RUN_ID: '9',
  GITHUB_WORKFLOW_REF: 'paperclipai/paperclip/.github/workflows/chat-feature-testops.yml@refs/heads/master' };
const uploadSelection = { runId: '123', attempt: '1', workflowSha: 'a'.repeat(40), targetSha: 'a'.repeat(40), allureJobRunId: '9',
  executionId: 'chat-features.runner-opencode-deepseek-1017.local.create-backlog', canonicalScenario: 'tasks.create-backlog', projectId: 1,
  planId: 8, jobId: 7, caseId: 91, fullName, launchId: 10 };
const uploadReceipt = { status: 'passed', cleanup: 'passed', caseId: 91, campaignId: 'gha-123-1', count: 1,
  attachmentMetadata: [{ name: 'Synthetic task and source conversation', contentType: 'image/png', contentLength: 400 },
    { name: 'Execution provenance and checks', contentType: 'application/json', contentLength: 300 },
    { name: 'Sanitized Product E2E record and accounting', contentType: 'application/json', contentLength: 800 }] };
const uploadRun = { id: 9, job: { id: 7, type: 'github' }, launchId: 10, url: 'https://github.com/paperclipai/paperclip/actions/runs/123', stage: 'finished' };
function uploadApi(change = {}, absent = 0, runChange = {}) {
  let polls = 0;
  return async (route, method) => {
    assert.equal(method, 'GET');
    if (route === '/api/jobrun/9') return { ...uploadRun, ...runChange };
    if (route === '/api/launch/10') return { id: 10, projectId: 1 };
    if (route.startsWith('/api/testresult?')) { polls++; return { content: polls <= absent ? [] : [{ id: 45, testCaseId: 91 }], totalElements: polls <= absent ? 0 : 1, totalPages: polls <= absent ? 0 : 1 }; }
    if (route === '/api/testresult/45') return { id: 45, projectId: 1, launchId: 10, testCaseId: 91, fullName, jobRun: uploadRun, status: 'passed',
      links: [{ url: uploadRun.url }, { url: `https://github.com/paperclipai/paperclip/commit/${'a'.repeat(40)}` }],
      get trace() { assert.fail('must not inspect trace'); }, ...change };
    if (route.startsWith('/api/testresult/attachment?')) return { content: uploadReceipt.attachmentMetadata.map((row, i) => ({ ...row, id: i + 1, missed: false, fromTestCase: false })), totalElements: 3, totalPages: 1 };
    assert.fail(route);
  };
}

test('readback verifies exact current launch/case/source/status and safe attachment metadata after processing lag', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  let waits = 0;
  const result = await verifyChatUpload(uploadApi({}, 1), uploadContext, uploadSelection, uploadReceipt, { wait: async () => { waits++; }, now: () => 0 });
  assert.equal(waits, 1); assert.equal(result.verification, 'VERIFIED'); assert.equal(result.resultId, 45);
  assert.equal(result.status, 'passed'); assert.deepEqual(result.attachments, uploadReceipt.attachmentMetadata);
  assert.ok(!JSON.stringify(result).includes('trace'));
});

test('readback rejects wrong launch, case, current jobrun, source and contradictory result status', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  for (const change of [{ launchId: 11 }, { testCaseId: 92 }, { jobRun: { ...uploadRun, id: 11 } }, { links: [{ url: 'https://github.com/paperclipai/paperclip/commit/' + 'b'.repeat(40) }] }, { status: 'failed' }]) {
    await assert.rejects(verifyChatUpload(uploadApi(change), uploadContext, uploadSelection, uploadReceipt), /upload_mismatch/);
  }
});

test('readback joins an unexpanded result jobrun to the authoritative jobrun response', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const { job, ...embedded } = uploadRun;
  const result = await verifyChatUpload(uploadApi({ jobRun: embedded }), uploadContext, uploadSelection, uploadReceipt);
  assert.equal(result.resultId, 45); assert.equal(result.jobId, 7); assert.equal(result.verification, 'VERIFIED');
});

test('readback accepts protected empty presentation links while retaining the source-bound current run', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const { job, ...embedded } = uploadRun;
  const result = await verifyChatUpload(uploadApi({ jobRun: embedded, links: [] }), uploadContext, uploadSelection, uploadReceipt);
  assert.equal(result.targetSha, uploadContext.GITHUB_SHA); assert.equal(result.runId, '123');
  assert.equal(result.resultId, 45); assert.equal(result.verification, 'VERIFIED');
});

test('readback rejects authoritative or embedded identity contradictions and a foreign source selection', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const { job, ...embedded } = uploadRun;
  for (const runChange of [{ job: { id: 8, type: 'github' } }, { job: { id: 7, type: 'gitlab' } },
    { url: 'https://github.com/paperclipai/paperclip/actions/runs/124' }, { launchId: 11 }]) {
    await assert.rejects(verifyChatUpload(uploadApi({ jobRun: embedded, links: [] }, 0, runChange), uploadContext, uploadSelection, uploadReceipt), /jobrun_mismatch/);
  }
  for (const change of [{ jobRun: { ...embedded, id: 11 } }, { jobRun: { ...embedded, job: { id: 8 } } },
    { jobRun: { ...embedded, job: { id: 7, type: 'gitlab' } } }, { jobRun: { ...embedded, job: { id: 7, url: 'https://github.com/other/repo' } } },
    { jobRun: { ...embedded, launchId: 11 } }, { jobRun: { ...embedded, url: 'https://github.com/paperclipai/paperclip/actions/runs/124' } },
    { links: [{ url: 'https://github.com/paperclipai/paperclip/actions/runs/124' }] },
    { links: [{ url: 'https://github.com/paperclipai/paperclip/commit/' + 'b'.repeat(40) }] }]) {
    await assert.rejects(verifyChatUpload(uploadApi(change), uploadContext, uploadSelection, uploadReceipt), /upload_mismatch/);
  }
  for (const selection of [{ ...uploadSelection, targetSha: 'b'.repeat(40) }, { ...uploadSelection, workflowSha: 'b'.repeat(40) }]) {
    await assert.rejects(verifyChatUpload(uploadApi({ jobRun: embedded, links: [] }), uploadContext, selection, uploadReceipt), /upload_mismatch/);
  }
});

async function uploadFailureDiagnostic(api, context = uploadContext, selection = uploadSelection, receipt = uploadReceipt) {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  let error;
  await assert.rejects(verifyChatUpload(api, context, selection, receipt), value => { error = value; return true; });
  return { error, projected: failureProjection(error, 'upload_verification') };
}

test('upload diagnostics identify selected, environment and exported context without an HTTP call', async () => {
  const noHttp = () => assert.fail('context rejection must precede HTTP');
  const cases = [
    [{}, { ...uploadSelection, targetSha: 'b'.repeat(40) }, uploadReceipt, 'selected_target_sha', 'string'],
    [{ ALLURE_JOB_RUN_ID: undefined }, uploadSelection, uploadReceipt, 'selected_jobrun', 'string'],
    [{}, uploadSelection, { ...uploadReceipt, count: 'private-count' }, 'export_count', 'string'],
  ];
  for (const [envChange, selected, receipt, first, type] of cases) {
    const { projected } = await uploadFailureDiagnostic(noHttp, { ...uploadContext, ...envChange }, selected, receipt);
    assert.equal(projected.code, 'chat_testops_upload_mismatch');
    assert.equal(projected.verification.phase, 'context');
    assert.equal(projected.verification.firstFailedPredicate, first);
    assert.equal(projected.verification.checks[first], false);
    assert.equal(projected.verification.types[first], type);
    assert.ok(!JSON.stringify(projected).includes('private-count'));
    if (first === 'selected_jobrun') assert.equal(projected.verification.types.env_jobrun, 'missing');
  }
});

test('upload diagnostics distinguish absent page and row fields from contradictory numeric identities', async () => {
  const base = uploadApi();
  for (const [response, phase, first, type] of [
    [{ content: [], totalPages: 0 }, 'result_page', 'total_integer', 'missing'],
    [{ content: [], totalElements: 0, totalPages: 'private-page' }, 'result_page', 'pages_integer', 'string'],
    [{ content: [{ id: 45 }], totalElements: 1, totalPages: 1 }, 'result_row', 'case_id', 'missing'],
    [{ content: [{ id: 45, testCaseId: 92 }], totalElements: 1, totalPages: 1 }, 'result_row', 'case_id', 'number'],
  ]) {
    const { projected } = await uploadFailureDiagnostic((route, ...args) => route.startsWith('/api/testresult?') ? response : base(route, ...args));
    assert.equal(projected.verification.phase, phase); assert.equal(projected.verification.firstFailedPredicate, first);
    assert.equal(projected.verification.types[first], type); assert.equal(projected.verification.checks[first], false);
    assert.ok(!JSON.stringify(projected).includes('private-page'));
  }
});

test('upload diagnostics retain exact authoritative and result rejection predicates', async () => {
  const base = uploadApi();
  const cases = [
    ['/api/jobrun/9', { ...uploadRun, job: { type: 'github' } }, 'jobrun', 'job_id', 'missing'],
    ['/api/jobrun/9', { ...uploadRun, job: { id: 8, type: 'github' } }, 'jobrun', 'job_id', 'number'],
    ['/api/launch/10', { id: 10, projectId: 2 }, 'launch', 'project_id', 'number'],
  ];
  for (const [target, response, phase, first, type] of cases) {
    const { projected } = await uploadFailureDiagnostic((route, ...args) => route === target ? response : base(route, ...args));
    assert.equal(projected.verification.phase, phase); assert.equal(projected.verification.firstFailedPredicate, first);
    assert.equal(projected.verification.types[first], type);
  }
  const result = await uploadFailureDiagnostic(uploadApi({ status: 'private-status' }));
  assert.equal(result.projected.verification.phase, 'result_status');
  assert.equal(result.projected.verification.firstFailedPredicate, 'status_supported');
  assert.ok(!JSON.stringify(result.projected).includes('private-status'));
});

test('upload diagnostics identify local attachment and backend attachment-page failures', async () => {
  const local = await uploadFailureDiagnostic(() => assert.fail('attachment contract precedes HTTP'), uploadContext, uploadSelection,
    { ...uploadReceipt, attachmentMetadata: uploadReceipt.attachmentMetadata.map((row, index) => index === 0 ? { ...row, contentType: 'private-type' } : row) });
  assert.equal(local.projected.verification.phase, 'attachment_contract');
  assert.equal(local.projected.verification.firstFailedPredicate, 'attachment_rows');
  assert.ok(!JSON.stringify(local.projected).includes('private-type'));
  const base = uploadApi();
  const page = await uploadFailureDiagnostic((route, ...args) => route.startsWith('/api/testresult/attachment?')
    ? { content: null, totalElements: 0, totalPages: 0 } : base(route, ...args));
  assert.equal(page.projected.verification.phase, 'attachment_page');
  assert.equal(page.projected.verification.firstFailedPredicate, 'content_array');
  assert.equal(page.projected.verification.types.content_array, 'null');
});

test('upload diagnostic projection never retains secret values, unknown fields or mutable aliases', async () => {
  const secret = 'DO_NOT_RETAIN_SYNTHETIC_CREDENTIAL_OR_PRIVATE_URL';
  const { error, projected } = await uploadFailureDiagnostic(uploadApi({ fullName: secret, unknown: secret }),
    { ...uploadContext, ALLURE_TOKEN: secret });
  assert.equal(projected.verification.phase, 'result');
  assert.equal(projected.verification.firstFailedPredicate, 'full_name');
  assert.equal(projected.verification.types.full_name, 'string');
  assert.ok(!JSON.stringify(projected).includes(secret));
  projected.verification.phase = secret; projected.verification.failedPredicates.push(secret);
  projected.verification.checks.full_name = secret; projected.verification.types.full_name = secret;
  const again = failureProjection(error, 'upload_verification');
  assert.equal(again.verification.phase, 'result'); assert.equal(again.verification.checks.full_name, false);
  assert.ok(!JSON.stringify(again).includes(secret));
  const unknown = failureProjection(Object.assign(new Error(secret), { verification: { phase: secret } }), 'upload_verification');
  assert.equal(unknown.code, 'unknown_failure'); assert.ok(!Object.hasOwn(unknown, 'verification'));
});

test('upload diagnostics preserve an early mismatch when later array entries are null', async () => {
  const result = await uploadFailureDiagnostic(uploadApi({ id: 46, links: [null] }));
  assert.equal(result.projected.verification.phase, 'result');
  assert.equal(result.projected.verification.firstFailedPredicate, 'result_id');
  assert.equal(result.projected.verification.checks.result_id, false);
  const base = uploadApi();
  const page = await uploadFailureDiagnostic((route, ...args) => route.startsWith('/api/testresult/attachment?')
    ? { content: [null], totalElements: 2, totalPages: 1 } : base(route, ...args));
  assert.equal(page.projected.verification.firstFailedPredicate, 'total_matches_content');
  const local = await uploadFailureDiagnostic(() => assert.fail('no HTTP'), uploadContext, uploadSelection,
    { ...uploadReceipt, attachmentMetadata: [{ ...uploadReceipt.attachmentMetadata[0], contentType: 'unexpected' }, null, uploadReceipt.attachmentMetadata[2]] });
  assert.equal(local.projected.verification.firstFailedPredicate, 'attachment_rows');
});

test('readback missing result or screenshot metadata is bounded unverified, never a fabricated pass', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  let waits = 0;
  await assert.rejects(verifyChatUpload(uploadApi({}, 100), uploadContext, uploadSelection, uploadReceipt,
    { wait: async () => { waits++; }, now: () => 0 }), /upload_unverified/);
  assert.equal(waits, 11);
  const base = uploadApi();
  await assert.rejects(verifyChatUpload(async (route, ...args) => route.startsWith('/api/testresult/attachment?')
    ? { content: [], totalElements: 0, totalPages: 0 } : base(route, ...args), uploadContext, uploadSelection, uploadReceipt,
  { wait: async () => {}, now: () => 0 }), /upload_unverified/);
});

test('verified failed Product E2E remains failed and cleanup cannot be promoted', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const result = await verifyChatUpload(uploadApi({ status: 'failed' }), uploadContext, uploadSelection, { ...uploadReceipt, status: 'failed', cleanup: 'failed' });
  assert.equal(result.status, 'failed'); assert.equal(result.cleanup, 'failed');
  await assert.rejects(verifyChatUpload(uploadApi(), uploadContext, uploadSelection, { ...uploadReceipt, cleanup: 'failed' }), /upload_mismatch/);
});


test('readback stops immediately after a late GET and gives each client only the remaining deadline', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  let time = 0, calls = 0;
  await assert.rejects(verifyChatUpload(async (route, method, body, timeout) => {
    calls++; assert.equal(route, '/api/jobrun/9'); assert.equal(timeout, 30_000); time = 120_001; return uploadRun;
  }, uploadContext, uploadSelection, uploadReceipt, { now: () => time }), /upload_unverified/);
  assert.equal(calls, 1);
  time = 0; calls = 0;
  await assert.rejects(verifyChatUpload(async (route, method, body, timeout) => {
    calls++;
    if (calls === 1) { assert.equal(timeout, 30_000); time = 119_990; return uploadRun; }
    assert.equal(route, '/api/launch/10'); assert.equal(timeout, 10); time = 120_001; return { id: 10, projectId: 1 };
  }, uploadContext, uploadSelection, uploadReceipt, { now: () => time }), /upload_unverified/);
  assert.equal(calls, 2);
});

function strictBootstrapApi(patch = {}) {
  const run = { id: 9, job: { id: 7, type: 'github' }, launchId: 10, url: 'https://github.com/paperclipai/paperclip/actions/runs/123', ...patch.run };
  const launch = { id: 10, projectId: 1, ...patch.launch };
  const job = { id: 7, type: 'github', url: 'https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml',
    parameters: [{ id: 17, value: 'bootstrap' }, { id: 18, get value() { assert.fail('unrelated parameter value must stay unopened'); } }], ...patch.job };
  return async (route, method) => {
    assert.equal(method, undefined);
    if (route === '/api/jobrun/9') return run;
    if (route === '/api/launch/10') return launch;
    if (route === '/api/job/7') return job;
    assert.fail(route);
  };
}

test('post-watch reader binds actual current run source project launch and public workflow without claiming runnable', async () => {
  const result = await bootstrapJobMetadata(strictBootstrapApi(), publicEnv, 10);
  assert.equal(result.jobId, 7); assert.equal(result.runId, publicEnv.GITHUB_RUN_ID);
  assert.equal(result.workflowSha, publicEnv.GITHUB_SHA); assert.equal(result.capturedAfterWatch, true);
  assert.equal(result.runnableBindingQualified, false); assert.equal(result.actualResult, null);
  assert.deepEqual(result.parameters[1], { id: 18, kind: 'UNRESOLVED', value: 'NOT_PROJECTED' });
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE'));
});

test('post-watch reader rejects stale foreign project launch source and job identity', async () => {
  for (const patch of [{ run: { id: 99 } }, { run: { url: 'https://github.com/paperclipai/paperclip/actions/runs/999' } },
    { run: { launchId: 20 } }, { run: { job: { id: 7, type: 'foreign' } } }, { launch: { projectId: 2 } },
    { launch: { id: 20 } }, { job: { url: 'https://github.com/other/repo/actions/workflows/chat-feature-testops.yml' } },
    { job: { type: 'foreign' } }, { job: { parameters: [{ id: 0 }] } }]) {
    await assert.rejects(bootstrapJobMetadata(strictBootstrapApi(patch), publicEnv, 10));
  }
  await assert.rejects(bootstrapJobMetadata(() => assert.fail('no API'), { ...publicEnv, GITHUB_SHA: 'untrusted' }, 10));
  await assert.rejects(bootstrapJobMetadata(() => assert.fail('no API'), { ...publicEnv, ALLURE_JOB_RUN_ID: '' }, 10));
});

test('post-watch reader caps opaque parameters and refuses duplicate IDs', async () => {
  for (const parameters of [Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })), [{ id: 17 }, { id: 17 }]]) {
    await assert.rejects(bootstrapJobMetadata(strictBootstrapApi({ job: { parameters } }), publicEnv, 10));
  }
});


const observedLegacyJobUrl = 'https://github.com/paperclipai/paperclip/actions?query=workflow%3A%22Chat+feature+TestOps%22';

test('official observed legacy and existing workflow URLs pass all three actual job consumers', async () => {
  for (const url of [observedLegacyJobUrl, 'https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml',
    'https://github.com/paperclipai/paperclip/actions/workflows/99']) {
    const env = { ...publicEnv, CHAT_TESTOPS_GITHUB_WORKFLOW_ID: '99' };
    const selected = await validateChatSelection(selectedApi({ '/api/job/7': { id: 7, type: 'github', url } }), env);
    assert.equal(selected.caseId, 91);
    const registered = await bootstrapJobMetadata(strictBootstrapApi({ job: { url } }), env, 10);
    assert.equal(registered.publicWorkflowMatches, true);
    const server = launchServer({ jobUrl: url });
    const launched = await launchChatPlan(server.api, launchEnv, async () => {}, await fence());
    assert.equal(launched.status, 'REQUESTED');
    assert.equal(server.requests(), 1);
  }
});

test('official legacy URL admission rejects foreign workflow repo query credentials and fragment in all consumers', async () => {
  for (const url of [observedLegacyJobUrl.replace('/paperclip/actions', '/paperclip-cloud/actions'),
    observedLegacyJobUrl.replace('Chat+feature+TestOps', 'Other+workflow'), `${observedLegacyJobUrl}&extra=1`,
    observedLegacyJobUrl.replace('https://github.com', 'https://user:password@github.com'), `${observedLegacyJobUrl}#extra`]) {
    await assert.rejects(validateChatSelection(selectedApi({ '/api/job/7': { id: 7, type: 'github', url } }), publicEnv), /chat_testops_job_mismatch/);
    await assert.rejects(bootstrapJobMetadata(strictBootstrapApi({ job: { url } }), publicEnv, 10), error => {
      assert.deepEqual(failureProjection(error, 'bootstrap_context'), { stage: 'bootstrap_context', code: 'chat_testops_job_url_mismatch', httpStatus: null,
        request: { class: 'JOB_GET', resourceId: 7, state: 'SUCCEEDED', httpStatus: null } });
      return true;
    });
    const server = launchServer({ jobUrl: url });
    await assert.rejects(launchChatPlan(server.api, launchEnv, async () => assert.fail('no mutation marker'), await fence()), /chat_testops_job_mismatch/);
    assert.equal(server.calls.some(call => call.method), false);
  }
});

test('bootstrap job predicate failures retain only distinct fixed codes and no observed values', async () => {
  for (const [job, code] of [
    [{ id: 99 }, 'chat_testops_job_id_mismatch'],
    [{ type: 'SYNTHETIC_PRIVATE_TYPE' }, 'chat_testops_job_type_mismatch'],
    [{ parameters: undefined }, 'chat_testops_job_parameters_shape_mismatch'],
    [{ parameters: null }, 'chat_testops_job_parameters_shape_mismatch'],
    [{ parameters: 'SYNTHETIC_PRIVATE_PARAMETERS' }, 'chat_testops_job_parameters_shape_mismatch'],
    [{ parameters: Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })) }, 'chat_testops_job_parameters_limit'],
    [{ url: 'https://SYNTHETIC_PRIVATE_URL.invalid/' }, 'chat_testops_job_url_mismatch'],
  ]) {
    await assert.rejects(bootstrapJobMetadata(strictBootstrapApi({ job }), publicEnv, 10), error => {
      const projected = failureProjection(error, 'bootstrap_context');
      assert.deepEqual(projected, { stage: 'bootstrap_context', code, httpStatus: null,
        request: { class: 'JOB_GET', resourceId: 7, state: 'SUCCEEDED', httpStatus: null } });
      assert.ok(!JSON.stringify(projected).includes('SYNTHETIC_PRIVATE'));
      return true;
    });
  }
});


test('launch preserves exact Branch and defaults evaluate only when operation is genuinely absent', async () => {
  for (const [parameters, opId, expectedParameters] of [
    [[{ id: 19, value: 'refs/heads/master' }], undefined, [{ id: 19, value: 'refs/heads/master' }]],
    [[{ id: 19, value: 'refs/heads/master' }], '', [{ id: 19, value: 'refs/heads/master' }]],
    [[{ id: 17, value: 'bootstrap' }], '17', [{ id: 17, value: 'evaluate' }]],
    [[{ id: 19, value: 'refs/heads/master' }, { id: 17, value: 'bootstrap' }], '17', [{ id: 19, value: 'refs/heads/master' }, { id: 17, value: 'evaluate' }]],
  ]) {
    const env = { ...launchEnv, CHAT_TESTOPS_OPERATION_PARAMETER_ID: opId };
    const server = launchServer({ initialParameters: parameters, expectedParameters });
    let marked = 0;
    const result = await launchChatPlan(server.api, env, async () => { marked++; assert.equal(server.calls.some(call => call.method), false); }, await fence(env));
    assert.equal(result.status, 'REQUESTED'); assert.equal(server.requests(), 1); assert.equal(marked, 1);
    assert.deepEqual(server.calls.filter(call => call.route === '/api/job/7' && call.method === 'PATCH')[0].body.parameters, expectedParameters);
    assert.deepEqual(server.calls.filter(call => call.route === '/api/testplan/8/jobparameter')[0].body.parameters, expectedParameters);
  }
});

test('launch refuses empty unknown duplicate wrong Branch or conflicting operation before any mutation', async () => {
  const branch = { id: 19, value: 'refs/heads/master' };
  for (const [parameters, opId] of [
    [[], undefined, {}],
    [[{ id: 19, value: 'refs/heads/other' }], undefined, {}],
    [[branch, branch], undefined, {}],
    [[branch, { id: 20, value: 'refs/heads/master' }], undefined, {}],
    [[{ id: 0, value: 'refs/heads/master' }], undefined, {}],
    [[{ id: 19, value: 'PRIVATE_PARAMETER_VALUE' }], undefined, { 19: { id: 19, name: 'PRIVATE_PARAMETER_NAME' } }],
    [[branch], '17', {}],
    [[branch], 'bad-id', {}],
    [[branch], '0', {}],
    [[branch], ' ', {}],
    [[{ id: 17, value: 'bootstrap' }], undefined, {}],
    [[{ id: 17, value: 'bootstrap' }], '18', {}],
    [[{ id: 17, value: 'launch-plan' }], '17', {}],
    [[branch, { id: 17, value: 'bootstrap' }, { id: 20, value: 'refs/heads/master' }], '17', {}],
  ]) {
    const env = { ...launchEnv, CHAT_TESTOPS_OPERATION_PARAMETER_ID: opId };
    const server = launchServer({ initialParameters: parameters });
    await assert.rejects(launchChatPlan(server.api, env, async () => assert.fail('no mutation marker'), await fence(env)), /chat_testops_(?:identity_missing|parameter_mismatch)/);
    assert.equal(server.calls.some(call => call.method), false); assert.equal(server.requests(), 0);
  }
});

test('bootstrap projects an exact default ref without inventing an opaque parameter label', async () => {
  const result = await bootstrapJobMetadata(strictBootstrapApi({ job: { parameters: [{ id: 19, value: 'refs/heads/master' }] } }), publicEnv, 10);
  assert.deepEqual(result.parameters, [{ id: 19, kind: 'fixed_default_ref', value: 'refs/heads/master' }]);
  const unknown = await bootstrapJobMetadata(strictBootstrapApi({ job: { parameters: [{ id: 19, value: 'PRIVATE_BRANCH_VALUE' }] } }), publicEnv, 10);
  assert.deepEqual(unknown.parameters, [{ id: 19, kind: 'UNRESOLVED', value: 'NOT_PROJECTED' }]);
  assert.ok(!JSON.stringify(unknown).includes('PRIVATE_BRANCH'));
});

test('opaque launch vector uses only returned IDs and never queries any environment namespace', async () => {
  const env = { ...launchEnv, CHAT_TESTOPS_OPERATION_PARAMETER_ID: '' };
  const server = launchServer({ initialParameters: [{ id: 819, value: 'refs/heads/master' }], expectedParameters: [{ id: 819, value: 'refs/heads/master' }] });
  const result = await launchChatPlan(async (...args) => { assert.ok(!args[0].includes('/environment')); return server.api(...args); }, env, async () => {}, await fence(env));
  assert.equal(result.status, 'REQUESTED'); assert.equal(server.requests(), 1);
});

test('bootstrap successful reads expose only the three fixed source request classes and numeric IDs', async () => {
  const result = await bootstrapJobMetadata(strictBootstrapApi(), publicEnv, 10);
  assert.deepEqual(result.requests, [
    { class: 'JOB_RUN_GET', resourceId: 9, state: 'SUCCEEDED', httpStatus: null },
    { class: 'LAUNCH_GET', resourceId: 10, state: 'SUCCEEDED', httpStatus: null },
    { class: 'JOB_GET', resourceId: 7, state: 'SUCCEEDED', httpStatus: null },
  ]);
});

test('bootstrap actual HTTP client failure identifies each fixed request without reading private bodies', async () => {
  for (const [failedRoute, kind, resourceId, count] of [['/api/jobrun/9', 'JOB_RUN_GET', 9, 1], ['/api/launch/10', 'LAUNCH_GET', 10, 2], ['/api/job/7', 'JOB_GET', 7, 3]]) {
    const calls = [], base = strictBootstrapApi();
    const api = await testopsClient('SYNTHETIC_TOKEN', async (url, options) => {
      const route = url.slice(endpoint.length);
      if (route === '/api/uaa/oauth/token') return { ok: true, json: async () => ({ access_token: 'SYNTHETIC_ACCESS' }) };
      calls.push(route); assert.equal(options.method, 'GET');
      if (route === failedRoute) return { ok: false, status: 404, text: () => assert.fail('private error body must stay unopened') };
      return { ok: true, status: 200, text: async () => JSON.stringify(await base(route)) };
    });
    await assert.rejects(bootstrapJobMetadata(api, publicEnv, 10), error => {
      const projected = failureProjection(error, 'bootstrap_context');
      assert.deepEqual(projected, { stage: 'bootstrap_context', code: 'testops_api_http', httpStatus: 404,
        request: { class: kind, resourceId, state: 'FAILED', httpStatus: 404 } });
      assert.ok(!JSON.stringify(projected).includes('SYNTHETIC')); return true;
    });
    assert.equal(calls.length, count);
  }
});

test('bootstrap unknown transport errors retain only source-owned request class without private error text', async () => {
  await assert.rejects(bootstrapJobMetadata(() => { throw new Error('PRIVATE_URL_TOKEN_RESPONSE'); }, publicEnv, 10), error => {
    const projected = failureProjection(error, 'bootstrap_context');
    assert.deepEqual(projected, { stage: 'bootstrap_context', code: 'unknown_failure', httpStatus: null,
      request: { class: 'JOB_RUN_GET', resourceId: 9, state: 'FAILED', httpStatus: null } });
    assert.ok(!JSON.stringify(projected).includes('PRIVATE')); return true;
  });
});

test('attachment readiness waits for a missed row to become complete without changing the final evidence predicate', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const base = uploadApi(); let pages = 0, waits = 0;
  const result = await verifyChatUpload(async (...args) => {
    const value = await base(...args);
    if (args[0].startsWith('/api/testresult/attachment?')) {
      pages++;
      if (pages === 1) value.content[0].missed = true;
    }
    return value;
  }, uploadContext, uploadSelection, uploadReceipt, { now: () => 0, wait: async ms => { assert.equal(ms, 5000); waits++; } });
  assert.equal(result.verification, 'VERIFIED');
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.attachments, uploadReceipt.attachmentMetadata);
  assert.equal(pages, 2); assert.equal(waits, 1);
  assert.deepEqual(result.attachmentReadiness.map(row => row.missedCount), [1, 0]);
});

test('permanently missed attachments fail at the original poll bound with closed, detached observations', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const base = uploadApi(); let pages = 0, waits = 0;
  await assert.rejects(verifyChatUpload(async (...args) => {
    const value = await base(...args);
    if (args[0].startsWith('/api/testresult/attachment?')) {
      pages++; value.content[0].missed = true; value.content[0].privateData = 'DO_NOT_RETAIN_ATTACHMENT_DATA';
    }
    return value;
  }, uploadContext, uploadSelection, uploadReceipt, { now: () => 0, wait: async ms => { assert.equal(ms, 5000); waits++; } }), error => {
    assert.equal(error.code, 'chat_testops_upload_unverified');
    const projected = failureProjection(error, 'upload_verification');
    assert.equal(projected.verification.phase, 'attachment_readiness');
    assert.equal(projected.verification.firstFailedPredicate, 'attachments_not_missed');
    assert.equal(projected.verification.attachmentReadiness.length, 12);
    assert.ok(projected.verification.attachmentReadiness.every(row => row.missedCount === 1 && row.ready === false));
    assert.ok(!JSON.stringify(projected).includes('DO_NOT_RETAIN'));
    projected.verification.attachmentReadiness[0].missedCount = 999;
    assert.equal(failureProjection(error, 'upload_verification').verification.attachmentReadiness[0].missedCount, 1);
    return true;
  });
  assert.equal(pages, 12); assert.equal(waits, 11);
});

test('attachment readiness cannot extend the original 120 second observation deadline', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const base = uploadApi(); let clock = 0, calls = 0;
  await assert.rejects(verifyChatUpload(async (...args) => {
    calls++; const value = await base(...args);
    if (args[0].startsWith('/api/testresult/attachment?')) value.content[0].missed = true;
    return value;
  }, uploadContext, uploadSelection, uploadReceipt, { now: () => clock, wait: async () => { clock = 120_000; } }), /upload_unverified/);
  assert.equal(calls, 5);
});

test('malformed or inherited attachment rows still fail immediately even when an attachment is missed', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  for (const change of [{ id: '1' }, { id: 0 }, { fromTestCase: true }]) {
    const base = uploadApi(); let pages = 0;
    await assert.rejects(verifyChatUpload(async (...args) => {
      const value = await base(...args);
      if (args[0].startsWith('/api/testresult/attachment?')) { pages++; Object.assign(value.content[0], change, { missed: true }); }
      return value;
    }, uploadContext, uploadSelection, uploadReceipt, { now: () => 0, wait: async () => assert.fail('invalid identity must not wait') }), error => {
      assert.equal(error.code, 'chat_testops_upload_mismatch');
      assert.equal(failureProjection(error, 'upload_verification').verification.phase, 'attachment_page'); return true;
    });
    assert.equal(pages, 1);
  }
});

test('a completed attachment with the wrong byte count never satisfies the final evidence signature', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const base = uploadApi(); let pages = 0;
  await assert.rejects(verifyChatUpload(async (...args) => {
    const value = await base(...args);
    if (args[0].startsWith('/api/testresult/attachment?')) { pages++; value.content[0].contentLength++; }
    return value;
  }, uploadContext, uploadSelection, uploadReceipt, { now: () => 0, wait: async () => {} }), error => {
    assert.equal(error.code, 'chat_testops_upload_unverified');
    const result = failureProjection(error, 'upload_verification');
    assert.equal(result.verification.firstFailedPredicate, 'attachment_signatures_match'); return true;
  });
  assert.equal(pages, 12);
});

test('a null attachment row retains the controlled invalid-ID rejection', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const base = uploadApi();
  await assert.rejects(verifyChatUpload(async (...args) => {
    if (args[0].startsWith('/api/testresult/attachment?')) return { content: [null], totalElements: 1, totalPages: 1 };
    return base(...args);
  }, uploadContext, uploadSelection, uploadReceipt, { now: () => 0, wait: async () => assert.fail('malformed rows must not wait') }), error => {
    assert.equal(error.code, 'chat_testops_upload_mismatch');
    assert.equal(failureProjection(error, 'upload_verification').verification.firstFailedPredicate, 'ids_valid'); return true;
  });
});

test('deadline crossing after a complete attachment GET keeps the exact readiness refusal', async () => {
  const { verifyChatUpload } = await import('./chat-feature-testops-api.mjs');
  const base = uploadApi(); let lastGet = false, reads = 0;
  await assert.rejects(verifyChatUpload(async (...args) => {
    const value = await base(...args);
    if (args[0].startsWith('/api/testresult/attachment?')) lastGet = true;
    return value;
  }, uploadContext, uploadSelection, uploadReceipt, { now: () => lastGet && ++reads >= 2 ? 120_000 : 0,
    wait: async () => assert.fail('expired observation must not wait') }), error => {
    assert.equal(error.code, 'chat_testops_upload_unverified');
    const projected = failureProjection(error, 'upload_verification');
    assert.equal(projected.verification.firstFailedPredicate, 'attachments_ready');
    assert.equal(projected.verification.attachmentReadiness[0].withinDeadline, false); return true;
  });
});
