import { createHash, randomUUID } from 'node:crypto';

// These are the standing, reviewed TestOps plan-2 identities. A case selects one
// existing full-stack cell; it does not change the prompt, matcher or runtime.
export const productRegressionCases = [
  [8, 'core-compatibility', 'plan-revise-accept'],
  [9, 'configured-repository', 'repository-output'],
  [30, 'core-compatibility', 'ask-question'],
  [32, 'first-task', 'reject-no-execution'],
  [35, 'agent-chat', 'reassign-task'],
  [45, 'agent-chat', 'multi-repository'],
  [54, 'task-workspaces', 'task-directory-repository-resume', 'runner-opencode'],
  [60, 'first-task', 'task-card-accept'],
  [61, 'continuation', 'completed-action-resume'],
  [62, 'agent-chat', 'clarify-reuse'],
  [66, 'core-compatibility', 'message-marker'],
  [68, 'continuation', 'revision-preserves-approval'],
  [112, 'agent-chat', 'create-backlog'],
  [123, 'first-task', 'revise-accept'],
  [134, 'first-task', 'clarify-propose-accept'],
  [140, 'agent-chat', 'stop-new-resume'],
  [145, 'agent-chat', 'continuity-restart'],
  [159, 'continuation', 'clarification-not-approval'],
  [164, 'agent-chat', 'plan-handoff'],
  [168, 'agent-chat', 'new-session'],
].map(([id, suite, name, profile = 'runner-codex']) => Object.freeze({
  id, suite, name, profile,
  model: suite === 'task-workspaces' ? 'openrouter/deepseek/deepseek-v4-flash-0731'
    : suite === 'configured-repository' ? 'gpt-6.1-sol' : 'gpt-5.6-sol',
  fullName: `paperclip.Product E2E.${suite}.${name}`,
  executionId: `${suite}.${profile}.local.${name}`,
}));

const fail = code => { throw new Error(`product_regression_testops_${code}`); };
const sha = value => createHash('sha256').update(value).digest('hex');
// Closed transmission contracts, checked against all 20 catalog cells. Dynamic
// matcher paths stay in the linked source artifact; only their digest leaves it.
export const productReportingModels = [...new Set(productRegressionCases.map(row => row.model))];
export const productReportingMatcherKinds = ['message_exact', 'message_contains', 'message_occurrences', 'message_regex',
  'message_ordered', 'issue_status', 'run_status', 'runtime_mode', 'environment', 'file_exists', 'file_exact',
  'file_contains', 'artifact_exists', 'artifact_exact', 'json_path', 'json_schema'];
const failureClasses = ['candidate_failure', 'provider_variance', 'transient_infrastructure', 'permanent_infrastructure',
  'secret_leak', 'cleanup_failure', 'setup_blocked'];
export const endpoint = 'https://paperclip.testops.cloud';
export const workflowUrl = 'https://github.com/paperclipai/paperclip/actions/workflows/runner-full-stack-e2e.yml';
// Official GitHub/Allure job metadata uses these exact aliases for workflow
// 343807492, independently read from GitHub's workflow API before registration.
export const workflowUrls = new Set([workflowUrl,
  'https://github.com/paperclipai/paperclip/blob/master/.github/workflows/runner-full-stack-e2e.yml',
  'https://github.com/paperclipai/paperclip/actions/workflows/343807492',
]);

export function selectProductRegression(plan, manual = 'all', fromTestOps = false) {
  if (fromTestOps && !plan) fail('plan_required');
  if (plan) {
    if (plan.version !== '1.0' || !Array.isArray(plan.tests) || !plan.tests.length || plan.tests.length > productRegressionCases.length) fail('plan_invalid');
    const selected = plan.tests.map(test => {
      const row = productRegressionCases.find(value => String(value.id) === String(test.id));
      if (!row || test.selector !== row.fullName) fail('case_mismatch');
      return row;
    });
    if (new Set(selected.map(row => row.id)).size !== selected.length) fail('duplicate_case');
    return selected.sort((a, b) => a.id - b.id);
  }
  if (manual === 'all') return [...productRegressionCases];
  const selected = productRegressionCases.find(row => row.name === manual || String(row.id) === manual);
  if (!selected) fail('manual_selection_invalid');
  return [selected];
}

export function validateSelection(value, env) {
  if (value?.schema !== 'paperclip.product-regression-testops-selection/v1'
      || value.runId !== env.GITHUB_RUN_ID || value.attempt !== env.GITHUB_RUN_ATTEMPT
      || value.workflowSha !== env.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(value.workflowSha)
      || value.targetSha !== env.SOURCE_SHA || !/^[a-f0-9]{40}$/.test(value.targetSha)
      || !/^[1-9][0-9]{0,15}$/.test(value.jobRunId) || !Array.isArray(value.cases)
      || !value.cases.length || value.cases.length > productRegressionCases.length) fail('selection_binding');
  const selected = selectProductRegression({ version: '1.0', tests: value.cases.map(row => ({ id: row.id, selector: row.fullName })) }, 'all', true);
  if (JSON.stringify(selected) !== JSON.stringify(value.cases)) fail('selection_binding');
  return value;
}

export function projectProductResults(campaign, selection, sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail('source_missing');
  if (campaign && (campaign.schema !== 'paperclip.runner-e2e.campaign/v2'
      || campaign.campaignId !== `gha-${selection.runId}-${selection.attempt}` || campaign.source?.sha !== sourceSha
      || !Array.isArray(campaign.results) || !Array.isArray(campaign.expected)
      || JSON.stringify([...campaign.expected].sort()) !== JSON.stringify(selection.cases.map(row => row.executionId).sort()))) fail('report_binding');
  const rows = campaign?.results ?? [];
  if (rows.length > selection.cases.length || new Set(rows.map(row => row.executionId)).size !== rows.length
      || rows.some(row => !selection.cases.some(value => value.executionId === row.executionId))) fail('unexpected_result');
  const accounting = campaign?.accounting;
  if (accounting && (accounting.version !== 1 || !['retained_attempts', 'selected_results'].includes(accounting.scope)
      || !Array.isArray(accounting.attempts) || accounting.attempts.length > selection.cases.length * 10
      || !Number.isSafeInteger(accounting.missingAttempts) || accounting.missingAttempts < 0
      || !Number.isSafeInteger(accounting.excludedArtifacts) || accounting.excludedArtifacts < 0
      || accounting.attempts.some(row => !selection.cases.some(value => value.executionId === row.executionId)
        || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || row.attempt > 10
        || !['passed', 'failed'].includes(row.status) || !['passed', 'failed', 'not_started'].includes(row.cleanup)))) fail('accounting_invalid');
  const records = [], summaries = [];
  for (const selected of selection.cases) {
    const attempts = rows.filter(row => row.executionId === selected.executionId).sort((a, b) => a.attempt - b.attempt);
    if (new Set(attempts.map(row => row.attempt)).size !== attempts.length) fail('duplicate_attempt');
    if (!attempts.length) attempts.push(null);
    for (const result of attempts) {
      const missingArtifact = result?.attempt === 0 && result.status === 'failed'
        && result.failureClass === 'permanent_infrastructure' && result.cleanup === 'not_started'
        && result.error === 'No result artifact was uploaded' && result.matcherResults === undefined;
      if (result && ((!missingArtifact && result.source?.sha !== sourceSha)
          || (missingArtifact && result.source?.sha != null && result.source.sha !== sourceSha)
          || result.suiteId !== selected.suite || result.caseId !== selected.name
          || result.profileId !== selected.profile || result.environmentId !== 'local'
          || !Number.isSafeInteger(result.attempt) || result.attempt < (missingArtifact ? 0 : 1) || result.attempt > 10
          || !['passed', 'failed'].includes(result.status) || (!missingArtifact && !Array.isArray(result.matcherResults)))) fail('result_binding');
      const checks = result?.matcherResults ?? [];
      if (checks.length > 300 || checks.some(check => typeof check.passed !== 'boolean')) fail('checks_invalid');
      if ((result?.model != null && result.model !== selected.model)
          || (result?.failureClass != null && !failureClasses.includes(result.failureClass))
          || (result && !['passed', 'failed', 'not_started'].includes(result.cleanup))
          || checks.some(check => !productReportingMatcherKinds.includes(check.matcher?.kind))) fail('metadata_invalid');
      const passed = result?.status === 'passed' && result.cleanup === 'passed' && checks.length > 0 && checks.every(check => check.passed);
      const infrastructure = !result || ['permanent_infrastructure', 'transient_infrastructure', 'setup_blocked'].includes(result.failureClass);
      const status = passed ? 'passed' : infrastructure ? 'broken' : 'failed';
      const provenance = {
        schema: 'paperclip.product-regression-testops-result/v1', caseId: selected.id,
        executionId: selected.executionId, workflowRunId: selection.runId, workflowAttempt: selection.attempt,
        workflowSha: selection.workflowSha, sourceSha, status, originalStatus: result?.status ?? null,
        attempt: result?.attempt ?? null, cleanup: result?.cleanup ?? 'not_started',
        profile: selected.profile, environment: 'local',
        model: result?.model ?? null,
        suiteDefinitionHash: /^[a-f0-9]{64}$/.test(result?.suiteDefinitionHash ?? '') ? result.suiteDefinitionHash : null,
        failureClass: result?.failureClass ?? null,
        durationMs: Number.isFinite(result?.durationMs) && result.durationMs >= 0 ? result.durationMs : null,
        checks: checks.map((check, index) => ({
          name: check.matcher.kind, ordinal: index + 1,
          pathSha256: typeof check.matcher.path === 'string' ? sha(check.matcher.path) : null,
          passed: check.passed,
        })),
        retainedAttempts: (accounting?.attempts ?? []).filter(row => row.executionId === selected.executionId).map(row => ({
          attempt: row.attempt, status: row.status, cleanup: row.cleanup,
          durationMs: Number.isFinite(row.durationMs) && row.durationMs >= 0 ? row.durationMs : null,
          startedAt: Number.isFinite(Date.parse(row.startedAt)) ? new Date(row.startedAt).toISOString() : null,
          finishedAt: Number.isFinite(Date.parse(row.finishedAt)) ? new Date(row.finishedAt).toISOString() : null,
        })),
        attemptAccounting: accounting ? { scope: accounting.scope, missingAttempts: accounting.missingAttempts,
          excludedArtifacts: accounting.excludedArtifacts } : null,
        note: result && !missingArtifact ? 'Original full-stack assertions, attempts and diagnostics remain in the linked workflow report.'
          : 'No bound full-stack result was retained. This case is unverified and cannot pass.',
      };
      const uuid = randomUUID(), attachment = `${randomUUID()}-attachment.json`;
      const value = {
        uuid, name: selected.name, fullName: selected.fullName, testCaseId: sha(selected.fullName),
        historyId: sha(JSON.stringify([selected.fullName, selected.profile, provenance.model, 'local'])),
        status, stage: 'finished', statusDetails: { message: provenance.note },
        labels: [{ name: 'AS_ID', value: String(selected.id) }, { name: 'parentSuite', value: 'Product E2E' },
          { name: 'suite', value: selected.suite }, { name: 'framework', value: 'Paperclip Evals' }],
        parameters: [{ name: 'profile', value: selected.profile }, { name: 'environment', value: 'local / GitHub Actions' },
          { name: 'model', value: provenance.model ?? 'Not recorded' }, { name: 'sourceSha', value: sourceSha }],
        links: [{ name: 'Full-stack execution and retained diagnostics', type: 'custom',
          url: `https://github.com/paperclipai/paperclip/actions/runs/${selection.runId}` },
        { name: 'Evaluated source', type: 'custom', url: `https://github.com/paperclipai/paperclip/commit/${sourceSha}` }],
        attachments: [{ name: 'Bound execution provenance and assertions', source: attachment, type: 'application/json' }],
        steps: provenance.checks.map(check => ({ name: `${check.ordinal}. ${check.name}`, status: check.passed ? 'passed' : 'failed', stage: 'finished' })),
      };
      if (result && !missingArtifact) for (const [key, date] of [['start', result.startedAt], ['stop', result.finishedAt]]) {
        const timestamp = Date.parse(date);
        if (Number.isFinite(timestamp)) value[key] = timestamp;
      }
      records.push({ file: `${uuid}-result.json`, value }, { file: attachment, value: provenance });
      if (result === attempts.at(-1)) summaries.push({ caseId: selected.id, status });
    }
  }
  return { records, summary: { selected: selection.cases.length, passed: summaries.filter(row => row.status === 'passed').length,
    failed: summaries.filter(row => row.status === 'failed').length, broken: summaries.filter(row => row.status === 'broken').length,
    fullPlan: selection.cases.length === productRegressionCases.length, cases: summaries } };
}
