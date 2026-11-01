import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, targetSha, planName } from './chat-completion-testops-contract.mjs';
import { validatePilotSelection, verifyPilotUpload, bootstrapPilotPlan, completePilotRegistration, launchPilotPlan } from './chat-completion-testops-api.mjs';

const selected = cases.map((row, i) => ({ ...row, caseId: 100 + i }));
const context = { runId: '123', attempt: '1', workflowSha: 'a'.repeat(40), targetSha, operation: 'evaluate' };
const binding = { planId: 10, jobId: 11, integrationId: 2, cases: selected };
const env = { ALLURE_JOB_RUN_ID: '77', CHAT_COMPLETION_TESTOPS_BINDING: JSON.stringify(binding) };
const selection = { schema: 'paperclip.chat-completion-testops-selection/v1', ...context, projectId: 1,
  planId: 10, jobId: 11, allureJobRunId: '77', launchId: 12, cases: selected };
const runUrl = 'https://github.com/paperclipai/paperclip/actions/runs/123';
const plan = { id: 10, name: 'Chat completion pilot — OpenCode 1017', projectId: 1, testCasesCount: 3,
  treeSelection: { inverted: false, leafsInclude: selected.map(row => row.caseId) } };
const job = { id: 11, type: 'github', url: 'https://github.com/paperclipai/paperclip/actions/workflows/chat-completion-testops.yml' };
const jobrun = { id: 77, job, launchId: 12, stage: 'in_progress', url: runUrl };
const attachment = { id: 900, name: 'Execution provenance and checks', contentType: 'application/json', contentLength: 100,
  missed: false, fromTestCase: false };
const screenshot = { ...attachment, id: 901, name: 'Private evidence receipt', contentType: 'application/json', contentLength: 1000 };
const exported = selected.map(row => ({ caseId: row.caseId, executionId: row.executionId, status: 'passed', cleanup: 'passed',
  attachments: [attachment, screenshot].map(({ id, missed, fromTestCase, ...rest }) => rest) }));

// Observed TestOps job-definition carrier: Branch/defaultValue. This is
// distinct from the id/value carrier accepted by plan runtime overrides.
const branchDefinition = { id: 34, name: 'Branch', defaultValue: 'refs/heads/master' };
function mutationApi({ parameters = [branchDefinition], assignments = [], existingLaunch = false, uncertain = false } = {}) {
  const calls = [], current = { ...job, parameters: structuredClone(parameters) };
  let assigned = structuredClone(assignments);
  const api = async (route, method = 'GET', body) => {
    calls.push({ route, method, body });
    if (route === '/api/jobrun/77') return { ...jobrun, stage: 'finished' };
    if (route === '/api/launch/12') return { id: 12, projectId: 1 };
    if (route === '/api/testplan/10') return plan;
    if (route === '/api/job/11') {
      if (method === 'PATCH') {
        assert.deepEqual(body, { integrationId: 2, canRun: true });
        current.canRun = true;
      }
      return structuredClone(current);
    }
    if (route === '/api/testplan/10/job') return structuredClone(assigned);
    if (route === '/api/testplan/10/assign') {
      assert.equal(method, 'POST');
      assert.deepEqual(body, { jobId: 11, selection: { inverted: false, manual: false, leafsInclude: [100, 101, 102] } });
      assigned = [{ job: structuredClone(current), testCasesCount: 3 }]; return null;
    }
    const selectedCase = selected.find(row => route === `/api/testcase/${row.caseId}`);
    if (selectedCase) return { ...selectedCase, id: selectedCase.caseId, projectId: 1, automated: true };
    if (route.startsWith('/api/launch?')) return { content: existingLaunch ? [{ id: 13 }] : [], totalPages: existingLaunch ? 1 : 0 };
    if (route === '/api/testplan/10/run') {
      assert.equal(method, 'POST');
      if (uncertain) throw new Error('uncertain transport');
      return { id: 13, projectId: 1, name: body.launchName };
    }
    assert.fail(route);
  };
  return { api, calls, current };
}
const prepared = { planId: 10, integrationId: 2, cases: selected };
const official = { jobRunId: '77', launchId: 12 };
const operatorEnv = { CHAT_COMPLETION_TESTOPS_BINDING: JSON.stringify(binding), GITHUB_RUN_NUMBER: '5',
  CHAT_COMPLETION_TESTOPS_LAUNCH_RUN_NUMBER: '5', CHAT_COMPLETION_TESTOPS_LAUNCH_NONCE: 'ab'.repeat(16) };

test('registration preserves the observed Branch definition and binds only the owned three-case job', async () => {
  const f = mutationApi(), markers = [];
  const receipt = await completePilotRegistration(f.api, prepared, official, context, 999, async stage => markers.push(stage));
  assert.deepEqual(receipt.binding.cases, selected);
  assert.deepEqual(f.current.parameters, [branchDefinition]);
  assert.deepEqual(markers, ['bind_owned_job', 'assign_plan']);
  assert.deepEqual(f.calls.filter(row => row.method !== 'GET').map(row => row.route), ['/api/job/11', '/api/testplan/10/assign']);
});

for (const parameters of [[], [branchDefinition, { id: 35, name: 'operation', defaultValue: 'bootstrap' }], [{ id: 34, value: 'refs/heads/master' }]]) {
  test(`registration rejects unreviewed parameter carrier/count ${JSON.stringify(parameters)} before writes`, async () => {
    const f = mutationApi({ parameters });
    await assert.rejects(completePilotRegistration(f.api, prepared, official, context, 999, async () => assert.fail('no mutation marker')));
    assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
  });
}

for (const assignments of [[{ job: { id: 99 }, testCasesCount: 3 }], [{ job, testCasesCount: 2 }], [{ job, testCasesCount: 3 }, { job, testCasesCount: 3 }]]) {
  test('registration rejects ambiguous assignments before writes', async () => {
    const f = mutationApi({ assignments });
    await assert.rejects(completePilotRegistration(f.api, prepared, official, context, 999, async () => assert.fail('no mutation marker')));
    assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
  });
}

test('registration keeps an existing exact assignment without assigning it twice', async () => {
  const f = mutationApi({ assignments: [{ job: { ...job, parameters: [branchDefinition] }, testCasesCount: 3 }] });
  await completePilotRegistration(f.api, prepared, official, context, 999, async () => {});
  assert.equal(f.calls.filter(row => row.route.endsWith('/assign')).length, 0);
});

test('bootstrap retains a closed observation before rejecting an unknown parameter shape', async () => {
  const f = mutationApi({ parameters: [{ id: 34, name: 'PRIVATE_NAME', defaultValue: 'PRIVATE_DEFAULT', value: 'PRIVATE_VALUE' }] });
  let observed;
  await assert.rejects(completePilotRegistration(f.api, prepared, official, context, 999, async () => assert.fail('no mutation marker'), async value => { observed = value; }));
  assert.equal(observed.qualification, 'inspection_only'); assert.equal(observed.jobId, 11);
  assert.equal(observed.parameters[0].runtimeValuePresent, true);
  assert.ok(!JSON.stringify(observed).includes('PRIVATE_'));
  assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
});

test('the fenced launcher requests one exact three-case TestOps launch', async () => {
  const f = mutationApi({ assignments: [{ job, testCasesCount: 3 }] }), markers = [];
  const receipt = await launchPilotPlan(f.api, operatorEnv, context, 999, async stage => markers.push(stage));
  assert.deepEqual(receipt.caseIds, [100, 101, 102]); assert.deepEqual(markers, ['launch_plan']);
  assert.deepEqual(f.calls.filter(row => row.method !== 'GET'), [{ route: '/api/testplan/10/run', method: 'POST', body: {
    launchName: `${planName} · ${operatorEnv.CHAT_COMPLETION_TESTOPS_LAUNCH_NONCE}` } }]);
});

for (const changed of [{ GITHUB_RUN_NUMBER: '6' }, { CHAT_COMPLETION_TESTOPS_LAUNCH_NONCE: 'not-a-nonce' }, { CHAT_COMPLETION_TESTOPS_LAUNCH_RUN_NUMBER: '' }]) {
  test(`launcher rejects its invalid fence before requests: ${Object.keys(changed)[0]}`, async () => {
    const f = mutationApi();
    await assert.rejects(launchPilotPlan(f.api, { ...operatorEnv, ...changed }, context, 999, async () => assert.fail('no marker')));
    assert.equal(f.calls.length, 0);
  });
}

test('launcher reconciles an existing nonce without requesting a second launch', async () => {
  const f = mutationApi({ assignments: [{ job, testCasesCount: 3 }], existingLaunch: true });
  await assert.rejects(launchPilotPlan(f.api, operatorEnv, context, 999, async () => assert.fail('no marker')));
  assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
});

for (const assignments of [[], [{ job: { id: 99 }, testCasesCount: 3 }], [{ job, testCasesCount: 2 }]]) {
  test('launcher rejects an unbound or mismatched assignment without requesting work', async () => {
    const f = mutationApi({ assignments });
    await assert.rejects(launchPilotPlan(f.api, operatorEnv, context, 999, async () => assert.fail('no mutation marker')));
    assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
  });
}

test('launcher rejects a changed default branch before requesting work', async () => {
  const f = mutationApi({ assignments: [{ job, testCasesCount: 3 }], parameters: [{ ...branchDefinition, defaultValue: 'refs/heads/candidate' }] });
  await assert.rejects(launchPilotPlan(f.api, operatorEnv, context, 999, async () => assert.fail('no mutation marker')));
  assert.equal(f.calls.filter(row => row.method !== 'GET').length, 0);
});

test('an uncertain launch response is never automatically resent', async () => {
  const f = mutationApi({ assignments: [{ job, testCasesCount: 3 }], uncertain: true }), seen = new Set();
  const mark = async stage => { if (seen.has(stage)) throw new Error('already attempted'); seen.add(stage); };
  await assert.rejects(launchPilotPlan(f.api, operatorEnv, context, 999, mark), /uncertain transport/);
  await assert.rejects(launchPilotPlan(f.api, operatorEnv, context, 999, mark), /already attempted/);
  assert.equal(f.calls.filter(row => row.method === 'POST').length, 1);
});

test('registration creates only the three missing cases and the dedicated plan after once markers', async () => {
  const calls = []; let nextCase = 100;
  const get = async (route, method = 'GET', body) => {
    calls.push({ route, method, body });
    if (route === '/api/integration/2/project/1') return { id: 2, projectId: 1, info: { type: 'github' }, disabled: false };
    if (route.startsWith('/api/testcase?')) return { content: [], number: 0, totalPages: 0, totalElements: 0 };
    if (route.startsWith('/api/testplan?')) return { content: [], totalPages: 0 };
    if (route === '/api/testcase' && method === 'POST') return { ...body, id: nextCase++ };
    if (route === '/api/testplan' && method === 'POST') return { ...plan, name: planName };
    if (route === '/api/testplan/10') return plan;
    assert.fail(route);
  };
  const value = await bootstrapPilotPlan(get, 2, async stage => calls.push({ marker: stage }));
  assert.equal(value.cases.length, 3); assert.equal(value.planId, 10);
  assert.equal(calls.filter(row => row.method === 'POST').length, 4);
  for (const [i, row] of calls.entries()) if (row.method === 'POST') assert.ok(calls[i - 1].marker);
});

test('uncertain case creation is never automatically resent', async () => {
  let writes = 0, markers = 0;
  const get = async (route, method = 'GET') => {
    if (method === 'POST') { writes++; throw new Error('uncertain transport'); }
    if (route === '/api/integration/2/project/1') return { id: 2, projectId: 1, info: { type: 'github' }, disabled: false };
    if (route.startsWith('/api/testcase?')) return { content: [], number: 0, totalPages: 0, totalElements: 0 };
    if (route.startsWith('/api/testplan?')) return { content: [], totalPages: 0 };
    assert.fail(route);
  };
  await assert.rejects(bootstrapPilotPlan(get, 2, async () => { markers++; }), /uncertain transport/);
  assert.equal(writes, 1); assert.equal(markers, 1);
});

function api(replace = {}) {
  const fixtures = {
    '/api/testplan/10': plan, '/api/testplan/10/job': [{ job, testCasesCount: 3 }], '/api/job/11': job,
    '/api/jobrun/77': jobrun, '/api/launch/12': { id: 12, projectId: 1, closed: false },
    '/api/jobrun/77/plan?expected=true': selected.map(row => ({ id: row.caseId, selector: row.fullName })),
    '/api/testresult?launchId=12&page=0&size=100': { content: selected.map((row, i) => ({ id: 200 + i, testCaseId: row.caseId })), totalElements: 3, totalPages: 1 },
  };
  for (const [i, row] of selected.entries()) {
    fixtures[`/api/testcase/${row.caseId}`] = { id: row.caseId, fullName: row.fullName, projectId: 1, automated: true };
    fixtures[`/api/testresult/${200 + i}`] = { id: 200 + i, testCaseId: row.caseId, fullName: row.fullName,
      projectId: 1, launchId: 12, status: 'passed', links: [], jobRun: { id: 77, launchId: 12, url: runUrl, job } };
    fixtures[`/api/testresult/attachment?testResultId=${200 + i}&page=0&size=100`] = { content: [attachment, screenshot], totalElements: 2, totalPages: 1 };
  }
  return async (route, method = 'GET') => {
    assert.equal(method, 'GET'); assert.ok(Object.hasOwn(fixtures, route), route);
    return typeof replace[route] === 'function' ? replace[route]() : structuredClone(replace[route] ?? fixtures[route]);
  };
}

test('validates actual registered plan, job run and all three selected case identities', async () => {
  const value = await validatePilotSelection(api(), env, context, 999);
  assert.deepEqual(value.cases.map(row => row.executionId), cases.map(row => row.executionId));
  assert.equal(value.targetSha, targetSha);
});

test('a genuine one-case selection executes only that case', async () => {
  const value = await validatePilotSelection(api({ '/api/jobrun/77/plan?expected=true': [{ id: selected[2].caseId, selector: selected[2].fullName }] }), env, context, 999);
  assert.deepEqual(value.cases.map(row => row.key), ['work']);
});

for (const kind of ['foreign-case', 'wrong-selector', 'duplicate-case', 'wrong-workflow', 'foreign-project', 'wrong-jobrun', 'wrong-plan-job']) {
  test(`stops ${kind} before any provider work`, async () => {
    const replacements = {};
    if (kind === 'foreign-case') replacements['/api/jobrun/77/plan?expected=true'] = [{ id: 999, selector: selected[0].fullName }];
    if (kind === 'wrong-selector') replacements['/api/jobrun/77/plan?expected=true'] = [{ id: 100, selector: selected[1].fullName }];
    if (kind === 'duplicate-case') replacements['/api/jobrun/77/plan?expected=true'] = [{ id: 100, selector: selected[0].fullName }, { id: 100, selector: selected[0].fullName }];
    if (kind === 'wrong-workflow') replacements['/api/job/11'] = { ...job, url: job.url.replace('chat-completion', 'foreign') };
    if (kind === 'foreign-project') replacements['/api/launch/12'] = { id: 12, projectId: 2 };
    if (kind === 'wrong-jobrun') replacements['/api/jobrun/77'] = { ...jobrun, url: runUrl + '4' };
    if (kind === 'wrong-plan-job') replacements['/api/testplan/10/job'] = [{ job: { id: 12 }, testCasesCount: 3 }];
    await assert.rejects(validatePilotSelection(api(replacements), env, context, 999));
  });
}

test('verifies exact results and attachment metadata for all three cases', async () => {
  const value = await verifyPilotUpload(api(), selection, context, exported);
  assert.equal(value.verification, 'VERIFIED'); assert.equal(value.results.length, 3);
  assert.ok(value.results.every(row => row.attachmentsVerified && row.status === 'passed'));
});

test('accepts a finished TestOps job with its original complete results', async () => {
  const value = await verifyPilotUpload(api({ '/api/jobrun/77': { ...jobrun, stage: 'finished' } }), selection, context, exported);
  assert.equal(value.verification, 'VERIFIED');
});
for (const stage of ['cancelled', 'failed', 'scheduled']) {
  test(`never qualifies a ${stage} TestOps job even with all results and attachments`, async () => {
    await assert.rejects(verifyPilotUpload(api({ '/api/jobrun/77': { ...jobrun, stage } }), selection, context, exported));
  });
}

test('waits for an explicitly missing attachment and requires final complete metadata', async () => {
  let polls = 0, slept = 0, clock = 0;
  const get = api({ '/api/testresult/attachment?testResultId=200&page=0&size=100': () => {
    polls++;
    return { content: [{ ...attachment, missed: polls === 1 }, screenshot], totalElements: 2, totalPages: 1 };
  } });
  const value = await verifyPilotUpload(get, selection, context, exported, { now: () => clock, wait: async ms => { slept++; clock += ms; } });
  assert.equal(value.verification, 'VERIFIED'); assert.equal(polls, 2); assert.equal(slept, 1);
});

test('permanently missing or inherited attachments never qualify', async () => {
  for (const field of ['missed', 'fromTestCase']) {
    let clock = 0;
    const get = api({ '/api/testresult/attachment?testResultId=200&page=0&size=100': { content: [{ ...attachment, [field]: true }, screenshot], totalElements: 2, totalPages: 1 } });
    await assert.rejects(verifyPilotUpload(get, selection, context, exported, { now: () => clock, wait: async ms => { clock += ms; } }));
    assert.ok(clock < 120_000);
  }
});

for (const kind of ['wrong-case', 'wrong-source-run', 'wrong-status', 'foreign-result', 'duplicate-result', 'extra-result', 'foreign-embedded-job', 'foreign-source-link']) {
  test(`preserves failure for ${kind} during server result readback`, async () => {
    const replacements = {};
    if (kind === 'wrong-case') replacements['/api/testresult/200'] = { id: 200, testCaseId: 999 };
    if (kind === 'wrong-source-run') replacements['/api/jobrun/77'] = { ...jobrun, url: runUrl + '4' };
    if (kind === 'wrong-status') replacements['/api/testresult/200'] = { id: 200, testCaseId: 100, fullName: selected[0].fullName,
      projectId: 1, launchId: 12, status: 'failed', links: [], jobRun: { id: 77, launchId: 12, url: runUrl, job } };
    if (kind === 'foreign-embedded-job' || kind === 'foreign-source-link') replacements['/api/testresult/200'] = {
      id: 200, testCaseId: 100, fullName: selected[0].fullName, projectId: 1, launchId: 12, status: 'passed',
      links: kind === 'foreign-source-link' ? [{ url: 'https://github.com/paperclipai/paperclip/commit/' + 'b'.repeat(40) }] : [],
      jobRun: { id: 77, launchId: 12, url: runUrl, job: kind === 'foreign-embedded-job' ? { ...job, type: 'foreign' } : job } };
    if (kind === 'foreign-result') replacements['/api/testresult?launchId=12&page=0&size=100'] = { content: [{ id: 999, testCaseId: 999 }], totalElements: 1, totalPages: 1 };
    if (kind === 'duplicate-result') replacements['/api/testresult?launchId=12&page=0&size=100'] = { content: [{ id: 200, testCaseId: 100 }, { id: 200, testCaseId: 100 }], totalElements: 2, totalPages: 1 };
    if (kind === 'extra-result') replacements['/api/testresult?launchId=12&page=0&size=100'] = { content: selected.map((row, i) => ({ id: 200 + i, testCaseId: row.caseId })).concat({ id: 999, testCaseId: 999 }), totalElements: 4, totalPages: 1 };
    await assert.rejects(verifyPilotUpload(api(replacements), selection, context, exported));
  });
}
