import { createHash } from 'node:crypto';

// The catalog remains on its preservation/integration branch. Updating this
// immutable source pin requires a reviewed source change.
export const targetSha = 'de0941835cc8f0d01c982574ee258e110babdbeb';
export const launchSha256 = 'f2e69957c350b220b06edca49194a4bd07d70bc882f80838eeb7203184c0bd0d';
export const workflow = '.github/workflows/chat-completion-testops.yml';
export const planName = 'Chat completion pilot — OpenCode 1017';
export const model = 'openrouter/deepseek/deepseek-v4.1-flash-1017';
export const cases = Object.freeze([
  { key: 'control', scenario: 'instance-operations.restart-service', name: 'Restart an instance and retain the conversation', checks: 9, minimumRuns: 1, maximumRuns: 1 },
  { key: 'defaults', scenario: 'projects.project-defaults', name: 'Save project defaults for future work', checks: 11, minimumRuns: 3, maximumRuns: 3 },
  { key: 'work', scenario: 'projects.project-work', name: 'Create and delegate project work through chat', checks: 15, minimumRuns: 1, maximumRuns: 3 },
].map(row => Object.freeze({ ...row, executionId: `chat-features.runner-opencode.local.${row.scenario}`,
  fullName: `paperclip.Product E2E.chat-features.${row.scenario}` })));
export const positive = value => Number.isSafeInteger(value) && value > 0;
export const hash = value => createHash('sha256').update(value).digest('hex');
// These bounds are copied from the pinned source, not inferred from one
// measurement. The real-source control checks them before provider access.
export const validRunCount = (ids, descriptor) => Array.isArray(ids) && ids.length >= descriptor.minimumRuns
  && ids.length <= descriptor.maximumRuns && new Set(ids).size === ids.length;
const numeric = value => /^[1-9][0-9]{0,15}$/.test(value ?? '') && positive(Number(value));
export function reject(code) { throw new Error(`chat_completion_testops_${code}`); }

export function admitDispatch(env, event, triggeringActorId) {
  let allowed;
  try { allowed = JSON.parse(env.TESTOPS_ALLOWED_ACTOR_IDS); } catch { reject('actor'); }
  const branch = event.repository?.default_branch;
  const operation = event.inputs?.operation ?? 'evaluate';
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || env.GITHUB_REPOSITORY !== 'paperclipai/paperclip' || event.repository?.full_name !== 'paperclipai/paperclip'
    || event.repository?.private !== false || branch !== 'master' || env.GITHUB_REF !== 'refs/heads/master'
    || event.ref !== env.GITHUB_REF || env.GITHUB_WORKFLOW_REF !== `paperclipai/paperclip/${workflow}@refs/heads/master`
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || env.GITHUB_RUN_ATTEMPT !== '1'
    || !numeric(env.GITHUB_RUN_ID) || !numeric(env.GITHUB_ACTOR_ID) || event.sender?.id !== Number(env.GITHUB_ACTOR_ID)
    || !Array.isArray(allowed) || !allowed.length || allowed.some(v => !positive(v))
    || !allowed.includes(Number(env.GITHUB_ACTOR_ID)) || !allowed.includes(triggeringActorId)
    || !event.inputs || Object.keys(event.inputs).some(k => !['operation', 'ALLURE_JOB_RUN_ID', 'ALLURE_USERNAME'].includes(k))
    || !['bootstrap', 'evaluate', 'launch-plan'].includes(operation)
    || (operation === 'evaluate' ? !numeric(event.inputs.ALLURE_JOB_RUN_ID) : (event.inputs.ALLURE_JOB_RUN_ID ?? '') !== '')) reject('dispatch');
  return Object.freeze({ runId: env.GITHUB_RUN_ID, attempt: '1', workflowSha: env.GITHUB_SHA, targetSha, operation,
    actorId: Number(env.GITHUB_ACTOR_ID), triggeringActorId });
}

export function selectedCases(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > cases.length || new Set(rows.map(row => row.executionId)).size !== rows.length) reject('selection');
  const selected = cases.filter(row => rows.some(value => value.executionId === row.executionId));
  if (selected.length !== rows.length) reject('selection');
  for (const row of rows) {
    const expected = selected.find(value => value.executionId === row.executionId);
    if (!positive(row.caseId) || row.fullName !== expected.fullName || row.key !== expected.key || row.scenario !== expected.scenario) reject('selection');
  }
  if (new Set(rows.map(row => row.caseId)).size !== rows.length) reject('selection');
  return selected.map(expected => ({ ...expected, caseId: rows.find(row => row.executionId === expected.executionId).caseId }));
}

export function validateSelection(selection, context, jobRunId) {
  if (selection.schema !== 'paperclip.chat-completion-testops-selection/v1' || selection.projectId !== 1
    || selection.runId !== context.runId || selection.attempt !== '1' || selection.workflowSha !== context.workflowSha
    || selection.targetSha !== targetSha || selection.allureJobRunId !== jobRunId || !numeric(jobRunId)
    || ['planId', 'jobId', 'launchId'].some(key => !positive(selection[key]))) reject('selection_binding');
  return selectedCases(selection.cases);
}

// This authority is emitted only by the trusted main-only selector after an
// authenticated TestOps selection. The existing evidence validator, protocol,
// scanners, byte limits and exact-key S3 policies remain the enforcement owner.
export function evidencePolicy(selection, context, jobRunId) {
  const selected = validateSelection(selection, context, jobRunId);
  return { version: 1, approvals: [{ workflowSha: context.workflowSha, targetSha,
    runId: context.runId, attempt: '1', executionIds: selected.map(row => row.executionId),
    protocol: 'paperclip.manual-private-evidence/v1', launchSha256 }] };
}
