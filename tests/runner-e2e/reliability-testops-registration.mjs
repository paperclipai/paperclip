import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { testopsClient } from './chat-feature-testops-api.mjs';
import { endpoint, productRegressionCases, workflowUrls } from './product-regression-testops.mjs';
import { reliabilityDefinitions, reliabilityPlanName, reliabilityRegistration } from './reliability-testops.mjs';

// One-shot, idempotent registration of the Reliability plan in TestOps. It runs
// only in the trusted registration workflow, which alone receives ALLURE_TOKEN.
// `inspect` only reads. `register` reuses existing cases by full name, creates
// any missing case and the plan, and assigns the plan to the same GitHub job
// that launches the standing Product regression plan. TestOps assigns every ID;
// the receipt carries them into one reviewed change to reliability-testops.mjs.

const fail = code => { throw new Error(`reliability_testops_registration_${code}`); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sorted = values => [...values].sort((a, b) => a - b);
export const registrationWorkflowRef = 'paperclipai/paperclip/.github/workflows/runner-e2e-testops-registration.yml@refs/heads/master';
export const standingPlanId = 2;
const maximumCatalogPages = 30;

export function admitRegistration(env) {
  if (env.GITHUB_REPOSITORY !== 'paperclipai/paperclip' || env.GITHUB_REF !== 'refs/heads/master'
      || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_WORKFLOW_REF !== registrationWorkflowRef
      || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !/^[1-9][0-9]{0,15}$/.test(env.GITHUB_RUN_ID ?? '')
      || env.ALLURE_ENDPOINT !== endpoint || env.ALLURE_PROJECT_ID !== '1' || env.REGISTRATION_PLAN !== 'reliability'
      || !['inspect', 'register'].includes(env.REGISTRATION_OPERATION)) fail('untrusted_context');
  return env.REGISTRATION_OPERATION;
}

export function desiredCase(row) {
  return {
    name: `Reliability · ${row.name} (${row.signature})`,
    automated: true,
    description: [
      `Staging-soak reliability case ${row.name} (soak signature ${row.signature}).`,
      `Runs the existing full-stack cell ${row.executionId}: profile ${row.profile} with ${row.model} on ${row.environment}.`,
      'Launched by the Reliability TestOps plan through runner-full-stack-e2e.yml. Registration is not a result or a qualification claim.',
    ].join('\n\n'),
  };
}

const page = (value, number) => {
  if (!Array.isArray(value?.content) || value.content.length > 100 || value.number !== number
      || !Number.isSafeInteger(value.totalPages) || value.totalPages < 0 || value.totalPages > maximumCatalogPages
      || !Number.isSafeInteger(value.totalElements) || value.totalElements < 0) fail('catalog_page');
  return value;
};

/** Read-only state: matching cases by full name, the plan by name, and the standing plan's job. */
export async function inspectReliability(api) {
  const wanted = new Map(reliabilityDefinitions.map(row => [row.fullName, row]));
  const found = new Map(), seen = new Set();
  let total;
  for (let number = 0; number < maximumCatalogPages; number++) {
    const listed = page(await api(`/api/testcase?${new URLSearchParams({ projectId: '1', page: String(number), size: '100', sort: 'id,asc' })}`), number);
    if (total !== undefined && total !== listed.totalElements) fail('catalog_changed');
    total = listed.totalElements;
    const ids = listed.content.map(row => {
      if (!positive(row?.id) || seen.has(row.id)) fail('catalog_identity');
      seen.add(row.id); return row.id;
    });
    for (let offset = 0; offset < ids.length; offset += 8) {
      const batch = ids.slice(offset, offset + 8);
      const details = await Promise.all(batch.map(id => api(`/api/testcase/${id}`)));
      for (const [index, actual] of details.entries()) {
        if (actual?.id !== batch[index] || actual.projectId !== 1) fail('catalog_case');
        const row = wanted.get(actual.fullName);
        if (!row || actual.deleted === true) continue;
        if (found.has(row.name)) fail('case_conflict');
        found.set(row.name, actual.id);
      }
    }
    if (number + 1 >= listed.totalPages) break;
    if (number + 1 === maximumCatalogPages) fail('catalog_too_large');
  }
  if (seen.size !== total) fail('catalog_incomplete');
  if ([...found.values()].some(id => productRegressionCases.some(row => row.id === id))) fail('case_conflict');

  const plans = await api(`/api/testplan?${new URLSearchParams({ projectId: '1', name: reliabilityPlanName, page: '0', size: '100' })}`);
  if (!Array.isArray(plans?.content) || plans.totalPages > 1) fail('plan_page');
  const named = plans.content.filter(row => row.name === reliabilityPlanName);
  if (named.length > 1) fail('plan_conflict');
  let plan = null;
  if (named.length) {
    plan = await api(`/api/testplan/${named[0].id}`);
    if (!positive(plan?.id) || plan.id !== named[0].id || plan.id === standingPlanId || plan.projectId !== 1
        || plan.name !== reliabilityPlanName) fail('plan_identity');
  }
  const standing = await api(`/api/testplan/${standingPlanId}/job`);
  if (!Array.isArray(standing)) fail('standing_job');
  const candidates = standing.filter(row => row?.job?.type === 'github' && workflowUrls.has(row.job.url));
  if (candidates.length !== 1 || !positive(candidates[0].job.id)) fail('standing_job');
  const job = await api(`/api/job/${candidates[0].job.id}`);
  if (job?.id !== candidates[0].job.id || job.type !== 'github' || !workflowUrls.has(job.url)) fail('standing_job');
  const assignments = plan ? jobAssignments(await api(`/api/testplan/${plan.id}/job`)) : [];
  return { caseIds: Object.fromEntries(found), plan, jobId: job.id,
    standingParameters: Array.isArray(candidates[0].job.parameters) ? candidates[0].job.parameters : [], assignments };
}

function assertPlan(plan, ids) {
  const selection = plan?.treeSelection;
  if (!positive(plan?.id) || plan.projectId !== 1 || plan.name !== reliabilityPlanName || !selection || selection.inverted === true
      || !Array.isArray(selection.leafsInclude) || !same(sorted(selection.leafsInclude), sorted(ids))
      || ['groupsInclude', 'leafsExclude'].some(key => (selection[key]?.length ?? 0) > 0)) fail('plan_scope');
}

export async function registerReliability(api) {
  const before = await inspectReliability(api);
  const created = { cases: [], plan: false, assignment: false, parameters: false };
  const caseIds = {};
  for (const row of reliabilityDefinitions) {
    if (before.caseIds[row.name]) { caseIds[row.name] = before.caseIds[row.name]; continue; }
    const response = await api('/api/testcase', 'POST', { projectId: 1, fullName: row.fullName, ...desiredCase(row) });
    if (!positive(response?.id)) fail('created_case');
    const actual = await api(`/api/testcase/${response.id}`);
    if (actual?.id !== response.id || actual.projectId !== 1 || actual.fullName !== row.fullName || actual.automated !== true) fail('created_case');
    caseIds[row.name] = actual.id;
    created.cases.push(row.name);
  }
  const ids = reliabilityDefinitions.map(row => caseIds[row.name]);
  if (new Set(ids).size !== ids.length) fail('case_conflict');
  const treeSelection = { inverted: false, leafsInclude: ids, groupsInclude: [], groupsExclude: [], leafsExclude: [] };
  let plan = before.plan;
  if (!plan) {
    const response = await api('/api/testplan', 'POST', { projectId: 1, name: reliabilityPlanName, treeSelection });
    if (!positive(response?.id) || response.id === standingPlanId) fail('created_plan');
    plan = await api(`/api/testplan/${response.id}`);
    created.plan = true;
  } else if (!same(sorted(plan.treeSelection?.leafsInclude ?? []), sorted(ids))) {
    await api(`/api/testplan/${plan.id}`, 'PATCH', { treeSelection });
    plan = await api(`/api/testplan/${plan.id}`);
  }
  assertPlan(plan, ids);
  let assignments = jobAssignments(await api(`/api/testplan/${plan.id}/job`));
  if (assignments.length > 1 || assignments.some(row => row?.job?.id !== before.jobId)) fail('plan_job_conflict');
  if (!assignments.length) {
    await api(`/api/testplan/${plan.id}/assign`, 'POST', { jobId: before.jobId, selection: { inverted: false, manual: false, leafsInclude: ids } });
    created.assignment = true;
  }
  // A launch from this plan must dispatch exactly as the standing plan does.
  if (before.standingParameters.length && !same(assignments[0]?.job?.parameters ?? [], before.standingParameters)) {
    await api(`/api/testplan/${plan.id}/jobparameter`, 'POST', { jobId: before.jobId, parameters: before.standingParameters });
    created.parameters = true;
  }
  assignments = jobAssignments(await api(`/api/testplan/${plan.id}/job`));
  if (assignments.length !== 1 || assignments[0]?.job?.id !== before.jobId
      || assignments[0].testCasesCount !== ids.length
      || (before.standingParameters.length && !same(assignments[0].job.parameters ?? [], before.standingParameters))) fail('plan_job');
  return { caseIds, plan, jobId: before.jobId, created };
}

// TestOps lists a plan's cases that no job covers as a job-less row, e.g.
// `[{ testCasesCount: 7 }]` for a freshly created plan. That row is not a job
// assignment; only rows naming a job are.
function jobAssignments(rows) {
  if (!Array.isArray(rows)) fail('plan_job');
  return rows.filter(row => row?.job != null);
}

export function registrationReceipt(operation, state, env) {
  const caseIds = Object.fromEntries(reliabilityDefinitions.filter(row => state.caseIds[row.name]).map(row => [row.name, state.caseIds[row.name]]));
  const complete = Object.keys(caseIds).length === reliabilityDefinitions.length && positive(state.plan?.id)
    && (state.assignments ?? [{ job: { id: state.jobId } }]).some(row => row?.job?.id === state.jobId);
  const registration = { planId: state.plan?.id ?? null, caseIds };
  return {
    schema: 'paperclip.reliability-testops-registration/v1', operation,
    workflowRunId: env.GITHUB_RUN_ID, workflowSha: env.GITHUB_SHA,
    planName: reliabilityPlanName, planUrl: state.plan ? `${endpoint}/testplan/${state.plan.id}` : null,
    jobId: state.jobId, registration, complete,
    missing: reliabilityDefinitions.filter(row => !caseIds[row.name]).map(row => row.name),
    committed: same(registration, { planId: reliabilityRegistration.planId, caseIds: { ...reliabilityRegistration.caseIds } }),
    created: state.created ?? null,
    qualification: 'registration_only', actualResult: null,
  };
}

export function registrationSnippet(receipt) {
  const lines = reliabilityDefinitions.map(row => `    '${row.name}': ${receipt.registration.caseIds[row.name]},`);
  return ['export const reliabilityRegistration = Object.freeze({', `  planId: ${receipt.registration.planId},`,
    '  caseIds: Object.freeze({', ...lines, '  }),', '});'].join('\n');
}

export async function reliabilityRegistrationCli(output, env = process.env, fetchImpl = fetch) {
  const operation = admitRegistration(env);
  const api = await testopsClient(env.ALLURE_TOKEN, fetchImpl);
  const state = operation === 'register' ? await registerReliability(api) : await inspectReliability(api);
  const receipt = registrationReceipt(operation, state, env);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
  const body = receipt.complete
    ? `${receipt.committed ? 'The committed registration already matches TestOps.' : 'Commit these TestOps identities to `tests/runner-e2e/reliability-testops.mjs` in one reviewed change:'}\n\n\`\`\`js\n${registrationSnippet(receipt)}\n\`\`\`\n`
    : `Not registered yet. Missing cases: ${receipt.missing.join(', ') || 'none'}; plan: ${receipt.planUrl ?? 'absent'}. Dispatch again with operation \`register\`.\n`;
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `### Reliability TestOps registration (${operation})\n\n${body}`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reliabilityRegistrationCli(process.argv[2]).then(() => { process.exitCode = 0; }).catch(error => {
    const safe = /^(?:reliability_testops_registration|testops)_[a-z_]+$/.test(error.message) ? error.message : 'reliability_testops_registration_failed';
    process.stderr.write(`${safe}\n`); process.exitCode = 1;
  });
}
