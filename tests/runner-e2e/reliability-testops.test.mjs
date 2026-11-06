import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { productRegressionCases, projectProductResults, selectProductRegression, testOpsPlanDetails, testOpsPlans,
  validateSelection, workflowUrl } from './product-regression-testops.mjs';
import { productTestOps } from './product-regression-testops-cli.mjs';
import { registeredReliabilityCases, reliabilityDefinitions, reliabilityModel, reliabilityPlanName, reliabilityProfile,
  reliabilityRegistration } from './reliability-testops.mjs';
import { admitRegistration, inspectReliability, registerReliability, registrationReceipt, registrationSnippet,
  registrationWorkflowRef } from './reliability-testops-registration.mjs';

// Synthetic identities exercise the bound path only. Real IDs come from TestOps.
const synthetic = { planId: 9001, caseIds: Object.fromEntries(reliabilityDefinitions.map((row, index) => [row.name, 9101 + index])) };
const plans = testOpsPlans(synthetic);
const cases = plans.reliability;
const workflowSha = 'a'.repeat(40), targetSha = 'b'.repeat(40);
const env = {
  GITHUB_REPOSITORY: 'paperclipai/paperclip', GITHUB_REF: 'refs/heads/master', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: workflowSha, SOURCE_SHA: targetSha,
  ALLURE_ENDPOINT: 'https://paperclip.testops.cloud', ALLURE_PROJECT_ID: '1',
};
const selection = selected => ({ schema: 'paperclip.product-regression-testops-selection/v1', runId: '123', attempt: '1',
  workflowSha, targetSha, jobRunId: '456', launchId: 789, cases: selected });
const result = (row, overrides = {}) => ({
  executionId: row.executionId, suiteId: row.suite, caseId: row.name, profileId: row.profile, environmentId: row.environment,
  source: { sha: targetSha }, attempt: 1, status: 'passed', cleanup: 'passed', model: row.model,
  matcherResults: [{ matcher: { kind: 'json_path', path: 'resume.retry-works-first-use', expected: true }, passed: true }], ...overrides,
});
const campaign = (selected, results) => ({ schema: 'paperclip.runner-e2e.campaign/v2', campaignId: 'gha-123-1',
  source: { sha: targetSha }, expected: selected.map(row => row.executionId), results });

test('the plan is six DeepSeek 1017 cells plus native Codex for steering, Daytona only for sandbox signatures', () => {
  assert.equal(reliabilityDefinitions.length, 7);
  assert.equal(new Set(reliabilityDefinitions.map(row => row.executionId)).size, 7);
  assert.ok(reliabilityDefinitions.every(row => row.fullName === `paperclip.Product E2E.everyday-workflows.${row.name}`));
  // OpenCode declares steering: false, so only queue-steer uses the steering-capable native Codex cell.
  assert.deepEqual(reliabilityDefinitions.filter(row => row.profile !== reliabilityProfile || row.model !== reliabilityModel)
    .map(row => [row.name, row.profile, row.model, row.environment]), [['queue-steer', 'runner-codex', 'gpt-5.6-sol', 'daytona']]);
  assert.deepEqual(reliabilityDefinitions.filter(row => row.profile === reliabilityProfile && row.environment === 'daytona').map(row => row.name),
    ['three-turn-revise', 'long-silent-command', 'queued-across-restart']);
  assert.equal(testOpsPlanDetails.reliability.size, 7);
  assert.equal(testOpsPlanDetails['product-regression'].size, 20);
});

test('the committed registration is either absent or complete, and selection fails closed until it exists', () => {
  const committed = registeredReliabilityCases(reliabilityRegistration, productRegressionCases.map(row => row.id));
  if (committed === null) {
    assert.equal(testOpsPlans().reliability, null);
    assert.throws(() => selectProductRegression(undefined, 'all', false, 'reliability'), /product_regression_testops_reliability_unregistered/);
    assert.throws(() => selectProductRegression(undefined, 'queue-steer', false, 'reliability'), /reliability_unregistered/);
  } else {
    assert.equal(committed.length, 7);
    assert.equal(selectProductRegression(undefined, 'all', false, 'reliability').length, 7);
  }
  // Plan 2 keeps its exact standing bootstrap behavior.
  assert.equal(selectProductRegression(undefined, 'all').length, 20);
  assert.equal(selectProductRegression(undefined, '66')[0].name, 'message-marker');
});

test('a partial, duplicate, foreign or plan-2 registration is rejected rather than selecting a subset', () => {
  const reserved = productRegressionCases.map(row => row.id);
  const { 'queue-steer': _omitted, ...partial } = synthetic.caseIds;
  for (const invalid of [{ ...synthetic, planId: null }, { ...synthetic, planId: 2 }, { ...synthetic, caseIds: partial },
    { ...synthetic, caseIds: { ...synthetic.caseIds, 'queue-steer': synthetic.caseIds['reassign-midrun'] } },
    { ...synthetic, caseIds: { ...synthetic.caseIds, 'queue-steer': 66 } },
    { ...synthetic, caseIds: { ...synthetic.caseIds, 'queue-steer': '9105' } },
    { ...synthetic, caseIds: { ...synthetic.caseIds, unknown: 1 } }]) {
    assert.throws(() => registeredReliabilityCases(invalid, reserved), /reliability_registration_invalid/);
  }
  assert.equal(registeredReliabilityCases({ planId: null, caseIds: {} }, reserved), null);
});

test('a TestOps launch selects one plan by its case identities and never mixes the plans', () => {
  const all = { version: '1.0', tests: cases.map(row => ({ id: String(row.id), selector: row.fullName })) };
  assert.deepEqual(selectProductRegression(all, 'all', true, 'product-regression', plans).map(row => row.name),
    reliabilityDefinitions.map(row => row.name));
  const subset = { version: '1.0', tests: [{ id: String(cases[5].id), selector: cases[5].fullName }] };
  assert.deepEqual(selectProductRegression(subset, 'all', true, 'product-regression', plans), [cases[5]]);
  const plan2 = productRegressionCases[0];
  assert.throws(() => selectProductRegression({ version: '1.0', tests: [...subset.tests, { id: String(plan2.id), selector: plan2.fullName }] },
    'all', true, 'product-regression', plans), /plan_mixed/);
  assert.throws(() => selectProductRegression({ version: '1.0', tests: [{ id: String(cases[0].id), selector: cases[1].fullName }] },
    'all', true, 'product-regression', plans), /case_mismatch/);
  // Without the reviewed identities, a TestOps reliability launch cannot bind any case.
  assert.throws(() => selectProductRegression(subset, 'all', true, 'product-regression', testOpsPlans({ planId: null, caseIds: {} })), /case_mismatch/);
  assert.throws(() => selectProductRegression(undefined, 'all', false, 'unknown', plans), /plan_invalid/);
  assert.equal(selectProductRegression(undefined, 'long-silent-command', false, 'reliability', plans)[0].environment, 'daytona');
  validateSelection(selection(cases), env, plans);
  assert.throws(() => validateSelection(selection(cases), env, testOpsPlans({ planId: null, caseIds: {} })));
});

test('projection keeps each cell environment, a seven-case denominator and the original verdicts', () => {
  const projected = projectProductResults(campaign(cases, cases.map(row => result(row))), selection(cases), targetSha);
  assert.deepEqual({ ...projected.summary, cases: undefined },
    { selected: 7, passed: 7, failed: 0, broken: 0, plan: 'reliability', fullPlan: true, cases: undefined });
  const daytona = cases.find(row => row.name === 'queued-across-restart');
  const records = projected.records.filter(row => row.file.endsWith('-result.json')).map(row => row.value);
  const restart = records.find(row => row.name === 'queued-across-restart');
  assert.equal(restart.parameters.find(row => row.name === 'environment').value, 'daytona / GitHub Actions');
  assert.ok(restart.labels.some(row => row.name === 'tag' && row.value === 'soak-S55/U9'));
  assert.equal(restart.labels.find(row => row.name === 'AS_ID').value, String(daytona.id));
  const attachments = projected.records.filter(row => !row.file.endsWith('-result.json')).map(row => row.value);
  assert.equal(attachments.find(row => row.executionId === daytona.executionId).environment, 'daytona');
  // The environment is part of the binding: a local result cannot stand in for a Daytona cell.
  assert.throws(() => projectProductResults(campaign([daytona], [result(daytona, { environmentId: 'local' })]), selection([daytona]), targetSha),
    /result_binding/);
  for (const [failureClass, status] of [['candidate_failure', 'failed'], ['provider_variance', 'failed'], ['transient_infrastructure', 'broken']]) {
    const row = projectProductResults(campaign([daytona], [result(daytona, { status: 'failed', failureClass })]), selection([daytona]), targetSha);
    assert.equal(row.summary.cases[0].status, status);
    assert.equal(row.summary.fullPlan, false);
  }
  const missing = projectProductResults(undefined, selection(cases), targetSha);
  assert.equal(missing.summary.broken, 7);
  assert.throws(() => projectProductResults(campaign([daytona], [result(daytona, { model: 'gpt-5.6-sol' })]), selection([daytona]), targetSha),
    /metadata_invalid/);
  assert.throws(() => projectProductResults(campaign(cases, []), selection([...cases, productRegressionCases[0]]), targetSha),
    /selection_binding/);
});

test('a manual reliability bootstrap fails before opening any TestOps run until registration exists', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reliability-testops-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = { ...env, RUNNER_TEMP: root, GITHUB_OUTPUT: path.join(root, 'output'), ALLURE_TOKEN: 'synthetic-test-token',
    TESTOPS_PLAN: 'reliability', TESTOPS_CASE: 'all', ALLURE_JOB_RUN_ID: '' };
  let opened = false;
  const exec = async () => { opened = true; return { stdout: '' }; };
  const fetchImpl = async () => { opened = true; throw new Error('unexpected network'); };
  await assert.rejects(productTestOps('select', path.join(root, 'selection.json'), runtime, exec, fetchImpl, undefined,
    testOpsPlans({ planId: null, caseIds: {} })), /reliability_unregistered/);
  await assert.rejects(productTestOps('select', path.join(root, 'selection.json'), { ...runtime, TESTOPS_PLAN: 'unknown' }, exec, fetchImpl),
    /plan_invalid/);
  assert.equal(opened, false);
});

test('a TestOps reliability launch binds, projects and verifies through the standing plan path', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reliability-testops-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selectionFile = path.join(root, 'selection.json');
  const runtime = { ...env, RUNNER_TEMP: root, GITHUB_OUTPUT: path.join(root, 'output'), GITHUB_STEP_SUMMARY: path.join(root, 'summary'),
    ALLURE_JOB_RUN_ID: '456', ALLURE_TOKEN: 'synthetic-test-token', TESTOPS_CASE: '', TESTOPS_PLAN: 'product-regression',
    REPORT_DIR: path.join(root, 'report'), ALLURE_RESULTS: path.join(root, 'allure'), EXPORT_SUMMARY: path.join(root, 'export.json') };
  const uploaded = cases.map((row, index) => ({ id: 600 + index, testCaseId: row.id, fullName: row.fullName, projectId: 1,
    launchId: 789, jobRun: { id: 456 }, status: 'passed' }));
  const fetchImpl = async url => {
    const route = new URL(url).pathname;
    const resources = {
      '/api/uaa/oauth/token': { access_token: 'synthetic-access-token' },
      '/api/jobrun/456': { id: 456, launchId: 789, job: { id: 50, type: 'github' }, url: 'https://github.com/paperclipai/paperclip/actions/runs/123' },
      '/api/job/50': { id: 50, type: 'github', url: workflowUrl }, '/api/launch/789': { id: 789, projectId: 1 },
      '/api/testresult': { content: uploaded.map(row => ({ id: row.id, testCaseId: row.testCaseId })), totalPages: 1, totalElements: uploaded.length },
      ...Object.fromEntries(uploaded.map(row => [`/api/testresult/${row.id}`, row])),
    };
    assert.ok(resources[route], route);
    return new Response(JSON.stringify(resources[route]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const exec = async (command, args) => {
    if (args[1] === 'env') return { stdout: 'ALLURE_JOB_RUN_ID=456\nALLURE_LAUNCH_ID=789\n' };
    if (args[1] === 'plan') await writeFile(args.at(-1), JSON.stringify({ version: '1.0', tests: cases.map(row => ({ id: String(row.id), selector: row.fullName })) }));
    return { stdout: '' };
  };
  assert.equal(await productTestOps('select', selectionFile, runtime, exec, fetchImpl, undefined, plans), 0);
  const output = await readFile(runtime.GITHUB_OUTPUT, 'utf8');
  assert.match(output, new RegExp(`ids=${cases.map(row => row.executionId.replaceAll('.', '\\.')).join(',')}\\n`));
  runtime.SELECTION_SHA256 = output.match(/selection_sha256=([a-f0-9]{64})/)[1];
  await mkdir(path.join(runtime.REPORT_DIR, 'normalized'), { recursive: true });
  await writeFile(path.join(runtime.REPORT_DIR, 'normalized', 'normalized-results.json'), JSON.stringify(campaign(cases, cases.map(row => result(row)))));
  assert.equal(await productTestOps('project', selectionFile, runtime, exec, fetchImpl, undefined, plans), 0);
  assert.match(await readFile(runtime.GITHUB_STEP_SUMMARY, 'utf8'), /Reliability TestOps results.*\n\n7\/7 passed.*Complete 7-case plan selection/);
  assert.equal(await productTestOps('verify', selectionFile, runtime, exec, fetchImpl, async () => {}, plans), 0);
  // The committed (unregistered) mapping cannot validate a selection bound with other identities.
  if (testOpsPlans().reliability === null) {
    await assert.rejects(productTestOps('project', selectionFile, { ...runtime, ALLURE_RESULTS: path.join(root, 'other'),
      EXPORT_SUMMARY: path.join(root, 'other.json') }, exec, fetchImpl), /case_mismatch/);
  }
});

function fakeTestOps({ existing = [], plan = null, assignments = [], standing = [{ job: { id: 50, type: 'github', url: workflowUrl, parameters: [] }, testCasesCount: 20 }] } = {}) {
  const state = { cases: new Map([[66, { id: 66, projectId: 1, fullName: productRegressionCases.find(row => row.id === 66).fullName }],
    ...existing.map(row => [row.id, { projectId: 1, automated: true, ...row }])]), plan, assignments, calls: [], nextId: 9500 };
  const api = async (route, method = 'GET', body) => {
    state.calls.push({ route, method, body });
    const url = new URL(`https://paperclip.testops.cloud${route}`);
    if (method === 'GET' && url.pathname === '/api/testcase') {
      const rows = [...state.cases.keys()].sort((a, b) => a - b).map(id => ({ id }));
      return { content: rows, number: 0, totalPages: 1, totalElements: rows.length };
    }
    const caseMatch = /^\/api\/testcase\/(\d+)$/.exec(url.pathname);
    if (method === 'GET' && caseMatch) return state.cases.get(Number(caseMatch[1]));
    if (method === 'POST' && url.pathname === '/api/testcase') {
      const id = state.nextId++; state.cases.set(id, { id, ...body }); return { id };
    }
    if (method === 'GET' && url.pathname === '/api/testplan') return { content: state.plan ? [{ id: state.plan.id, name: state.plan.name }] : [], totalPages: 1 };
    if (method === 'POST' && url.pathname === '/api/testplan') {
      state.plan = { id: 77, projectId: 1, name: body.name, treeSelection: body.treeSelection, testCasesCount: body.treeSelection.leafsInclude.length };
      // Live TestOps lists a new plan's uncovered cases as one job-less row.
      state.assignments = [{ testCasesCount: body.treeSelection.leafsInclude.length }];
      return { id: 77 };
    }
    if (method === 'GET' && url.pathname === '/api/testplan/77') return state.plan;
    if (method === 'PATCH' && url.pathname === '/api/testplan/77') {
      state.plan = { ...state.plan, treeSelection: body.treeSelection, testCasesCount: body.treeSelection.leafsInclude.length }; return null;
    }
    if (method === 'POST' && url.pathname === '/api/testplan/77/jobparameter') {
      state.assignments = state.assignments.map(row => row.job.id === body.jobId ? { ...row, job: { ...row.job, parameters: body.parameters } } : row);
      return null;
    }
    if (method === 'GET' && url.pathname === '/api/testplan/2/job') return standing;
    if (method === 'GET' && url.pathname === '/api/job/50') return { id: 50, type: 'github', url: workflowUrl };
    if (method === 'GET' && url.pathname === '/api/testplan/77/job') return state.assignments;
    if (method === 'POST' && url.pathname === '/api/testplan/77/assign') {
      state.assignments = [{ job: { id: body.jobId, parameters: [] }, testCasesCount: body.selection.leafsInclude.length }]; return null;
    }
    throw new Error(`unexpected ${method} ${route}`);
  };
  return { api, state };
}

test('registration is admitted only from the trusted dispatch and reads before it writes', async () => {
  const admitted = { ...env, GITHUB_WORKFLOW_REF: registrationWorkflowRef, REGISTRATION_PLAN: 'reliability', REGISTRATION_OPERATION: 'inspect' };
  assert.equal(admitRegistration(admitted), 'inspect');
  for (const mutation of [{ GITHUB_REF: 'refs/heads/candidate' }, { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF }, { ALLURE_ENDPOINT: 'https://attacker.invalid' },
    { REGISTRATION_OPERATION: 'delete' }, { REGISTRATION_PLAN: 'product-regression' }]) {
    assert.throws(() => admitRegistration({ ...admitted, ...mutation }), /untrusted_context/);
  }
  const { api, state } = fakeTestOps();
  const inspected = await inspectReliability(api);
  assert.deepEqual(inspected.caseIds, {});
  assert.equal(inspected.jobId, 50);
  assert.equal(state.calls.some(row => row.method !== 'GET'), false);
  const receipt = registrationReceipt('inspect', inspected, admitted);
  assert.equal(receipt.complete, false);
  assert.equal(receipt.missing.length, 7);
});

test('registration creates only missing cases, one plan on the standing job, and is idempotent', async () => {
  const reused = reliabilityDefinitions[0];
  const { api, state } = fakeTestOps({ existing: [{ id: 300, fullName: reused.fullName }] });
  const first = await registerReliability(api);
  assert.equal(first.caseIds[reused.name], 300);
  assert.deepEqual(first.created.cases, reliabilityDefinitions.slice(1).map(row => row.name));
  assert.equal(first.created.plan, true);
  assert.equal(first.created.assignment, true);
  assert.equal(state.plan.name, reliabilityPlanName);
  assert.deepEqual(state.plan.treeSelection.leafsInclude, reliabilityDefinitions.map(row => first.caseIds[row.name]));
  for (const row of reliabilityDefinitions.slice(1)) {
    const created = state.cases.get(first.caseIds[row.name]);
    assert.equal(created.fullName, row.fullName);
    assert.equal(created.automated, true);
    assert.match(created.description, new RegExp(row.executionId.replaceAll('.', '\\.')));
  }
  const receipt = registrationReceipt('register', first, { GITHUB_RUN_ID: '1', GITHUB_SHA: workflowSha });
  assert.equal(receipt.complete, true);
  assert.equal(registeredReliabilityCases(receipt.registration, productRegressionCases.map(row => row.id)).length, 7);
  assert.match(registrationSnippet(receipt), /planId: 77,\n {2}caseIds: Object\.freeze\(\{\n {4}'interrupt-redirect': 300,/);
  const writes = state.calls.filter(row => row.method !== 'GET').length;
  const second = await registerReliability(api);
  assert.deepEqual(second.caseIds, first.caseIds);
  assert.equal(state.calls.filter(row => row.method !== 'GET').length, writes);
});

test('registration copies the standing plan job parameters and repairs a drifted plan selection once', async () => {
  const parameters = [{ name: 'all', value: 'false' }];
  const { api, state } = fakeTestOps({ standing: [{ job: { id: 50, type: 'github', url: workflowUrl, parameters }, testCasesCount: 20 }] });
  const first = await registerReliability(api);
  assert.equal(first.created.parameters, true);
  assert.deepEqual(state.calls.filter(row => row.route === '/api/testplan/77/jobparameter').map(row => row.body),
    [{ jobId: 50, parameters }]);
  assert.deepEqual(state.assignments[0].job.parameters, parameters);
  const writes = state.calls.filter(row => row.method !== 'GET').length;
  assert.equal((await registerReliability(api)).created.parameters, false);
  assert.equal(state.calls.filter(row => row.method !== 'GET').length, writes);
  // A plan whose selection drifted is patched back to exactly the seven cases.
  state.plan = { ...state.plan, treeSelection: { ...state.plan.treeSelection, leafsInclude: [first.caseIds['queue-steer']] }, testCasesCount: 1 };
  await registerReliability(api);
  assert.deepEqual(state.calls.filter(row => row.method === 'PATCH').map(row => row.route), ['/api/testplan/77']);
  assert.deepEqual(state.plan.treeSelection.leafsInclude, reliabilityDefinitions.map(row => first.caseIds[row.name]));
  // A parameter write that does not read back fails instead of leaving a plan that dispatches differently.
  const stale = fakeTestOps({ standing: [{ job: { id: 50, type: 'github', url: workflowUrl, parameters }, testCasesCount: 20 }] });
  const original = stale.api;
  const ignoringParameters = async (route, method, body) => route.endsWith('/jobparameter') ? null : original(route, method, body);
  await assert.rejects(registerReliability(ignoringParameters), /plan_job/);
});

test('registration refuses a standing plan without exactly one trusted job or a plan bound to another job', async () => {
  await assert.rejects(registerReliability(fakeTestOps({ standing: [] }).api), /standing_job/);
  await assert.rejects(registerReliability(fakeTestOps({ standing: [{ job: { id: 51, type: 'github', url: 'https://github.com/other/repo' } }] }).api), /standing_job/);
  const { api, state } = fakeTestOps();
  await registerReliability(api);
  state.assignments = [{ job: { id: 99 }, testCasesCount: 7 }];
  await assert.rejects(registerReliability(api), /plan_job_conflict/);
});

test('a plan TestOps reports only as a job-less row is unassigned, so registration assigns the standing job', async () => {
  const { api, state } = fakeTestOps();
  await registerReliability(api);
  // Reproduces staging plan 135: created, then the run stopped before assignment.
  state.assignments = [{ testCasesCount: 7 }];
  const inspected = await inspectReliability(api);
  assert.deepEqual(inspected.assignments, []);
  assert.equal(registrationReceipt('inspect', inspected, env).complete, false);
  const repaired = await registerReliability(api);
  assert.equal(repaired.created.assignment, true);
  assert.deepEqual(state.assignments.map(row => row.job?.id), [50]);
  assert.equal(registrationReceipt('register', repaired, { GITHUB_RUN_ID: '1', GITHUB_SHA: workflowSha }).complete, true);
});

test('the workflows expose the reliability plan without new provider or reporting authority', async () => {
  const full = parse(await readFile(new URL('../../.github/workflows/runner-full-stack-e2e.yml', import.meta.url), 'utf8'));
  assert.deepEqual(full.on.workflow_dispatch.inputs.testops_plan.options, ['product-regression', 'reliability']);
  assert.equal(full.on.workflow_dispatch.inputs.testops_plan.default, 'product-regression');
  // Not run per PR or on the bounded cron: only a TestOps launch or manual dispatch selects the plan.
  assert.deepEqual(Object.keys(full.on).sort(), ['schedule', 'workflow_dispatch']);
  const selectionStep = full.jobs.testops_selection.steps.find(step => step.id === 'selection');
  assert.equal(selectionStep.env.TESTOPS_PLAN, "${{ inputs.testops_plan || 'product-regression' }}");
  const testEnv = full.jobs.test.steps.flatMap(step => Object.entries(step.env ?? {}));
  assert.ok(testEnv.some(([name, value]) => name === 'OPENROUTER_API_KEY' && value === "${{ matrix.credentialName == 'OPENROUTER_API_KEY' && secrets.OPENROUTER_API_KEY || '' }}"));
  assert.ok(testEnv.some(([name, value]) => name === 'DAYTONA_API_KEY' && value === "${{ matrix.environmentId == 'daytona' && secrets.DAYTONA_API_KEY || '' }}"));
  const opencodeSteps = full.jobs.test.steps.filter(step => /OpenCode executable|remote provider pack/.test(step.name ?? ''));
  assert.ok(opencodeSteps.length >= 3);
  assert.ok(opencodeSteps.every(step => String(step.if).includes("startsWith(matrix.profileId, 'runner-opencode')")));
  const registration = parse(await readFile(new URL('../../.github/workflows/runner-e2e-testops-registration.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(registration.on), ['workflow_dispatch']);
  assert.equal(registration.jobs.register.environment, 'runner-e2e-testops-reporting');
  assert.deepEqual(registration.jobs.register.needs, 'authorize');
  // The only gate in front of ALLURE_TOKEN: default branch plus the numeric actor allowlist.
  const gate = registration.jobs.authorize.steps[0];
  assert.equal(gate.env.ALLOWED_ACTOR_IDS, '${{ vars.RUNNER_E2E_ALLOWED_ACTOR_IDS }}');
  assert.equal(gate.env.REF, '${{ github.ref }}');
  assert.match(gate.run, /if \[ "\$REF" != "refs\/heads\/\$DEFAULT_BRANCH" \]; then/);
  assert.match(gate.run, /type == "array" and length > 0 and all\(\.\[\]; type == "number"/);
  assert.match(gate.run, /for candidate in "\$triggering_actor_id" "\$ACTOR_ID"; do/);
  assert.equal(registration.jobs.authorize.environment, undefined);
  assert.equal(JSON.stringify(registration.jobs.authorize).includes('secrets.'), false);
  const text = JSON.stringify(registration);
  assert.doesNotMatch(text, /secrets\.(OPENAI|OPENROUTER|ANTHROPIC|DAYTONA)/);
  assert.equal(registration.jobs.register.steps[0].with.ref, '${{ github.sha }}');
});
