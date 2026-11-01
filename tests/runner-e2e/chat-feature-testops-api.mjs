export const endpoint = 'https://paperclip.testops.cloud';
export const planName = 'Chat feature evals';
export const fullName = 'paperclip.Product E2E.chat-features.create-backlog';
export const aliases = [fullName, 'paperclip.Product E2E.chat-features.tasks.create-backlog'];
class SetupFailure extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
const fail = code => {
  const match = /^(testops_(?:api|auth)|chat_testops_github)_http_([1-5][0-9]{2})$/.exec(code);
  throw new SetupFailure(match ? `${match[1]}_http` : code, match ? Number(match[2]) : null);
};
const bootstrapRequestClasses = new Set(['JOB_RUN_GET', 'LAUNCH_GET', 'JOB_GET']);
const uploadFailureChecks = {
  context: ['selected_run', 'selected_attempt', 'selected_workflow_sha', 'selected_target_sha', 'selected_jobrun', 'env_jobrun', 'selected_execution',
    'selected_scenario', 'selected_project', 'selected_full_name', 'plan_id', 'job_id', 'case_id', 'launch_id', 'export_case',
    'export_campaign', 'export_count', 'export_status', 'export_cleanup', 'passed_cleanup', 'attachment_array', 'attachment_count'],
  attachment_contract: ['attachment_rows', 'provenance_count', 'record_count', 'passed_screenshot'],
  jobrun: ['jobrun_id', 'job_id', 'job_type', 'launch_id', 'run_url', 'stage'],
  launch: ['launch_id', 'project_id'],
  result_page: ['content_array', 'content_limit', 'total_integer', 'total_matches_content', 'pages_integer', 'pages_range'],
  result_row: ['result_id', 'case_id'],
  result: ['result_id', 'project_id', 'launch_id', 'case_id', 'full_name', 'jobrun_id', 'jobrun_launch', 'jobrun_url',
    'embedded_job', 'links_array', 'known_links'],
  result_status: ['status_supported', 'status_matches_export'],
  attachment_page: ['content_array', 'content_limit', 'total_integer', 'total_matches_content', 'pages_integer', 'pages_range',
    'unique_ids', 'ids_valid', 'not_inherited', 'attachment_rows'],
  attachment_readiness: ['attachment_page_observed', 'attachments_not_missed', 'attachment_signatures_match', 'result_status_matches', 'attachments_ready'],
};
const uploadFailures = new WeakMap();
function stopUpload(code, phase, readChecks, attachmentReadiness) {
  const error = new SetupFailure(code);
  let values;
  try { values = readChecks(); } catch {}
  const names = uploadFailureChecks[phase].filter(name => Array.isArray(values?.[name]) && typeof values[name][0] === 'boolean');
  const checks = Object.fromEntries(names.map(name => [name, values[name][0]]));
  const types = Object.fromEntries(names.filter(name => values[name].length === 2).map(name => {
    const value = values[name][1], type = typeof value;
    return [name, value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array'
      : ['string', 'number', 'boolean', 'object'].includes(type) ? type : 'other'];
  }));
  const failedPredicates = Object.keys(checks).filter(name => !checks[name]);
  uploadFailures.set(error, { phase, firstFailedPredicate: failedPredicates[0] ?? 'checks_unavailable', failedPredicates, checks, types,
    ...(attachmentReadiness ? { attachmentReadiness: attachmentReadiness.map(row => ({ ...row })) } : {}) });
  throw error;
}
const diagnosticCodes = new Set(['untrusted_chat_testops_context', 'testops_token_missing', 'testops_auth_http',
  'testops_api_http', 'testops_auth_invalid', 'testops_route_invalid', 'testops_response_too_large',
  'testops_response_invalid', 'testops_metadata_page_incomplete', 'testops_case_identity_invalid',
  'testops_case_alias_conflict', 'testops_plan_name_conflict', 'testops_plan_identity_invalid',
  'testops_integration_identity_invalid', 'testops_bootstrap_identity_invalid', 'testops_plan_without_matching_case',
  'testops_created_case_identity_invalid', 'testops_created_plan_identity_invalid', 'testops_plan_scope_mismatch',
  'testops_operation_invalid', 'testops_output_invalid', 'untrusted_public_testops_context', 'chat_testops_identity_missing',
  'chat_testops_case_mismatch', 'chat_testops_plan_mismatch', 'chat_testops_plan_job_mismatch', 'chat_testops_job_mismatch',
  'chat_testops_job_id_mismatch', 'chat_testops_job_type_mismatch', 'chat_testops_job_parameters_shape_mismatch',
  'chat_testops_job_parameters_limit', 'chat_testops_job_url_mismatch', 'chat_testops_jobrun_mismatch', 'chat_testops_launch_mismatch', 'chat_testops_selection_mismatch', 'chat_testops_parameter_mismatch', 'chat_testops_nonce_invalid', 'chat_testops_nonce_conflict', 'chat_testops_catalog_incomplete', 'chat_testops_launch_admission', 'chat_testops_github_http', 'chat_testops_integration_mismatch', 'chat_testops_upload_mismatch', 'chat_testops_upload_unverified']);
export function failureProjection(error, stage) {
  const request = error instanceof SetupFailure ? error.request : undefined;
  const verification = error instanceof SetupFailure ? uploadFailures.get(error) : undefined;
  const stages = ['context', 'output_admission', 'authentication', 'metadata_inspection', 'plan_bootstrap', 'selection_validation', 'launch_admission', 'launch_preflight', 'plan_launch', 'bootstrap_job_metadata', 'result_export', 'upload_verification', 'bootstrap_context', 'receipt'];
  return { stage: stages.includes(stage) ? stage : 'unknown',
    code: error instanceof SetupFailure && diagnosticCodes.has(error.code) ? error.code : 'unknown_failure',
    httpStatus: error instanceof SetupFailure && Number.isInteger(error.status) && error.status >= 100 && error.status < 600 ? error.status : null,
    ...(verification ? { verification: { ...verification, failedPredicates: [...verification.failedPredicates],
      checks: { ...verification.checks }, types: { ...verification.types },
      ...(verification.attachmentReadiness ? { attachmentReadiness: verification.attachmentReadiness.map(row => ({ ...row })) } : {}) } } : {}),
    ...(request && bootstrapRequestClasses.has(request.class) && id(request.resourceId) && ['STARTED', 'SUCCEEDED', 'FAILED'].includes(request.state)
      ? { request: { class: request.class, resourceId: request.resourceId, state: request.state,
        httpStatus: Number.isInteger(request.httpStatus) && request.httpStatus >= 100 && request.httpStatus < 600 ? request.httpStatus : null } } : {}) };
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
  return async (route, method = 'GET', body, timeoutMs = 30_000) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) fail('chat_testops_upload_unverified');
    if (!route.startsWith('/api/') || route.includes('://')) fail('testops_route_invalid');
    const response = await fetchImpl(`${endpoint}${route}`, { method, redirect: 'error',
      headers: { Accept: 'application/json', Authorization: `Bearer ${value.access_token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
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
  const cases = new Map(), catalogIds = new Set();
  let totalPages, totalElements;
  for (let page = 0; page < 10; page++) {
    const catalog = await api(`/api/testcase?${new URLSearchParams({ projectId: '1', page: String(page), size: '100', sort: 'id,asc' })}`);
    if (!Array.isArray(catalog?.content) || catalog.content.length > 100 || catalog.number !== page
      || !Number.isSafeInteger(catalog.totalPages) || catalog.totalPages < 0 || catalog.totalPages > 10
      || !Number.isSafeInteger(catalog.totalElements) || catalog.totalElements < 0 || catalog.totalElements > 1000
      || totalPages !== undefined && (totalPages !== catalog.totalPages || totalElements !== catalog.totalElements)) fail('chat_testops_catalog_incomplete');
    totalPages = catalog.totalPages; totalElements = catalog.totalElements;
    const ids = catalog.content.map(row => {
      if (!id(row.id) || catalogIds.has(row.id)) fail('chat_testops_catalog_incomplete');
      catalogIds.add(row.id); return row.id;
    });
    for (let offset = 0; offset < ids.length; offset += 4) {
      const batch = ids.slice(offset, offset + 4);
      const details = await Promise.all(batch.map(value => api(`/api/testcase/${value}`)));
      for (const [index, value] of details.entries()) {
        if (value?.id !== batch[index] || value.projectId !== 1 || value.fullName != null && typeof value.fullName !== 'string') fail('testops_case_identity_invalid');
        if (!aliases.includes(value.fullName)) continue;
        if (value.deleted === true || typeof value.automated !== 'boolean') fail('testops_case_identity_invalid');
        cases.set(value.id, { id: value.id, fullName: value.fullName, automated: value.automated });
      }
    }
    if (page + 1 >= totalPages) break;
    if (page === 9) fail('chat_testops_catalog_incomplete');
  }
  if (catalogIds.size !== totalElements) fail('chat_testops_catalog_incomplete');
  const plans = rows(await api(`/api/testplan?${new URLSearchParams({ projectId: '1', name: planName, page: '0', size: '100' })}`))
    .filter(value => value.name === planName);
  if (plans.length > 1) fail('testops_plan_name_conflict');
  if (plans.some(value => !id(value.id) || value.projectId !== 1)) fail('testops_plan_identity_invalid');
  const integrations = rows(await api('/api/integration/project/1?page=0&size=100'))
    .filter(value => value.info?.type === 'github')
    .map(value => ({ id: value.id, type: 'github', disabled: typeof value.disabled === 'boolean' ? value.disabled : null }));
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


export const executionId = 'chat-features.runner-opencode-deepseek-1017.local.create-backlog';
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
  if (job.id !== jobId || job.type !== 'github' || !publicJobUrl(job.url, env)) fail('chat_testops_job_mismatch');
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
  const names = ['CHAT_TESTOPS_CASE_ID', 'CHAT_TESTOPS_PLAN_ID', 'CHAT_TESTOPS_JOB_ID', 'CHAT_TESTOPS_INTEGRATION_ID'];
  if (names.some(name => !positive(env[name]))) fail('chat_testops_identity_missing');
  const operation = env.CHAT_TESTOPS_OPERATION_PARAMETER_ID;
  if (operation !== undefined && operation !== '' && !positive(operation)) fail('chat_testops_identity_missing');
  return { ...Object.fromEntries(names.map((name, index) => [['caseId', 'planId', 'jobId', 'integrationId'][index], Number(env[name])])),
    parameterId: positive(operation) ? Number(operation) : null };
}
function publicJobUrl(url, env) {
  return url === 'https://github.com/paperclipai/paperclip/actions/workflows/chat-feature-testops.yml'
    || url === 'https://github.com/paperclipai/paperclip/actions?query=workflow%3A%22Chat+feature+TestOps%22'
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
  const integration = await api(`/api/integration/${ids.integrationId}/project/1`);
  if (integration.id !== ids.integrationId || integration.projectId !== 1 || integration.info?.type !== 'github' || integration.disabled !== false) fail('chat_testops_integration_mismatch');
  if (!Array.isArray(job.parameters) || job.parameters.length < 1 || job.parameters.length > 2) fail('chat_testops_parameter_mismatch');
  const seenIds = new Set(), parameters = [];
  let hasOperation = false, hasRef = false;
  for (const parameter of job.parameters) {
    if (!id(parameter.id) || seenIds.has(parameter.id)) fail('chat_testops_parameter_mismatch');
    seenIds.add(parameter.id);
    if (parameter.id === ids.parameterId) {
      if (!['bootstrap', 'evaluate'].includes(parameter.value)) fail('chat_testops_parameter_mismatch');
      hasOperation = true;
      parameters.push({ id: parameter.id, value: 'evaluate' });
    } else {
      if (hasRef || parameter.value !== 'refs/heads/master') fail('chat_testops_parameter_mismatch');
      hasRef = true;
      parameters.push({ id: parameter.id, value: parameter.value });
    }
  }
  if (ids.parameterId === null ? parameters.length !== 1 || !hasRef : !hasOperation) fail('chat_testops_parameter_mismatch');
  return { ...ids, selected, plan, job, parameters };
}

export async function bootstrapJobMetadata(api, env, expectedLaunchId) {
  const requests = [];
  const read = async (kind, resourceId, route) => {
    const request = { class: kind, resourceId, state: 'STARTED', httpStatus: null };
    requests.push(request);
    try {
      const value = await api(route);
      request.state = 'SUCCEEDED';
      return value;
    } catch (error) {
      request.state = 'FAILED';
      request.httpStatus = error instanceof SetupFailure ? error.status : null;
      throw error;
    }
  };
  try {
    const strict = expectedLaunchId !== undefined;
    const context = strict ? publicContext(env) : undefined;
    if (strict && !id(expectedLaunchId)) fail('chat_testops_launch_mismatch');
    if (!positive(env.ALLURE_JOB_RUN_ID)) {
      if (strict) fail('chat_testops_jobrun_mismatch');
      return { status: 'official_job_run_id_missing', actualResult: null };
    }
    const run = await read('JOB_RUN_GET', Number(env.ALLURE_JOB_RUN_ID), `/api/jobrun/${env.ALLURE_JOB_RUN_ID}`);
    if (!id(run?.job?.id)) fail('chat_testops_jobrun_mismatch');
    if (strict) {
      if (run.id !== Number(env.ALLURE_JOB_RUN_ID) || run.job.type !== 'github' || run.launchId !== expectedLaunchId
        || run.url !== `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}`) fail('chat_testops_jobrun_mismatch');
      const launch = await read('LAUNCH_GET', expectedLaunchId, `/api/launch/${expectedLaunchId}`);
      if (launch.id !== expectedLaunchId || launch.projectId !== 1) fail('chat_testops_launch_mismatch');
    }
    const job = await read('JOB_GET', run.job.id, `/api/job/${run.job.id}`);
    if (job.id !== run.job.id) fail('chat_testops_job_id_mismatch');
    if (job.type !== 'github') fail('chat_testops_job_type_mismatch');
    if (!Array.isArray(job.parameters)) fail('chat_testops_job_parameters_shape_mismatch');
    if (job.parameters.length > 4) fail('chat_testops_job_parameters_limit');
    if (strict && !publicJobUrl(job.url, env)) fail('chat_testops_job_url_mismatch');
    const parameters = [];
    const seen = new Set();
    for (const parameter of job.parameters) {
      if (!id(parameter.id) || strict && seen.has(parameter.id)) fail('chat_testops_parameter_mismatch');
      seen.add(parameter.id);
      const value = Object.getOwnPropertyDescriptor(parameter, 'value');
      const fixedRef = value && Object.hasOwn(value, 'value') && value.value === 'refs/heads/master';
      parameters.push({ id: parameter.id, kind: fixedRef ? 'fixed_default_ref' : 'UNRESOLVED',
        value: fixedRef ? 'refs/heads/master' : 'NOT_PROJECTED' });
    }
    return { ...(strict ? { schema: 'paperclip.chat-feature-testops-bootstrap-registration/v1', ...context, capturedAfterWatch: true, runnableBindingQualified: false } : {}),
      status: 'observed', projectId: 1, jobId: job.id, allureJobRunId: env.ALLURE_JOB_RUN_ID,
      publicWorkflowMatches: publicJobUrl(job.url, env), currentRunUrlMatches: run.url === `https://github.com/paperclipai/paperclip/actions/runs/${env.GITHUB_RUN_ID}`,
      launchId: id(run.launchId) ? run.launchId : null, parameters, requests, actualResult: null };
  } catch (error) {
    const failure = error instanceof SetupFailure ? error : new SetupFailure('unknown_failure');
    if (requests.length) failure.request = { ...requests.at(-1) };
    throw failure;
  }
}

const launchAdmissions = new WeakSet();
export async function admitLaunchPlan(env, fetchImpl = fetch) {
  const source = publicContext(env);
  const expected = env.CHAT_TESTOPS_LAUNCH_RUN_NUMBER, actual = env.GITHUB_RUN_NUMBER;
  if (!positive(expected) || !positive(actual) || actual !== expected || !positive(env.CHAT_TESTOPS_GITHUB_WORKFLOW_ID)
    || !positive(env.GITHUB_ACTOR_ID) || !positive(env.TESTOPS_TRIGGERING_ACTOR_ID) || !env.GH_TOKEN) fail('chat_testops_launch_admission');
  let allowed;
  try { allowed = JSON.parse(env.TESTOPS_ALLOWED_ACTOR_IDS ?? 'null'); } catch { fail('chat_testops_launch_admission'); }
  if (!Array.isArray(allowed) || !allowed.length || allowed.some(value => !id(value)) || !allowed.includes(Number(env.GITHUB_ACTOR_ID)) || !allowed.includes(Number(env.TESTOPS_TRIGGERING_ACTOR_ID))) fail('chat_testops_launch_admission');
  const read = async route => {
    const response = await fetchImpl(`https://api.github.com/repos/paperclipai/paperclip${route ? `/${route}` : ''}`, {
      method: 'GET', redirect: 'error', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GH_TOKEN}` },
      signal: AbortSignal.timeout(30_000) });
    if (!response.ok) fail(`chat_testops_github_http_${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 512_000) fail('chat_testops_launch_admission');
    try { return JSON.parse(text); } catch { fail('chat_testops_launch_admission'); }
  };
  const repository = await read('');
  const workflow = await read('actions/workflows/chat-feature-testops.yml');
  const run = await read(`actions/runs/${source.runId}`);
  if (repository.full_name !== 'paperclipai/paperclip' || repository.private !== false || repository.default_branch !== 'master'
    || workflow.id !== Number(env.CHAT_TESTOPS_GITHUB_WORKFLOW_ID) || workflow.path !== '.github/workflows/chat-feature-testops.yml' || workflow.state !== 'active'
    || run.id !== Number(source.runId) || run.workflow_id !== workflow.id || run.run_attempt !== 1 || run.run_number !== Number(expected)
    || run.head_sha !== source.workflowSha || run.head_branch !== 'master' || run.event !== 'workflow_dispatch'
    || run.repository?.full_name !== 'paperclipai/paperclip' || run.repository?.private !== false
    || run.actor?.id !== Number(env.GITHUB_ACTOR_ID) || run.triggering_actor?.id !== Number(env.TESTOPS_TRIGGERING_ACTOR_ID) || !allowed.includes(run.triggering_actor.id)) fail('chat_testops_launch_admission');
  const receipt = Object.freeze({ schema: 'paperclip.chat-feature-testops-launch-admission/v1', ...source,
    workflowId: workflow.id, runNumber: run.run_number, expectedRunNumber: Number(expected), actorId: run.actor.id, triggeringActorId: run.triggering_actor.id });
  launchAdmissions.add(receipt); return receipt;
}

export async function launchChatPlan(api, env, markOnce, admission) {
  const source = publicContext(env);
  if (!admission || !launchAdmissions.has(admission) || admission.runId !== source.runId || admission.workflowSha !== source.workflowSha
    || admission.targetSha !== source.targetSha || String(admission.expectedRunNumber) !== env.CHAT_TESTOPS_LAUNCH_RUN_NUMBER
    || String(admission.runNumber) !== env.GITHUB_RUN_NUMBER) fail('chat_testops_launch_admission');
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
  await markOnce({ ...source, launchAdmission: admission, nonce, planId: known.planId, jobId: known.jobId, caseId: known.caseId });
  const parameters = known.parameters;
  await api(`/api/job/${known.jobId}`, 'PATCH', { integrationId: known.integrationId, canRun: true, parameters });
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
    status: 'REQUESTED', integrationId: known.integrationId, integrationBindingRequested: true, integrationAssociationReadback: 'not_exposed_by_job_dto', executionId, canonicalScenario: scenario, actualRunId: null, actualResult: null };
}


export async function verifyChatUpload(api, env, selected, exported, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const context = publicContext(env);
  if (selected.runId !== context.runId || selected.attempt !== '1' || selected.workflowSha !== context.workflowSha
    || selected.targetSha !== context.targetSha || selected.allureJobRunId !== env.ALLURE_JOB_RUN_ID
    || selected.executionId !== executionId || selected.canonicalScenario !== scenario || selected.projectId !== 1
    || !aliases.includes(selected.fullName) || ['planId', 'jobId', 'caseId', 'launchId'].some(key => !id(selected[key]))
    || exported.caseId !== selected.caseId || exported.campaignId !== `gha-${context.runId}-1` || exported.count !== 1
    || !['passed', 'failed'].includes(exported.status) || !['passed', 'failed', 'not_started'].includes(exported.cleanup)
    || exported.status === 'passed' && exported.cleanup !== 'passed' || !Array.isArray(exported.attachmentMetadata)
    || exported.attachmentMetadata.length < 2 || exported.attachmentMetadata.length > 10) stopUpload('chat_testops_upload_mismatch', 'context', () => ({
    selected_run: [selected.runId === context.runId, selected.runId], selected_attempt: [selected.attempt === '1', selected.attempt],
    selected_workflow_sha: [selected.workflowSha === context.workflowSha, selected.workflowSha],
    selected_target_sha: [selected.targetSha === context.targetSha, selected.targetSha],
    selected_jobrun: [selected.allureJobRunId === env.ALLURE_JOB_RUN_ID, selected.allureJobRunId],
    env_jobrun: [selected.allureJobRunId === env.ALLURE_JOB_RUN_ID, env.ALLURE_JOB_RUN_ID],
    selected_execution: [selected.executionId === executionId, selected.executionId], selected_scenario: [selected.canonicalScenario === scenario, selected.canonicalScenario],
    selected_project: [selected.projectId === 1, selected.projectId], selected_full_name: [aliases.includes(selected.fullName), selected.fullName],
    plan_id: [id(selected.planId), selected.planId], job_id: [id(selected.jobId), selected.jobId],
    case_id: [id(selected.caseId), selected.caseId], launch_id: [id(selected.launchId), selected.launchId],
    export_case: [exported.caseId === selected.caseId, exported.caseId], export_campaign: [exported.campaignId === `gha-${context.runId}-1`, exported.campaignId],
    export_count: [exported.count === 1, exported.count], export_status: [['passed', 'failed'].includes(exported.status), exported.status],
    export_cleanup: [['passed', 'failed', 'not_started'].includes(exported.cleanup), exported.cleanup],
    passed_cleanup: [!(exported.status === 'passed' && exported.cleanup !== 'passed')],
    attachment_array: [Array.isArray(exported.attachmentMetadata), exported.attachmentMetadata],
    attachment_count: [Array.isArray(exported.attachmentMetadata) && exported.attachmentMetadata.length >= 2 && exported.attachmentMetadata.length <= 10],
  }));
  const allowedAttachments = new Map([['Synthetic task and source conversation', 'image/png'],
    ['Execution provenance and checks', 'application/json'], ['Sanitized Product E2E record and accounting', 'application/json']]);
  if (exported.attachmentMetadata.some(row => allowedAttachments.get(row.name) !== row.contentType
    || !Number.isSafeInteger(row.contentLength) || row.contentLength <= 0 || row.contentLength > 12 * 1024 * 1024)
    || exported.attachmentMetadata.filter(row => row.name === 'Execution provenance and checks').length !== 1
    || exported.attachmentMetadata.filter(row => row.name === 'Sanitized Product E2E record and accounting').length !== 1
    || exported.status === 'passed' && !exported.attachmentMetadata.some(row => row.contentType === 'image/png')) stopUpload('chat_testops_upload_mismatch', 'attachment_contract', () => ({
    attachment_rows: [!exported.attachmentMetadata.some(row => allowedAttachments.get(row?.name) !== row?.contentType
      || !Number.isSafeInteger(row?.contentLength) || row?.contentLength <= 0 || row?.contentLength > 12 * 1024 * 1024)],
    provenance_count: [exported.attachmentMetadata.filter(row => row?.name === 'Execution provenance and checks').length === 1],
    record_count: [exported.attachmentMetadata.filter(row => row?.name === 'Sanitized Product E2E record and accounting').length === 1],
    passed_screenshot: [!(exported.status === 'passed' && !exported.attachmentMetadata.some(row => row?.contentType === 'image/png'))],
  }));
  const signature = rows => rows.map(row => JSON.stringify([row.name, row.contentType, row.contentLength])).sort();
  const runUrl = `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}`;
  const sourceUrl = `https://github.com/paperclipai/paperclip/commit/${context.targetSha}`;
  const deadline = now() + 120_000;
  const attachmentReadiness = [];
  const unverified = () => stopUpload('chat_testops_upload_unverified', 'attachment_readiness', () => ({
    attachment_page_observed: [attachmentReadiness.length > 0],
    attachments_not_missed: [attachmentReadiness.at(-1)?.missedCount === 0],
    attachment_signatures_match: [attachmentReadiness.at(-1)?.signaturesMatch === true],
    result_status_matches: [attachmentReadiness.at(-1)?.resultStatusMatches === true],
    attachments_ready: [attachmentReadiness.at(-1)?.ready === true],
  }), attachmentReadiness);
  const get = async route => {
    const remaining = deadline - now();
    if (remaining < 1) unverified();
    const value = await api(route, 'GET', undefined, Math.min(30_000, Math.floor(remaining)));
    if (now() >= deadline) unverified();
    return value;
  };
  for (let poll = 0; poll < 12 && now() < deadline; poll++) {
    const run = await get(`/api/jobrun/${selected.allureJobRunId}`);
    if (run.id !== Number(selected.allureJobRunId) || run.job?.id !== selected.jobId || run.job?.type !== 'github'
      || run.launchId !== selected.launchId || run.url !== runUrl || !['in_progress', 'finished'].includes(run.stage)) stopUpload('chat_testops_jobrun_mismatch', 'jobrun', () => ({
      jobrun_id: [run.id === Number(selected.allureJobRunId), run.id], job_id: [run.job?.id === selected.jobId, run.job?.id],
      job_type: [run.job?.type === 'github', run.job?.type], launch_id: [run.launchId === selected.launchId, run.launchId],
      run_url: [run.url === runUrl, run.url], stage: [['in_progress', 'finished'].includes(run.stage), run.stage],
    }));
    const launch = await get(`/api/launch/${selected.launchId}`);
    if (launch.id !== selected.launchId || launch.projectId !== 1) stopUpload('chat_testops_launch_mismatch', 'launch', () => ({
      launch_id: [launch.id === selected.launchId, launch.id], project_id: [launch.projectId === 1, launch.projectId],
    }));
    const listed = await get(`/api/testresult?${new URLSearchParams({ launchId: String(selected.launchId), page: '0', size: '100' })}`);
    if (!Array.isArray(listed?.content) || listed.content.length > 1 || !Number.isSafeInteger(listed.totalElements)
      || listed.totalElements !== listed.content.length || !Number.isSafeInteger(listed.totalPages) || listed.totalPages < 0 || listed.totalPages > 1) stopUpload('chat_testops_upload_mismatch', 'result_page', () => ({
      content_array: [Array.isArray(listed?.content), listed?.content], content_limit: [Array.isArray(listed?.content) && listed.content.length <= 1],
      total_integer: [Number.isSafeInteger(listed?.totalElements), listed?.totalElements],
      total_matches_content: [Array.isArray(listed?.content) && listed.totalElements === listed.content.length],
      pages_integer: [Number.isSafeInteger(listed?.totalPages), listed?.totalPages],
      pages_range: [Number.isSafeInteger(listed?.totalPages) && listed.totalPages >= 0 && listed.totalPages <= 1],
    }));
    if (listed.content.length) {
      const row = listed.content[0];
      if (!id(row.id) || row.testCaseId !== selected.caseId) stopUpload('chat_testops_upload_mismatch', 'result_row', () => ({
        result_id: [id(row.id), row.id], case_id: [row.testCaseId === selected.caseId, row.testCaseId],
      }));
      const result = await get(`/api/testresult/${row.id}`);
      if (result.id !== row.id || result.projectId !== 1 || result.launchId !== selected.launchId || result.testCaseId !== selected.caseId
        || result.fullName !== selected.fullName || result.jobRun?.id !== Number(selected.allureJobRunId)
        || result.jobRun?.launchId !== selected.launchId || result.jobRun?.url !== runUrl
        || result.jobRun.job != null && (result.jobRun.job.id !== run.job.id
          || result.jobRun.job.type != null && result.jobRun.job.type !== run.job.type
          || result.jobRun.job.url != null && !publicJobUrl(result.jobRun.job.url, env))
        || !Array.isArray(result.links) || result.links.some(link => typeof link.url === 'string'
          && (link.url.startsWith('https://github.com/paperclipai/paperclip/actions/runs/') && link.url !== runUrl
            || link.url.startsWith('https://github.com/paperclipai/paperclip/commit/') && link.url !== sourceUrl))) stopUpload('chat_testops_upload_mismatch', 'result', () => ({
        result_id: [result.id === row.id, result.id], project_id: [result.projectId === 1, result.projectId],
        launch_id: [result.launchId === selected.launchId, result.launchId], case_id: [result.testCaseId === selected.caseId, result.testCaseId],
        full_name: [result.fullName === selected.fullName, result.fullName], jobrun_id: [result.jobRun?.id === Number(selected.allureJobRunId), result.jobRun?.id],
        jobrun_launch: [result.jobRun?.launchId === selected.launchId, result.jobRun?.launchId], jobrun_url: [result.jobRun?.url === runUrl, result.jobRun?.url],
        embedded_job: [!(result.jobRun?.job != null && (result.jobRun.job.id !== run.job.id
          || result.jobRun.job.type != null && result.jobRun.job.type !== run.job.type
          || result.jobRun.job.url != null && !publicJobUrl(result.jobRun.job.url, env))), result.jobRun?.job],
        links_array: [Array.isArray(result.links), result.links], known_links: [Array.isArray(result.links) && !result.links.some(link => typeof link?.url === 'string'
          && (link?.url.startsWith('https://github.com/paperclipai/paperclip/actions/runs/') && link?.url !== runUrl
            || link?.url.startsWith('https://github.com/paperclipai/paperclip/commit/') && link?.url !== sourceUrl))],
      }));
      if (!['passed', 'failed', 'broken', 'skipped', 'unknown'].includes(result.status)) stopUpload('chat_testops_upload_mismatch', 'result_status', () => ({
        status_supported: [['passed', 'failed', 'broken', 'skipped', 'unknown'].includes(result.status), result.status],
      }));
      if (result.status !== 'unknown' && result.status !== exported.status) stopUpload('chat_testops_upload_mismatch', 'result_status', () => ({
        status_matches_export: [result.status === 'unknown' || result.status === exported.status, result.status],
      }));
      const attached = await get(`/api/testresult/attachment?${new URLSearchParams({ testResultId: String(row.id), page: '0', size: '100' })}`);
      if (!Array.isArray(attached?.content) || attached.content.length > 10 || !Number.isSafeInteger(attached.totalElements)
        || attached.totalElements !== attached.content.length || !Number.isSafeInteger(attached.totalPages) || attached.totalPages < 0 || attached.totalPages > 1
        || new Set(attached.content.map(value => value?.id)).size !== attached.content.length
        || attached.content.some(value => !id(value?.id) || value?.fromTestCase === true)) stopUpload('chat_testops_upload_mismatch', 'attachment_page', () => ({
        content_array: [Array.isArray(attached?.content), attached?.content], content_limit: [Array.isArray(attached?.content) && attached.content.length <= 10],
        total_integer: [Number.isSafeInteger(attached?.totalElements), attached?.totalElements],
        total_matches_content: [Array.isArray(attached?.content) && attached.totalElements === attached.content.length],
        pages_integer: [Number.isSafeInteger(attached?.totalPages), attached?.totalPages],
        pages_range: [Number.isSafeInteger(attached?.totalPages) && attached.totalPages >= 0 && attached.totalPages <= 1],
        unique_ids: [Array.isArray(attached?.content) && new Set(attached.content.map(value => value?.id)).size === attached.content.length],
        ids_valid: [Array.isArray(attached?.content) && attached.content.every(value => id(value?.id))],
        not_inherited: [Array.isArray(attached?.content) && !attached.content.some(value => value?.fromTestCase === true)],
        attachment_rows: [Array.isArray(attached?.content) && !attached.content.some(value => !id(value?.id) || value?.fromTestCase === true)],
      }));
      const withinDeadline = now() < deadline;
      const missedCount = attached.content.filter(value => value?.missed === true).length;
      const signaturesMatch = same(signature(attached.content), signature(exported.attachmentMetadata));
      const resultStatusMatches = result.status === exported.status;
      const ready = withinDeadline && resultStatusMatches && missedCount === 0 && signaturesMatch;
      attachmentReadiness.push({ poll: poll + 1, attachmentCount: attached.content.length, missedCount, signaturesMatch, resultStatusMatches, withinDeadline, ready });
      if (ready) {
        return { schema: 'paperclip.chat-feature-testops-upload-verification/v1', ...context, projectId: 1, planId: selected.planId,
          jobId: selected.jobId, allureJobRunId: selected.allureJobRunId, launchId: selected.launchId, caseId: selected.caseId,
          resultId: result.id, executionId, status: result.status, cleanup: exported.cleanup, verification: 'VERIFIED',
          attachments: exported.attachmentMetadata.map(value => ({ ...value })), attachmentReadiness,
          launchUrl: `${endpoint}/launch/${selected.launchId}`, resultUrl: `${endpoint}/testresult/${result.id}` };
      }
    }
    if (poll < 11 && now() + 5000 < deadline) await wait(5000);
  }
  unverified();
}
