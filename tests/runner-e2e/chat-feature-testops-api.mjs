export const endpoint = 'https://paperclip.testops.cloud';
export const planName = 'Chat feature evals';
export const fullName = 'paperclip.Product E2E.chat-features.create-backlog';
export const aliases = [fullName, 'paperclip.Product E2E.chat-features.tasks.create-backlog'];
class SetupFailure extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
const fail = code => {
  const match = /^testops_(api|auth)_http_([1-5][0-9]{2})$/.exec(code);
  throw new SetupFailure(match ? `testops_${match[1]}_http` : code, match ? Number(match[2]) : null);
};
const diagnosticCodes = new Set(['untrusted_chat_testops_context', 'testops_token_missing', 'testops_auth_http',
  'testops_api_http', 'testops_auth_invalid', 'testops_route_invalid', 'testops_response_too_large',
  'testops_response_invalid', 'testops_metadata_page_incomplete', 'testops_case_identity_invalid',
  'testops_case_alias_conflict', 'testops_plan_name_conflict', 'testops_plan_identity_invalid',
  'testops_integration_identity_invalid', 'testops_bootstrap_identity_invalid', 'testops_plan_without_matching_case',
  'testops_created_case_identity_invalid', 'testops_created_plan_identity_invalid', 'testops_plan_scope_mismatch',
  'testops_operation_invalid', 'testops_output_invalid', 'untrusted_public_testops_context', 'chat_testops_identity_missing',
  'chat_testops_case_mismatch', 'chat_testops_plan_mismatch', 'chat_testops_plan_job_mismatch', 'chat_testops_job_mismatch',
  'chat_testops_jobrun_mismatch', 'chat_testops_launch_mismatch', 'chat_testops_selection_mismatch', 'chat_testops_parameter_mismatch', 'chat_testops_nonce_invalid', 'chat_testops_nonce_conflict']);
export function failureProjection(error, stage) {
  const stages = ['context', 'output_admission', 'authentication', 'metadata_inspection', 'plan_bootstrap', 'selection_validation', 'launch_preflight', 'plan_launch', 'bootstrap_job_metadata', 'result_export', 'receipt'];
  return { stage: stages.includes(stage) ? stage : 'unknown',
    code: error instanceof SetupFailure && diagnosticCodes.has(error.code) ? error.code : 'unknown_failure',
    httpStatus: error instanceof SetupFailure && Number.isInteger(error.status) && error.status >= 100 && error.status < 600 ? error.status : null };
}
const id = value => Number.isSafeInteger(value) && value > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function testopsClient(token, fetchImpl = fetch) {
  if (!token) fail('testops_token_missing');
  const auth = await fetchImpl(`${endpoint}/api/uaa/oauth/token`, { method: 'POST', redirect: 'error',
    headers: { Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'apitoken', scope: 'openid', token }),
    signal: AbortSignal.timeout(30_000) });
  if (!auth.ok) fail(`testops_auth_http_${auth.status}`);
  const value = await auth.json();
  if (typeof value.access_token !== 'string' || !value.access_token) fail('testops_auth_invalid');
  return async (route, method = 'GET', body) => {
    if (!route.startsWith('/api/') || route.includes('://')) fail('testops_route_invalid');
    const response = await fetchImpl(`${endpoint}${route}`, { method, redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${value.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) fail(`testops_api_http_${response.status}`);
    if (response.status === 204) return null;
    const text = await response.text();
    if (Buffer.byteLength(text) > 2_000_000) fail('testops_response_too_large');
    try { return JSON.parse(text); } catch { fail('testops_response_invalid'); }
  };
}

const rows = value => {
  if (!Array.isArray(value?.content) || value.content.length > 100 || value.totalPages > 1) fail('testops_metadata_page_incomplete');
  return value.content;
};
export async function inspectChatMetadata(api) {
  const cases = new Map();
  for (const name of aliases) {
    const query = new URLSearchParams({ projectId: '1', rql: `fullName = ${JSON.stringify(name)}`, page: '0', size: '100' });
    for (const value of rows(await api(`/api/testcase/__search?${query}`))) {
      if (!id(value.id) || value.projectId !== 1 || !aliases.includes(value.fullName) || value.deleted === true) fail('testops_case_identity_invalid');
      cases.set(value.id, { id: value.id, fullName: value.fullName, automated: value.automated === true });
    }
  }
  const plans = rows(await api(`/api/testplan?${new URLSearchParams({ projectId: '1', name: planName, page: '0', size: '100' })}`))
    .filter(value => value.name === planName);
  if (plans.length > 1) fail('testops_plan_name_conflict');
  if (plans.some(value => !id(value.id) || value.projectId !== 1)) fail('testops_plan_identity_invalid');
  const integrations = rows(await api('/api/integration/project/1?page=0&size=100'))
    .filter(value => value.info?.type === 'github')
    .map(value => ({ id: value.id, type: 'github', disabled: value.disabled === true }));
  if (integrations.some(value => !id(value.id))) fail('testops_integration_identity_invalid');
  return { projectId: 1, caseConflict: cases.size > 1, cases: [...cases.values()], plans: plans.map(value => ({ id: value.id, name: planName, count: value.testCasesCount })), integrations };
}

export async function ensureChatPlan(api, inspected, markOnce) {
  if (inspected.projectId !== 1 || inspected.plans.length > 1) fail('testops_bootstrap_identity_invalid');
  if (inspected.caseConflict === true || inspected.cases.length > 1) fail('testops_case_alias_conflict');
  let selected = inspected.cases[0], plan = inspected.plans[0];
  if (plan && !selected) fail('testops_plan_without_matching_case');
  if (!selected || !plan) await markOnce();
  if (!selected) {
    const created = await api('/api/testcase', 'POST', { projectId: 1, name: 'Create a task backlog through chat', fullName,
      automated: true, description: 'Canonical scenario: tasks.create-backlog. Readiness and recorded outcomes remain separate.',
      expectedResult: 'The real agent creates the requested backlog; public Product E2E assertions and cleanup must pass.' });
    if (!id(created?.id) || created.projectId !== 1 || created.fullName !== fullName) fail('testops_created_case_identity_invalid');
    selected = { id: created.id, fullName, automated: created.automated === true };
  }
  if (!plan) {
    const created = await api('/api/testplan', 'POST', { projectId: 1, name: planName,
      treeSelection: { inverted: false, leafsInclude: [selected.id] } });
    if (!id(created?.id) || created.projectId !== 1 || created.name !== planName) fail('testops_created_plan_identity_invalid');
    plan = { id: created.id, name: planName };
  }
  const actual = await api(`/api/testplan/${plan.id}`);
  if (actual.projectId !== 1 || actual.name !== planName || actual.testCasesCount !== 1
    || actual.treeSelection?.inverted === true || !same(actual.treeSelection?.leafsInclude, [selected.id])
    || (actual.treeSelection?.groupsInclude?.length ?? 0) > 0 || (actual.treeSelection?.leafsExclude?.length ?? 0) > 0) fail('testops_plan_scope_mismatch');
  return { projectId: 1, case: selected, plan: { id: plan.id, name: planName, count: 1 },
    caseUrl: `${endpoint}/project/1/test-cases/${selected.id}`, planUrl: `${endpoint}/testplan/${plan.id}`,
    actualResult: null, note: 'Plan preparation is not an executed measurement or a passing result.' };
}


export const executionId = 'chat-features.runner-opencode.local.create-backlog';
export const scenario = 'tasks.create-backlog';
const positive = value => typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
export function publicContext(env) {
  if (env.GITHUB_REPOSITORY !== 'paperclipai/paperclip' || env.GITHUB_REF !== 'refs/heads/master'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_RUN_ATTEMPT !== '1'
    || env.GITHUB_WORKFLOW_REF !== 'paperclipai/paperclip/.github/workflows/chat-feature-testops.yml@refs/heads/master'
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !positive(env.GITHUB_RUN_ID)) fail('untrusted_public_testops_context');
  return { runId: env.GITHUB_RUN_ID, attempt: '1', workflowSha: env.GITHUB_SHA, targetSha: env.GITHUB_SHA };
}

export async function validateChatSelection(api, env) {
  const context = publicContext(env);
  const names = ['ALLURE_JOB_RUN_ID', 'CHAT_TESTOPS_CASE_ID', 'CHAT_TESTOPS_PLAN_ID', 'CHAT_TESTOPS_JOB_ID'];
  if (names.some(name => !positive(env[name]))) fail('chat_testops_identity_missing');
  const [caseId, planId, jobId, jobRunId] = ['CHAT_TESTOPS_CASE_ID', 'CHAT_TESTOPS_PLAN_ID', 'CHAT_TESTOPS_JOB_ID', 'ALLURE_JOB_RUN_ID'].map(name => Number(env[name]));
  const selected = await api(`/api/testcase/${caseId}`);
  if (selected.id !== caseId || selected.projectId !== 1 || !aliases.includes(selected.fullName) || selected.deleted === true || selected.automated !== true) fail('chat_testops_case_mismatch');
  const plan = await api(`/api/testplan/${planId}`);
  if (plan.id !== planId || plan.projectId !== 1 || plan.name !== planName || plan.testCasesCount !== 1
    || plan.treeSelection?.inverted === true || !same(plan.treeSelection?.leafsInclude, [caseId])
    || (plan.treeSelection?.groupsInclude?.length ?? 0) > 0 || (plan.treeSelection?.leafsExclude?.length ?? 0) > 0) fail('chat_testops_plan_mismatch');
  const assignments = await api(`/api/testplan/${planId}/job`);
  if (!Array.isArray(assignments) || assignments.length !== 1 || assignments[0].job?.id !== jobId || assignments[0].testCasesCount !== 1) fail('chat_testops_plan_job_mismatch');
  const job = await api(`/api/job/${jobId}`);
  const jobUrls = ['https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml'];
  if (positive(env.CHAT_TESTOPS_GITHUB_WORKFLOW_ID)) jobUrls.push(`https://github.com/paperclipai/paperclip/actions/workflows/${env.CHAT_TESTOPS_GITHUB_WORKFLOW_ID}`);
  if (job.id !== jobId || job.type !== 'github' || !jobUrls.includes(job.url)) fail('chat_testops_job_mismatch');
  const run = await api(`/api/jobrun/${jobRunId}`);
  if (run.id !== jobRunId || run.job?.id !== jobId || run.job?.type !== 'github'
    || !['scheduled', 'in_progress'].includes(run.stage) || !id(run.launchId)
    || run.url !== `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}`) fail('chat_testops_jobrun_mismatch');
  const launch = await api(`/api/launch/${run.launchId}`);
  if (launch.id !== run.launchId || launch.projectId !== 1 || launch.closed === true) fail('chat_testops_launch_mismatch');
  const selection = await api(`/api/jobrun/${jobRunId}/plan?expected=true`);
  if (!Array.isArray(selection) || selection.length !== 1 || selection[0].id !== caseId || selection[0].selector !== selected.fullName) fail('chat_testops_selection_mismatch');
  return { schema: 'paperclip.chat-feature-testops-selection/v1', ...context, allureJobRunId: String(jobRunId),
    executionId, canonicalScenario: scenario, projectId: 1, planId, jobId, caseId, fullName: selected.fullName, launchId: run.launchId };
}

function configuredIds(env) {
  const names = ['CHAT_TESTOPS_CASE_ID', 'CHAT_TESTOPS_PLAN_ID', 'CHAT_TESTOPS_JOB_ID', 'CHAT_TESTOPS_OPERATION_PARAMETER_ID'];
  if (names.some(name => !positive(env[name]))) fail('chat_testops_identity_missing');
  return Object.fromEntries(names.map((name, index) => [['caseId', 'planId', 'jobId', 'parameterId'][index], Number(env[name])]));
}
function publicJobUrl(url, env) {
  return url === 'https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml'
    || positive(env.CHAT_TESTOPS_GITHUB_WORKFLOW_ID) && url === `https://github.com/paperclipai/paperclip/actions/workflows/${env.CHAT_TESTOPS_GITHUB_WORKFLOW_ID}`;
}
async function registeredPlan(api, env) {
  const ids = configuredIds(env);
  const selected = await api(`/api/testcase/${ids.caseId}`);
  if (selected.id !== ids.caseId || selected.projectId !== 1 || !aliases.includes(selected.fullName) || selected.deleted === true || selected.automated !== true) fail('chat_testops_case_mismatch');
  const plan = await api(`/api/testplan/${ids.planId}`);
  if (plan.id !== ids.planId || plan.projectId !== 1 || plan.name !== planName || plan.testCasesCount !== 1
    || plan.treeSelection?.inverted === true || !same(plan.treeSelection?.leafsInclude, [ids.caseId])
    || (plan.treeSelection?.groupsInclude?.length ?? 0) > 0 || (plan.treeSelection?.leafsExclude?.length ?? 0) > 0) fail('chat_testops_plan_mismatch');
  const job = await api(`/api/job/${ids.jobId}`);
  if (job.id !== ids.jobId || job.type !== 'github' || !publicJobUrl(job.url, env)) fail('chat_testops_job_mismatch');
  const definition = await api(`/api/environment/${ids.parameterId}`);
  if (definition.id !== ids.parameterId || definition.name !== 'operation' || !Array.isArray(job.parameters) || job.parameters.length !== 1
    || job.parameters[0].id !== ids.parameterId || !['bootstrap', 'evaluate'].includes(job.parameters[0].value)) fail('chat_testops_parameter_mismatch');
  return { ...ids, selected, plan, job };
}

export async function bootstrapJobMetadata(api, env) {
  if (!positive(env.ALLURE_JOB_RUN_ID)) return { status: 'official_job_run_id_missing', actualResult: null };
  const run = await api(`/api/jobrun/${env.ALLURE_JOB_RUN_ID}`);
  if (!id(run?.job?.id)) fail('chat_testops_jobrun_mismatch');
  const job = await api(`/api/job/${run.job.id}`);
  if (job.id !== run.job.id || job.type !== 'github' || !Array.isArray(job.parameters) || job.parameters.length > 4) fail('chat_testops_job_mismatch');
  const parameters = [];
  for (const parameter of job.parameters) {
    if (!id(parameter.id)) fail('chat_testops_parameter_mismatch');
    const definition = await api(`/api/environment/${parameter.id}`);
    const known = ['operation', 'ALLURE_JOB_RUN_ID', 'ALLURE_USERNAME'].includes(definition.name);
    parameters.push({ id: parameter.id, name: known ? definition.name : 'UNKNOWN',
      value: definition.name === 'operation' && ['bootstrap', 'evaluate', 'launch-plan'].includes(parameter.value) ? parameter.value : 'NOT_PROJECTED' });
  }
  return { status: 'observed', projectId: 1, jobId: job.id, allureJobRunId: env.ALLURE_JOB_RUN_ID,
    publicWorkflowMatches: publicJobUrl(job.url, env), currentRunUrlMatches: run.url === `https://github.com/paperclipai/paperclip/actions/runs/${env.GITHUB_RUN_ID}`,
    launchId: id(run.launchId) ? run.launchId : null, parameters, actualResult: null };
}

export async function launchChatPlan(api, env, markOnce) {
  const source = publicContext(env);
  const nonce = env.CHAT_TESTOPS_LAUNCH_NONCE;
  if (!/^[a-f0-9]{32}$/.test(nonce ?? '')) fail('chat_testops_nonce_invalid');
  const known = await registeredPlan(api, env);
  const assignments = await api(`/api/testplan/${known.planId}/job`);
  if (!Array.isArray(assignments) || assignments.length > 1 || assignments.some(row => row.job?.id !== known.jobId || row.testCasesCount !== 1)) fail('chat_testops_plan_job_mismatch');
  const launchName = `${planName} · ${nonce}`;
  const existing = rows(await api(`/api/launch?${new URLSearchParams({ projectId: '1', search: launchName, page: '0', size: '100' })}`));
  if (existing.length) {
    if (existing.length !== 1 || existing[0].name !== launchName || !id(existing[0].id)) fail('chat_testops_nonce_conflict');
    return { schema: 'paperclip.chat-feature-testops-launch/v1', ...source, nonce, planId: known.planId,
      jobId: known.jobId, caseId: known.caseId, launchId: existing[0].id, status: 'EXISTING_NO_RESEND', actualResult: null };
  }
  await markOnce({ ...source, nonce, planId: known.planId, jobId: known.jobId, caseId: known.caseId });
  const parameters = [{ id: known.parameterId, value: 'evaluate' }];
  await api(`/api/job/${known.jobId}`, 'PATCH', { canRun: true, parameters });
  const patched = await api(`/api/job/${known.jobId}`);
  if (patched.id !== known.jobId || patched.type !== 'github' || !publicJobUrl(patched.url, env) || !same(patched.parameters, parameters)) fail('chat_testops_parameter_mismatch');
  if (!assignments.length) await api(`/api/testplan/${known.planId}/assign`, 'POST', { jobId: known.jobId,
    selection: { inverted: false, manual: false, leafsInclude: [known.caseId] } });
  await api(`/api/testplan/${known.planId}/jobparameter`, 'POST', { jobId: known.jobId, parameters });
  const bound = await api(`/api/testplan/${known.planId}/job`);
  if (!Array.isArray(bound) || bound.length !== 1 || bound[0].job?.id !== known.jobId || bound[0].testCasesCount !== 1
    || !same(bound[0].job.parameters, parameters)) fail('chat_testops_plan_job_mismatch');
  const launched = await api(`/api/testplan/${known.planId}/run`, 'POST', { launchName });
  if (!id(launched?.id) || launched.projectId !== 1 || launched.name !== launchName) fail('chat_testops_launch_mismatch');
  return { schema: 'paperclip.chat-feature-testops-launch/v1', ...source, nonce, projectId: 1,
    planId: known.planId, jobId: known.jobId, caseId: known.caseId, launchId: launched.id,
    status: 'REQUESTED', executionId, canonicalScenario: scenario, actualRunId: null, actualResult: null };
}
