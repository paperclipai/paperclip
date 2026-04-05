
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, buildPromptVars } from '../src/server/prompt.js';

const ctx = {
  runId: 'run-1',
  agent: {
    id: 'agent-1',
    companyId: 'company-1',
    name: 'CEO Hermes',
    permissions: { canCreateAgents: true },
  },
  context: {
    taskId: 'ISS-12',
    taskTitle: 'Fix deployment',
    taskBody: 'Find and fix the deployment breakage.',
    approvalId: 'apr-1',
    approvalStatus: 'revision_requested',
    issueIds: ['ISS-12', 'ISS-9'],
    wakeCommentId: 'c-5',
    wakeReason: 'Board requested a revision',
    paperclipWorkspace: { cwd: '/tmp/work', repoUrl: 'https://example.com/repo.git', repoRef: 'main' },
  },
};

test('buildPromptVars makes approval and task context first-class', () => {
  const vars = buildPromptVars(ctx, {});
  assert.equal(vars.taskId, 'ISS-12');
  assert.equal(vars.approvalId, 'apr-1');
  assert.equal(vars.commentId, 'c-5');
  assert.equal(vars.canCreateAgents, true);
  assert.match(vars.workspaceSummary, /cwd: \/tmp\/work/);
});

test('buildPrompt renders task and approval sections', () => {
  const prompt = buildPrompt(ctx, { paperclipApiUrl: 'http://localhost:3100' });
  assert.match(prompt, /Assigned issue/);
  assert.match(prompt, /Approval context/);
  assert.match(prompt, /revision_requested/);
  assert.match(prompt, /\$PAPERCLIP_COMPANY_ID/);
  assert.match(prompt, /\$PAPERCLIP_AGENT_ID/);
  assert.match(prompt, /--data @\/tmp\/paperclip-agent-hire\.json/);
  assert.match(prompt, /\/approvals\/\$PAPERCLIP_APPROVAL_ID\/comments/);
  assert.match(prompt, /paperclip-approval-comment\.json/);
  assert.match(prompt, /Never hand-copy UUIDs|Prefer \$PAPERCLIP_\* env vars/);
  assert.doesNotMatch(prompt, /\{\{#hireModel\}\}|\{\{\/hireModel\}\}/);
  assert.match(prompt, /Do not use write_file for env-backed JSON payloads/);
  assert.match(prompt, /Paperclip API mutations are terminal-only/i);
  assert.match(prompt, /Never use execute_code or write_file to POST or PATCH Paperclip issues, approvals, or hire payloads/i);
  assert.match(prompt, /Do not use execute_code for Paperclip API calls\. In Hermes tool sandboxes it may see PAPERCLIP_\* values as missing or None/i);
  assert.match(prompt, /use an unquoted delimiter like <<JSON, not <<'JSON'/i);
  assert.match(prompt, /make sure no literal \$PAPERCLIP_\* strings remain/i);
  assert.match(prompt, /grep -n '.*\$PAPERCLIP_.*'/);
  assert.match(prompt, /X-Paperclip-Run-Id/);
  assert.match(prompt, /POST each comment before reusing or overwriting its payload file/i);
  assert.match(prompt, /Do not overwrite \/tmp\/paperclip-issue-comment\.json until the current comment has been sent successfully/i);
  assert.match(prompt, /If the task requires an intermediate required comment before the final summary/i);
  assert.match(prompt, /Shell env vars inside file paths do not expand in write_file, read_file, or patch/i);
  assert.match(prompt, /comment, file, payload, or token must be exact or verbatim/i);
  assert.match(prompt, /If the assigned issue says to wait for board approval, revision feedback, or a reviewer decision/i);
  assert.match(prompt, /issue-specific instructions win/i);
  assert.match(prompt, /do not replace the required Paperclip issue-comment and status-update workflow/i);
  assert.match(prompt, /If a skill tells you to "report", "wait", ask for feedback, say "Ready for feedback"/i);
  assert.match(prompt, /Do not claim that you posted a Paperclip issue comment or marked an issue done until the corresponding curl request succeeded/i);
  assert.match(prompt, /verify every required exact output/i);
  assert.match(prompt, /"sourceIssueId":"\$PAPERCLIP_TASK_ID"/);
  assert.match(prompt, /reuse that existing agent/i);
  assert.match(prompt, /Do not submit another \/agent-hires request/i);
  assert.match(prompt, /Do not use the clarify tool/i);
  assert.match(prompt, /companies\/\$PAPERCLIP_COMPANY_ID\/issues/);
  assert.match(prompt, /Use the field name "description" for issue instructions, not "body"/);
  assert.match(prompt, /Never POST to \/issues without \/companies\/\$PAPERCLIP_COMPANY_ID/);
});

test('buildPrompt highlights approved hire reuse details when approval payload already includes the created agent', () => {
  const prompt = buildPrompt(
    {
      ...ctx,
      context: {
        ...ctx.context,
        approvalStatus: 'approved',
        approvalType: 'hire_agent',
        approvalPayloadName: 'HermesManager',
        approvalPayloadRole: 'engineer',
        approvalPayloadAgentId: '11111111-1111-4111-8111-111111111111',
        approvalPayloadReportsTo: '22222222-2222-4222-8222-222222222222',
        approvalPayloadAdapterType: 'hermes_local',
        approvalPayloadDesiredSkills: ['company:verification-before-completion'],
      },
    },
    { paperclipApiUrl: 'http://localhost:3100' },
  );

  assert.match(prompt, /Approval payload summary:/);
  assert.match(prompt, /requested name: HermesManager/);
  assert.match(prompt, /requested role: engineer/);
  assert.match(prompt, /agentId: 11111111-1111-4111-8111-111111111111/);
  assert.match(prompt, /desiredSkills: company:verification-before-completion/);
  assert.match(prompt, /Approved hire reuse rule:/);
  assert.match(prompt, /This approved hire already exists in Paperclip\./);
  assert.match(prompt, /Do not submit another \/agent-hires request for this approval\./);
  assert.doesNotMatch(prompt, /\{\{#approvalType\}\}|\{\{#approvalPayloadSummary\}\}|\{\{#approvedHireDirective\}\}/);
});

test('buildPromptVars falls back to issue title and description fields', () => {
  const vars = buildPromptVars(
    {
      ...ctx,
      context: {
        taskId: 'ISS-44',
        issueTitle: 'Smoke test worker',
        issueDescription: 'Post AGENT_OK and close the issue.',
      },
    },
    {},
  );

  assert.equal(vars.taskId, 'ISS-44');
  assert.equal(vars.taskTitle, 'Smoke test worker');
  assert.equal(vars.taskBody, 'Post AGENT_OK and close the issue.');
});

test('buildPromptVars ignores placeholder ids so prompts do not teach bogus Paperclip env values', () => {
  const vars = buildPromptVars(
    {
      ...ctx,
      context: {
        taskId: 'None',
        issueId: 'undefined',
        wakeCommentId: 'null',
        approvalId: 'apr-2',
      },
    },
    {},
  );

  assert.equal(vars.taskId, '');
  assert.equal(vars.commentId, '');
  assert.equal(vars.approvalId, 'apr-2');
});

test('buildPrompt includes child issue follow-up guidance and skill immutability rules', () => {
  const prompt = buildPrompt(
    {
      ...ctx,
      context: {
        ...ctx.context,
        wakeReason: 'child_issue_completed',
        childIssueId: 'ISS-99',
        childIssueTitle: 'Worker native skill',
        childIssueStatus: 'done',
      },
    },
    { paperclipApiUrl: 'http://localhost:3100' },
  );

  assert.match(prompt, /Child issue update/);
  assert.match(prompt, /Do not create another subordinate agent or duplicate child issue/i);
  assert.match(prompt, /If the child issue is done and it satisfies the delegated work/i);
  assert.match(prompt, /issues\/ISS-99\/comments/);
  assert.match(prompt, /Do not edit installed skill files unless the task explicitly asks you to author or modify a skill/i);
  assert.match(prompt, /Task-specific exact-output requirements override generic skill examples or default phrasing/i);
  assert.match(prompt, /report", "wait", or "Ready for feedback" does not end a Paperclip child run by itself/i);
  assert.match(prompt, /you still must perform the assigned issue's required Paperclip API comment and status update steps/i);
  assert.match(prompt, /Never use execute_code to send the final Paperclip comment, status PATCH, approval mutation, or hire request/i);
});
