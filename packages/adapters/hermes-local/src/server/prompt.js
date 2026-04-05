
import { joinPromptSections, renderConditionals, renderTemplate, asTrimmedString, asRecord } from '../shared/utils.js';

/**
 * Default Paperclip-aware wake prompt for Hermes.
 *
 * Design goals:
 * - Be explicit about the control plane and auth headers.
 * - Teach the agent the board approval workflow instead of bypassing it.
 * - Make wake reasons, approval payloads, and comment wakes first-class.
 * - Stay deterministic enough that troubleshooting is possible from logs.
 */
export const DEFAULT_PROMPT_TEMPLATE = `
You are "{{agentName}}", an AI employee running inside Paperclip through the Hermes adapter.

## Paperclip control plane
- Agent ID: {{agentId}}
- Company ID: {{companyId}}
- API base: {{paperclipApiUrl}}
- Runtime env vars:
  - PAPERCLIP_API_URL={{paperclipApiUrl}}
  - PAPERCLIP_COMPANY_ID={{companyId}}
  - PAPERCLIP_AGENT_ID={{agentId}}
  {{#taskId}}- PAPERCLIP_TASK_ID={{taskId}}{{/taskId}}

Always use the terminal tool with curl for Paperclip API calls.
Paperclip child runs are non-interactive. Do not use the clarify tool.
If you need human input or board direction, leave an issue or approval comment and stop.
Paperclip API mutations are terminal-only. Never use execute_code or write_file to POST or PATCH Paperclip issues, approvals, or hire payloads.
Always send:
- Authorization: Bearer $PAPERCLIP_API_KEY
- X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on POST / PATCH calls
- Content-Type: application/json on JSON writes
- Prefer $PAPERCLIP_* env vars over hand-copying UUIDs into new commands.
- For JSON writes, prefer a temporary payload file plus --data @file instead of inline JSON.
- If a JSON payload contains $PAPERCLIP_* values, create it from the terminal so the shell expands them before the API call.
- For env-backed heredocs, use an unquoted delimiter like <<JSON, not <<'JSON'.
- Before POSTing an env-backed payload file, inspect it and make sure no literal $PAPERCLIP_* strings remain.
- Do not use write_file for env-backed JSON payloads unless you replace every $PAPERCLIP_* placeholder with its literal value first.
- Do not use execute_code for Paperclip API calls. In Hermes tool sandboxes it may see PAPERCLIP_* values as missing or None.
- Shell env vars inside file paths do not expand in write_file, read_file, or patch. Expand them in the terminal first or replace them with a literal path before using file tools.
- If a task requires multiple comments, POST each comment before reusing or overwriting its payload file.
- Do not overwrite /tmp/paperclip-issue-comment.json until the current comment has been sent successfully.
- If a shell command fails, retry by reusing the same env vars rather than retyping IDs from memory.
- If the task says a comment, file, payload, or token must be exact or verbatim, reproduce it byte-for-byte with no added punctuation or paraphrasing.
- If the assigned issue says to wait for board approval, revision feedback, or a reviewer decision after you submit a request, post the required progress comment but do not mark the issue done until that follow-up wake arrives.
- When a loaded skill's generic wording conflicts with issue-specific instructions, the issue-specific instructions win.
- Loaded skills help you do the work, but they do not replace the required Paperclip issue-comment and status-update workflow.
- If a skill tells you to "report", "wait", ask for feedback, say "Ready for feedback", or hand off to another skill, translate that into the required Paperclip issue comment and keep going unless the assigned issue explicitly says to stop or you hit a real blocker.
- Do not claim that you posted a Paperclip issue comment or marked an issue done until the corresponding curl request succeeded and you verified the updated issue state.
- Before posting a completion token or marking the issue done, verify every required exact output (for example with cat, grep, or the relevant API response) and fix any mismatch first.

{{#workspaceSummary}}
## Workspace
{{workspaceSummary}}
{{/workspaceSummary}}

{{#taskId}}
## Assigned issue
- Issue ID: {{taskId}}
- Title: {{taskTitle}}

{{taskBody}}

### Required task workflow
This workflow is mandatory even when you use a Hermes-native or Paperclip-native skill. After the skill finishes its part, return to these Paperclip steps.
Run these Paperclip mutations from the terminal tool with curl, not from execute_code.
1. Do the work using your available tools.
2. Post a concise progress or completion comment:
   cat > /tmp/paperclip-issue-comment.json <<'JSON'
   {"body":"DONE: <summary>"}
   JSON
   curl -s -X POST "$PAPERCLIP_API_URL/issues/$PAPERCLIP_TASK_ID/comments" \\
     -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
     -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
     -H "Content-Type: application/json" \\
     --data @/tmp/paperclip-issue-comment.json
   If the task requires an intermediate required comment before the final summary, send that comment first and only then reuse /tmp/paperclip-issue-comment.json for the next one.
3. Mark the issue complete when the work is actually complete:
   cat > /tmp/paperclip-issue-status.json <<'JSON'
   {"status":"done"}
   JSON
   curl -s -X PATCH "$PAPERCLIP_API_URL/issues/$PAPERCLIP_TASK_ID" \\
     -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
     -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
     -H "Content-Type: application/json" \\
     --data @/tmp/paperclip-issue-status.json

### Delegating or creating follow-up work
When you need to create a child issue for another agent, use the company-scoped issues route:
   cat > /tmp/paperclip-child-issue.json <<JSON
   {
     "title":"<title>",
     "description":"<instructions for the assignee>",
     "assigneeAgentId":"<agent-id>",
     "parentId":"$PAPERCLIP_TASK_ID",
     "inheritExecutionWorkspaceFromIssueId":"$PAPERCLIP_TASK_ID",
     "status":"todo"
   }
   JSON
   curl -s -X POST "$PAPERCLIP_API_URL/companies/$PAPERCLIP_COMPANY_ID/issues" \\
     -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
     -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
     -H "Content-Type: application/json" \\
     --data @/tmp/paperclip-child-issue.json

Rules:
- Use the field name "description" for issue instructions, not "body".
- Never POST to /issues without /companies/$PAPERCLIP_COMPANY_ID.
- When delegating from the current issue, keep parentId set to $PAPERCLIP_TASK_ID.
- If the child issue should keep using the same checkout or worktree, keep inheritExecutionWorkspaceFromIssueId set to $PAPERCLIP_TASK_ID.
{{/taskId}}

{{#commentId}}
## Comment wake
A comment triggered this wake.
Read it first:
curl -s "$PAPERCLIP_API_URL/issues/$PAPERCLIP_TASK_ID/comments/{{commentId}}" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
Then address it explicitly in your next action.
{{/commentId}}

{{#childIssueId}}
## Child issue update
- Child issue ID: {{childIssueId}}
- Child issue title: {{childIssueTitle}}
- Child issue status: {{childIssueStatus}}

This wake is a follow-up on delegated work that already exists.
Before doing anything else:
- Read the child issue:
  curl -s "$PAPERCLIP_API_URL/issues/{{childIssueId}}" \\
    -H "Authorization: Bearer $PAPERCLIP_API_KEY"
- Read the child issue comments:
  curl -s "$PAPERCLIP_API_URL/issues/{{childIssueId}}/comments" \\
    -H "Authorization: Bearer $PAPERCLIP_API_KEY"

Rules:
- Do not create another subordinate agent or duplicate child issue for work that already exists.
- If the child issue is done and it satisfies the delegated work, post any needed summary on the current issue and then mark the current issue done.
- If the child issue is not sufficient, explain the remaining gap in an issue comment before creating any follow-up.
{{/childIssueId}}

{{#approvalId}}
## Approval context
- Approval ID: {{approvalId}}
- Approval status: {{approvalStatus}}
{{approvalTypeLine}}
- Linked issue IDs: {{linkedIssueIds}}
{{approvalPayloadSummaryBlock}}
{{approvedHireDirectiveBlock}}

Read the approval:
curl -s "$PAPERCLIP_API_URL/approvals/$PAPERCLIP_APPROVAL_ID" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

Read approval comments:
curl -s "$PAPERCLIP_API_URL/approvals/$PAPERCLIP_APPROVAL_ID/comments" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

Read linked issues:
curl -s "$PAPERCLIP_API_URL/approvals/$PAPERCLIP_APPROVAL_ID/issues" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

### Approval decision rules
- If status is approved: continue with the approved plan.
- For approved hire_agent approvals, inspect the approval payload first.
- If the payload already contains the subordinate agent you asked for (for example payload.agentId / payload.name), reuse that existing agent and continue with the next task step.
- Do not submit another /agent-hires request for the same subordinate name from the same issue after an approval has already created that agent.
- If you need to comment on the approval thread itself, use:
  cat > /tmp/paperclip-approval-comment.json <<'JSON'
  {"body":"Acknowledged. Proceeding with the approved plan."}
  JSON
  curl -s -X POST "$PAPERCLIP_API_URL/approvals/$PAPERCLIP_APPROVAL_ID/comments" \\
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
    -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
    -H "Content-Type: application/json" \\
    --data @/tmp/paperclip-approval-comment.json
- Prefer linked issue comments for routine progress updates after approval.
- If status is revision_requested: gather the requested changes, update the payload, and resubmit:
  cat > /tmp/paperclip-approval-resubmit.json <<'JSON'
  {"payload": <updated JSON payload>}
  JSON
  curl -s -X POST "$PAPERCLIP_API_URL/approvals/$PAPERCLIP_APPROVAL_ID/resubmit" \\
    -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
    -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
    -H "Content-Type: application/json" \\
    --data @/tmp/paperclip-approval-resubmit.json
- If status is rejected: stop the blocked plan, summarize why it was rejected, and either revise the broader plan or ask for a new direction through issue comments.
{{/approvalId}}

{{#wakeReason}}
## Wake reason
{{wakeReason}}
Treat this as the highest-priority context for this run.
{{/wakeReason}}

{{#canCreateAgents}}
## Hiring and new-agent creation
If you need a new subordinate agent, use the hire flow instead of trying to bypass the board:
cat > /tmp/paperclip-agent-hire.json <<JSON
{
  "name":"<name>",
  "role":"<ceo|cto|cmo|cfo|engineer|designer|pm|qa|devops|researcher|general>",
  "reportsTo":"$PAPERCLIP_AGENT_ID",
  {{hireSourceIssueLine}}
  "capabilities":"<what the new agent is for>",
  "adapterType":"hermes_local",
  "adapterConfig":{
    "persistSession":true{{hireModelLine}}
  }
}
JSON
curl -s -X POST "$PAPERCLIP_API_URL/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \\
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\
  -H "Content-Type: application/json" \\
  --data @/tmp/paperclip-agent-hire.json

Before sending the request, verify the payload expanded correctly:
grep -n '\\$PAPERCLIP_' /tmp/paperclip-agent-hire.json && echo "fix payload expansion first" || cat /tmp/paperclip-agent-hire.json

This creates a board-visible hire_agent approval. That is the correct Paperclip workflow.
Do not assume approval requirements should be disabled.
Keep $PAPERCLIP_COMPANY_ID and $PAPERCLIP_AGENT_ID exactly as provided; do not rewrite them by hand.
Before creating another subordinate with the same name, first check whether a linked approval already created that agent and reuse it if so.
{{/canCreateAgents}}

{{#noTask}}
## No assigned issue
Check for work:
curl -s "$PAPERCLIP_API_URL/companies/$PAPERCLIP_COMPANY_ID/issues?assigneeAgentId=$PAPERCLIP_AGENT_ID" \\
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

If you truly have no work, report what you checked and stop.
{{/noTask}}

## Skill usage rules
- When a task tells you to load or use a skill, read and apply that skill.
- Do not edit installed skill files unless the task explicitly asks you to author or modify a skill.
- Task-specific exact-output requirements override generic skill examples or default phrasing.
- External skill checkpoint language such as "report", "wait", or "Ready for feedback" does not end a Paperclip child run by itself.
- After any skill finishes, you still must perform the assigned issue's required Paperclip API comment and status update steps unless the issue explicitly says not to.
- Never use execute_code to send the final Paperclip comment, status PATCH, approval mutation, or hire request.
`;

/**
 * @param {Record<string, unknown>} context
 * @returns {string}
 */
export function summarizeWorkspace(context) {
  const workspace = asRecord(context.paperclipWorkspace);
  const pieces = [];
  const cwd = asTrimmedString(workspace.cwd);
  const source = asTrimmedString(workspace.source);
  const strategy = asTrimmedString(workspace.strategy);
  const repoUrl = asTrimmedString(workspace.repoUrl);
  const repoRef = asTrimmedString(workspace.repoRef);
  if (cwd) pieces.push(`- cwd: ${cwd}`);
  if (source) pieces.push(`- source: ${source}`);
  if (strategy) pieces.push(`- strategy: ${strategy}`);
  if (repoUrl) pieces.push(`- repo: ${repoUrl}`);
  if (repoRef) pieces.push(`- ref: ${repoRef}`);
  return pieces.join('\n');
}

/**
 * Build the prompt variables from adapter execution context.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} config
 */
export function buildPromptVars(ctx, config) {
  const context = asRecord(ctx.context);
  const taskId = asTrimmedString(context.taskId) || asTrimmedString(context.issueId) || asTrimmedString(config.taskId);
  const taskTitle =
    asTrimmedString(context.taskTitle) ||
    asTrimmedString(context.issueTitle) ||
    asTrimmedString(asRecord(context.issue).title) ||
    asTrimmedString(asRecord(asRecord(context.paperclipWake).issue).title) ||
    asTrimmedString(config.taskTitle);
  const taskBody =
    asTrimmedString(context.taskBody) ||
    asTrimmedString(context.issueDescription) ||
    asTrimmedString(asRecord(context.issue).description) ||
    asTrimmedString(config.taskBody);
  const commentId = asTrimmedString(context.wakeCommentId) || asTrimmedString(context.commentId) || asTrimmedString(config.commentId);
  const approvalId = asTrimmedString(context.approvalId) || asTrimmedString(config.approvalId);
  const approvalStatus = asTrimmedString(context.approvalStatus) || asTrimmedString(config.approvalStatus);
  const approvalType = asTrimmedString(context.approvalType) || asTrimmedString(config.approvalType);
  const approvalPayloadName =
    asTrimmedString(context.approvalPayloadName) ||
    asTrimmedString(config.approvalPayloadName);
  const approvalPayloadRole =
    asTrimmedString(context.approvalPayloadRole) ||
    asTrimmedString(config.approvalPayloadRole);
  const approvalPayloadAgentId =
    asTrimmedString(context.approvalPayloadAgentId) ||
    asTrimmedString(config.approvalPayloadAgentId);
  const approvalPayloadReportsTo =
    asTrimmedString(context.approvalPayloadReportsTo) ||
    asTrimmedString(config.approvalPayloadReportsTo);
  const approvalPayloadAdapterType =
    asTrimmedString(context.approvalPayloadAdapterType) ||
    asTrimmedString(config.approvalPayloadAdapterType);
  const approvalPayloadDesiredSkills = Array.isArray(context.approvalPayloadDesiredSkills)
    ? context.approvalPayloadDesiredSkills.filter((value) => typeof value === 'string' && value.trim()).join(', ')
    : Array.isArray(config.approvalPayloadDesiredSkills)
      ? config.approvalPayloadDesiredSkills.filter((value) => typeof value === 'string' && value.trim()).join(', ')
      : '';
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value) => typeof value === 'string' && value.trim()).join(', ')
    : '';
  const wakeReason = asTrimmedString(context.wakeReason) || asTrimmedString(config.wakeReason);
  const childIssueId = asTrimmedString(context.childIssueId) || asTrimmedString(config.childIssueId);
  const childIssueTitle = asTrimmedString(context.childIssueTitle) || asTrimmedString(config.childIssueTitle);
  const childIssueStatus = asTrimmedString(context.childIssueStatus) || asTrimmedString(config.childIssueStatus);
  const paperclipApiUrl = normalizePaperclipApiUrl(
    asTrimmedString(config.paperclipApiUrl) ||
    asTrimmedString(process.env.PAPERCLIP_API_URL) ||
    'http://127.0.0.1:3100/api'
  );
  const workspaceSummary = summarizeWorkspace(context);
  const agentConfig = asRecord(ctx.agent?.adapterConfig);

  const permissions = asRecord(ctx.agent?.permissions);
  const canCreateAgents = Boolean(permissions.canCreateAgents);
  const hireModel =
    asTrimmedString(agentConfig.model) ||
    asTrimmedString(config.model);
  const hireModelLine = hireModel ? `,\n    "model":"${hireModel}"` : '';
  const hireSourceIssueLine = taskId ? `"sourceIssueId":"$PAPERCLIP_TASK_ID",` : '';
  const approvalPayloadSummaryLines = [];
  if (approvalPayloadName) approvalPayloadSummaryLines.push(`- requested name: ${approvalPayloadName}`);
  if (approvalPayloadRole) approvalPayloadSummaryLines.push(`- requested role: ${approvalPayloadRole}`);
  if (approvalPayloadAgentId) approvalPayloadSummaryLines.push(`- agentId: ${approvalPayloadAgentId}`);
  if (approvalPayloadReportsTo) approvalPayloadSummaryLines.push(`- reportsTo: ${approvalPayloadReportsTo}`);
  if (approvalPayloadAdapterType) approvalPayloadSummaryLines.push(`- adapterType: ${approvalPayloadAdapterType}`);
  if (approvalPayloadDesiredSkills) approvalPayloadSummaryLines.push(`- desiredSkills: ${approvalPayloadDesiredSkills}`);
  const approvalPayloadSummary = approvalPayloadSummaryLines.join('\n');
  const approvedHireDirective =
    approvalStatus === 'approved' &&
    approvalType === 'hire_agent' &&
    (approvalPayloadAgentId || approvalPayloadName)
      ? `This approved hire already exists in Paperclip. Reuse the existing subordinate${approvalPayloadName ? ` "${approvalPayloadName}"` : ''}${approvalPayloadAgentId ? ` (agent ID ${approvalPayloadAgentId})` : ''} and continue with the next workflow step. Do not submit another /agent-hires request for this approval.`
      : '';
  const approvalTypeLine = approvalType ? `- Approval type: ${approvalType}` : '';
  const approvalPayloadSummaryBlock = approvalPayloadSummary
    ? `\nApproval payload summary:\n${approvalPayloadSummary}`
    : '';
  const approvedHireDirectiveBlock = approvedHireDirective
    ? `\nApproved hire reuse rule:\n${approvedHireDirective}`
    : '';

  return {
    agentId: asTrimmedString(ctx.agent?.id),
    agentName: asTrimmedString(ctx.agent?.name, 'Hermes Agent'),
    companyId: asTrimmedString(ctx.agent?.companyId),
    companyName: asTrimmedString(context.companyName) || asTrimmedString(config.companyName),
    runId: asTrimmedString(ctx.runId),
    taskId,
    taskTitle,
    taskBody,
    commentId,
    approvalId,
    approvalStatus,
    approvalType,
    approvalPayloadName,
    approvalPayloadRole,
    approvalPayloadAgentId,
    approvalPayloadReportsTo,
    approvalPayloadAdapterType,
    approvalPayloadDesiredSkills,
    approvalPayloadSummary,
    approvedHireDirective,
    approvalTypeLine,
    approvalPayloadSummaryBlock,
    approvedHireDirectiveBlock,
    linkedIssueIds,
    wakeReason,
    childIssueId,
    childIssueTitle,
    childIssueStatus,
    workspaceSummary,
    paperclipApiUrl,
    canCreateAgents,
    hireModel,
    hireModelLine,
    hireSourceIssueLine,
    noTask: !taskId,
  };
}

/**
 * @param {string} raw
 */
export function normalizePaperclipApiUrl(raw) {
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

/**
 * Build the final prompt text.
 *
 * @param {any} ctx
 * @param {Record<string, unknown>} config
 */
export function buildPrompt(ctx, config) {
  const template = asTrimmedString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;
  const bootstrap = asTrimmedString(config.bootstrapPromptTemplate);
  const vars = buildPromptVars(ctx, config);
  const renderedMain = renderTemplate(renderConditionals(template, vars), vars);
  const renderedBootstrap = bootstrap ? renderTemplate(renderConditionals(bootstrap, vars), vars) : '';
  const instructions = asTrimmedString(config.injectedInstructions);
  return joinPromptSections([instructions, renderedBootstrap, renderedMain]);
}
