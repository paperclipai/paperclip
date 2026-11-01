import { testopsClient, endpoint } from './chat-feature-testops-api.mjs';
import { cases, planName, targetSha, workflow, positive, reject, validateSelection } from './chat-completion-testops-contract.mjs';

export { testopsClient, endpoint };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pageRows = value => {
  if (!Array.isArray(value?.content) || value.content.length > 100 || !Number.isSafeInteger(value.totalPages)
    || value.totalPages < 0 || value.totalPages > 1) reject('incomplete_page');
  return value.content;
};
export function bindingFromEnv(env) {
  let value;
  try { value = JSON.parse(env.CHAT_COMPLETION_TESTOPS_BINDING); } catch { reject('binding_missing'); }
  if (!positive(value.planId) || !positive(value.jobId) || !positive(value.integrationId)
    || !Array.isArray(value.cases) || value.cases.length !== cases.length) reject('binding');
  const selected = cases.map(row => {
    const matched = value.cases.filter(v => v.key === row.key);
    if (matched.length !== 1 || !positive(matched[0].caseId)) reject('binding');
    return { ...row, caseId: matched[0].caseId };
  });
  if (new Set(selected.map(row => row.caseId)).size !== cases.length) reject('binding');
  return { planId: value.planId, jobId: value.jobId, integrationId: value.integrationId, cases: selected };
}
export function isWorkflowUrl(url, workflowId) {
  return url === `https://github.com/paperclipai/paperclip/actions/workflows/${workflow.split('/').at(-1)}`
    || positive(workflowId) && url === `https://github.com/paperclipai/paperclip/actions/workflows/${workflowId}`
    || url === 'https://github.com/paperclipai/paperclip/actions?query=workflow%3A%22Chat+completion+TestOps%22';
}
function assertCase(actual, expected) {
  if (actual.id !== expected.caseId || actual.projectId !== 1 || actual.fullName !== expected.fullName
    || actual.automated !== true || actual.deleted === true) reject('case_mismatch');
}
function assertPlan(actual, binding) {
  const selected = binding.cases.map(row => row.caseId).sort((a, b) => a - b);
  if (actual.id !== binding.planId || actual.projectId !== 1 || actual.name !== planName || actual.testCasesCount !== selected.length
    || !Array.isArray(actual.treeSelection?.leafsInclude) || !same([...actual.treeSelection.leafsInclude].sort((a, b) => a - b), selected)
    || actual.treeSelection.inverted === true || (actual.treeSelection.groupsInclude?.length ?? 0) !== 0
    || (actual.treeSelection.leafsExclude?.length ?? 0) !== 0) reject('plan_mismatch');
}
function assertJob(job, binding, workflowId) {
  if (job.id !== binding.jobId || job.type !== 'github' || !isWorkflowUrl(job.url, workflowId)) reject('job_mismatch');
}
function assertBranchDefinition(job) {
  // Observed job-definition DTO, not the id/value plan-override DTO.
  if (!Array.isArray(job.parameters) || job.parameters.length !== 1 || !positive(job.parameters[0]?.id)
    || job.parameters[0].name !== 'Branch' || job.parameters[0].defaultValue !== 'refs/heads/master'
    || Object.hasOwn(job.parameters[0], 'value')) reject('job_parameters');
}

export async function validatePilotSelection(api, env, context, workflowId) {
  const binding = bindingFromEnv(env);
  for (const row of binding.cases) assertCase(await api(`/api/testcase/${row.caseId}`), row);
  assertPlan(await api(`/api/testplan/${binding.planId}`), binding);
  const jobs = await api(`/api/testplan/${binding.planId}/job`);
  if (!Array.isArray(jobs) || jobs.length !== 1 || jobs[0].job?.id !== binding.jobId || jobs[0].testCasesCount !== cases.length) reject('plan_job_mismatch');
  assertJob(await api(`/api/job/${binding.jobId}`), binding, workflowId);
  const run = await api(`/api/jobrun/${env.ALLURE_JOB_RUN_ID}`);
  if (run.id !== Number(env.ALLURE_JOB_RUN_ID) || run.job?.id !== binding.jobId || run.job?.type !== 'github'
    || !['scheduled', 'in_progress'].includes(run.stage) || !positive(run.launchId)
    || run.url !== `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}`) reject('jobrun_mismatch');
  const launch = await api(`/api/launch/${run.launchId}`);
  if (launch.id !== run.launchId || launch.projectId !== 1 || launch.closed === true) reject('launch_mismatch');
  const planned = await api(`/api/jobrun/${run.id}/plan?expected=true`);
  if (!Array.isArray(planned) || !planned.length || planned.length > cases.length || new Set(planned.map(row => row.id)).size !== planned.length) reject('selection');
  const selected = planned.map(row => {
    const found = binding.cases.find(value => value.caseId === row.id && value.fullName === row.selector);
    if (!found) reject('foreign_selection');
    return found;
  });
  const value = { schema: 'paperclip.chat-completion-testops-selection/v1', ...context,
    targetSha, allureJobRunId: env.ALLURE_JOB_RUN_ID, projectId: 1, planId: binding.planId,
    jobId: binding.jobId, launchId: launch.id, cases: cases.flatMap(row => selected.filter(value => value.key === row.key)) };
  validateSelection(value, context, env.ALLURE_JOB_RUN_ID);
  return value;
}

export async function inspectPilotCatalog(api) {
  const found = new Map(), seen = new Set(); let pages, total;
  for (let index = 0; index < 10; index++) {
    const page = await api(`/api/testcase?${new URLSearchParams({ projectId: '1', page: String(index), size: '100', sort: 'id,asc' })}`);
    if (!Array.isArray(page?.content) || page.content.length > 100 || page.number !== index
      || !Number.isSafeInteger(page.totalPages) || page.totalPages < 0 || page.totalPages > 10
      || !Number.isSafeInteger(page.totalElements) || page.totalElements < 0 || page.totalElements > 1000
      || pages !== undefined && (pages !== page.totalPages || total !== page.totalElements)) reject('catalog_incomplete');
    pages = page.totalPages; total = page.totalElements;
    for (const row of page.content) {
      if (!positive(row.id) || seen.has(row.id)) reject('catalog_incomplete');
      seen.add(row.id);
      const actual = await api(`/api/testcase/${row.id}`);
      if (actual.id !== row.id || actual.projectId !== 1) reject('case_mismatch');
      const expected = cases.find(value => value.fullName === actual.fullName);
      if (!expected) continue;
      if (found.has(expected.key)) reject('case_conflict');
      assertCase(actual, { ...expected, caseId: actual.id });
      found.set(expected.key, { ...expected, caseId: actual.id });
    }
    if (index + 1 >= pages) break;
  }
  if (seen.size !== total) reject('catalog_incomplete');
  const plans = pageRows(await api(`/api/testplan?${new URLSearchParams({ projectId: '1', name: planName, page: '0', size: '100' })}`)).filter(row => row.name === planName);
  if (plans.length > 1 || plans.some(row => row.projectId !== 1 || !positive(row.id))) reject('plan_conflict');
  return { cases: [...found.values()], plans: plans.map(row => ({ id: row.id, name: row.name })) };
}

export async function bootstrapPilotPlan(api, integrationId, markOnce) {
  if (!positive(integrationId)) reject('integration');
  const integration = await api(`/api/integration/${integrationId}/project/1`);
  if (integration.id !== integrationId || integration.projectId !== 1 || integration.info?.type !== 'github' || integration.disabled !== false) reject('integration');
  const inspected = await inspectPilotCatalog(api);
  if (inspected.plans.length && inspected.cases.length !== cases.length) reject('plan_conflict');
  const selected = [...inspected.cases];
  for (const row of cases) {
    if (selected.some(value => value.key === row.key)) continue;
    await markOnce(`create_case_${row.key}`);
    const created = await api('/api/testcase', 'POST', { projectId: 1, name: row.name, fullName: row.fullName, automated: true });
    if (!positive(created?.id)) reject('created_case');
    assertCase(created, { ...row, caseId: created.id });
    selected.push({ ...row, caseId: created.id });
  }
  const ordered = cases.map(row => selected.find(value => value.key === row.key));
  let planId = inspected.plans[0]?.id;
  if (!planId) {
    await markOnce('create_plan');
    const created = await api('/api/testplan', 'POST', { projectId: 1, name: planName,
      treeSelection: { inverted: false, leafsInclude: ordered.map(row => row.caseId) } });
    if (!positive(created?.id)) reject('created_plan'); planId = created.id;
  }
  const binding = { planId, integrationId, cases: ordered };
  assertPlan(await api(`/api/testplan/${planId}`), binding);
  return binding;
}

export async function completePilotRegistration(api, prepared, official, context, workflowId, markOnce, observe = async () => {}) {
  const run = await api(`/api/jobrun/${official.jobRunId}`);
  if (run.id !== Number(official.jobRunId) || run.job?.type !== 'github' || !positive(run.job?.id)
    || run.launchId !== official.launchId || run.url !== `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}`) reject('registration');
  const launch = await api(`/api/launch/${official.launchId}`);
  if (launch.id !== official.launchId || launch.projectId !== 1) reject('registration');
  const binding = { ...prepared, jobId: run.job.id };
  assertPlan(await api(`/api/testplan/${binding.planId}`), binding);
  const job = await api(`/api/job/${binding.jobId}`); assertJob(job, binding, workflowId);
  await observe({ schema: 'paperclip.chat-completion-testops-registration-observed/v1', ...context,
    projectId: 1, jobId: job.id, launchId: official.launchId, allureJobRunId: official.jobRunId,
    parameterCount: Array.isArray(job.parameters) ? job.parameters.length : null,
    parameters: Array.isArray(job.parameters) ? job.parameters.slice(0, 4).map(row => ({
      id: positive(row?.id) ? row.id : null, name: row?.name === 'Branch' ? 'Branch' : 'UNRESOLVED',
      defaultValue: row?.defaultValue === 'refs/heads/master' ? 'refs/heads/master' : 'NOT_PROJECTED',
      runtimeValuePresent: Object.hasOwn(row ?? {}, 'value') })) : null,
    qualification: 'inspection_only', actualResult: null });
  assertBranchDefinition(job);
  const assignments = await api(`/api/testplan/${binding.planId}/job`);
  if (!Array.isArray(assignments) || assignments.length > 1 || assignments.some(row => row.job?.id !== binding.jobId || row.testCasesCount !== cases.length)) reject('plan_job_mismatch');
  await markOnce('bind_owned_job');
  // PATCH only the documented enable/integration fields. Preserve the opaque
  // definition exactly; no guessed parameter-definition write codec is used.
  await api(`/api/job/${binding.jobId}`, 'PATCH', { integrationId: binding.integrationId, canRun: true });
  const patched = await api(`/api/job/${binding.jobId}`); assertJob(patched, binding, workflowId); assertBranchDefinition(patched);
  if (!same(patched.parameters, job.parameters) || (Object.hasOwn(patched, 'canRun') && patched.canRun !== true)) reject('job_parameters');
  if (!assignments.length) {
    await markOnce('assign_plan');
    await api(`/api/testplan/${binding.planId}/assign`, 'POST', { jobId: binding.jobId,
      selection: { inverted: false, manual: false, leafsInclude: binding.cases.map(row => row.caseId) } });
  }
  const bound = await api(`/api/testplan/${binding.planId}/job`);
  if (!Array.isArray(bound) || bound.length !== 1 || bound[0].job?.id !== binding.jobId || bound[0].testCasesCount !== cases.length) reject('plan_job_mismatch');
  return { schema: 'paperclip.chat-completion-testops-registration/v1', ...context, binding,
    parametersMode: 'job-defaults', branchDefinition: { id: job.parameters[0].id, name: 'Branch', defaultValue: 'refs/heads/master' },
    planUrl: `${endpoint}/testplan/${binding.planId}`, jobUrl: `${endpoint}/project/1/jobs`, qualification: 'registration_only', actualResult: null };
}

export async function launchPilotPlan(api, env, context, workflowId, markOnce) {
  const binding = bindingFromEnv(env);
  if (!/^[1-9][0-9]{0,15}$/.test(env.CHAT_COMPLETION_TESTOPS_LAUNCH_RUN_NUMBER ?? '')
    || env.GITHUB_RUN_NUMBER !== env.CHAT_COMPLETION_TESTOPS_LAUNCH_RUN_NUMBER
    || !/^[a-f0-9]{32}$/.test(env.CHAT_COMPLETION_TESTOPS_LAUNCH_NONCE ?? '')) reject('launch_fence');
  for (const row of binding.cases) assertCase(await api(`/api/testcase/${row.caseId}`), row);
  assertPlan(await api(`/api/testplan/${binding.planId}`), binding);
  const job = await api(`/api/job/${binding.jobId}`); assertJob(job, binding, workflowId);
  assertBranchDefinition(job);
  const assignments = await api(`/api/testplan/${binding.planId}/job`);
  if (!Array.isArray(assignments) || assignments.length !== 1 || assignments[0].job?.id !== binding.jobId
    || assignments[0].testCasesCount !== cases.length) reject('plan_job_mismatch');
  const name = `${planName} · ${env.CHAT_COMPLETION_TESTOPS_LAUNCH_NONCE}`;
  const existing = pageRows(await api(`/api/launch?${new URLSearchParams({ projectId: '1', search: name, page: '0', size: '100' })}`));
  if (existing.length) reject('launch_already_requested');
  await markOnce('launch_plan');
  const launched = await api(`/api/testplan/${binding.planId}/run`, 'POST', { launchName: name });
  if (!positive(launched?.id) || launched.projectId !== 1 || launched.name !== name) reject('launch_mismatch');
  return { schema: 'paperclip.chat-completion-testops-launch/v1', ...context, launchId: launched.id,
    planId: binding.planId, jobId: binding.jobId, caseIds: binding.cases.map(row => row.caseId),
    launchUrl: `${endpoint}/launch/${launched.id}`, status: 'REQUESTED', actualResult: null };
}

export async function verifyPilotUpload(api, selection, context, exported, { now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const selected = validateSelection(selection, context, selection.allureJobRunId);
  if (!Array.isArray(exported) || exported.length !== selected.length || new Set(exported.map(row => row.caseId)).size !== selected.length) reject('export_mismatch');
  for (const row of exported) {
    const found = selected.find(value => value.caseId === row.caseId);
    if (!found || row.executionId !== found.executionId || !['passed', 'failed'].includes(row.status)
      || !['passed', 'failed', 'not_started'].includes(row.cleanup) || row.status === 'passed' && row.cleanup !== 'passed'
      || !Array.isArray(row.attachments) || row.attachments.length !== 2
      || row.attachments.filter(value => value.name === 'Execution provenance and checks' && value.contentType === 'application/json').length !== 1
      || row.attachments.filter(value => value.name === 'Private evidence receipt' && value.contentType === 'application/json').length !== 1
      || row.attachments.some(value => !['Execution provenance and checks', 'Private evidence receipt'].includes(value.name)
        || !Number.isSafeInteger(value.contentLength) || value.contentLength <= 0 || value.contentLength > 12 * 1024 * 1024
        || value.contentType !== 'application/json')) reject('export_mismatch');
  }
  const deadline = now() + 120_000;
  const get = route => {
    const remaining = deadline - now(); if (remaining < 1) reject('upload_unverified');
    return api(route, 'GET', undefined, Math.min(30_000, remaining));
  };
  const signature = rows => rows.map(row => JSON.stringify([row.name, row.contentType, row.contentLength])).sort();
  for (let poll = 0; poll < 12 && now() < deadline; poll++) {
    const run = await get(`/api/jobrun/${selection.allureJobRunId}`);
    const runUrl = `https://github.com/paperclipai/paperclip/actions/runs/${context.runId}`;
    if (run.id !== Number(selection.allureJobRunId) || run.job?.id !== selection.jobId || run.job?.type !== 'github'
      || !['in_progress', 'finished'].includes(run.stage)
      || run.launchId !== selection.launchId || run.url !== runUrl) reject('jobrun_mismatch');
    const launch = await get(`/api/launch/${selection.launchId}`);
    if (launch.id !== selection.launchId || launch.projectId !== 1) reject('launch_mismatch');
    const page = await get(`/api/testresult?${new URLSearchParams({ launchId: String(selection.launchId), page: '0', size: '100' })}`);
    const listed = pageRows(page);
    if (!Number.isSafeInteger(page.totalElements) || page.totalElements !== listed.length || listed.length > selected.length
      || new Set(listed.map(row => row.id)).size !== listed.length || new Set(listed.map(row => row.testCaseId)).size !== listed.length) reject('result_page');
    let ready = listed.length === selected.length; const verified = [];
    for (const listedRow of listed) {
      const expected = selected.find(value => value.caseId === listedRow.testCaseId);
      if (!expected || !positive(listedRow.id)) reject('foreign_result');
      const wanted = exported.find(value => value.caseId === expected.caseId);
      const result = await get(`/api/testresult/${listedRow.id}`);
      if (result.id !== listedRow.id || result.projectId !== 1 || result.launchId !== selection.launchId || result.testCaseId !== expected.caseId
        || result.fullName !== expected.fullName || result.jobRun?.id !== Number(selection.allureJobRunId)
        || result.jobRun?.launchId !== selection.launchId || result.jobRun?.url !== runUrl
        || result.jobRun.job != null && (result.jobRun.job.id !== selection.jobId
          || result.jobRun.job.type != null && result.jobRun.job.type !== 'github'
          || result.jobRun.job.url != null && !isWorkflowUrl(result.jobRun.job.url, context.workflowId))
        || !Array.isArray(result.links) || result.links.some(link => typeof link.url === 'string'
          && (link.url.startsWith('https://github.com/paperclipai/paperclip/actions/runs/') && link.url !== runUrl
            || link.url.startsWith('https://github.com/paperclipai/paperclip/commit/') && link.url !== `https://github.com/paperclipai/paperclip/commit/${targetSha}`))
        || !['unknown', wanted.status].includes(result.status)) reject('result_mismatch');
      const attached = await get(`/api/testresult/attachment?${new URLSearchParams({ testResultId: String(result.id), page: '0', size: '100' })}`);
      const attachments = pageRows(attached);
      if (attached.totalElements !== attachments.length || attachments.length > 10 || new Set(attachments.map(row => row.id)).size !== attachments.length
        || attachments.some(row => !positive(row.id) || row.fromTestCase === true)) reject('attachment_mismatch');
      // TestOps may publish result metadata before its attachment processing is
      // ready. Keep every final requirement; wait within the existing bound.
      const complete = result.status === wanted.status && attachments.every(row => row.missed === false && row.fromTestCase === false)
        && same(signature(attachments), signature(wanted.attachments));
      ready &&= complete;
      verified.push({ executionId: expected.executionId, caseId: expected.caseId, resultId: result.id,
        status: result.status, cleanup: wanted.cleanup, attachmentsVerified: complete, resultUrl: `${endpoint}/testresult/${result.id}` });
    }
    if (ready && now() < deadline) return { schema: 'paperclip.chat-completion-testops-verification/v1', ...context,
      projectId: 1, planId: selection.planId, jobId: selection.jobId, launchId: selection.launchId,
      allureJobRunId: selection.allureJobRunId, verification: 'VERIFIED', results: verified, launchUrl: `${endpoint}/launch/${selection.launchId}` };
    if (poll < 11 && now() + 5000 < deadline) await wait(5000);
  }
  reject('upload_unverified');
}
