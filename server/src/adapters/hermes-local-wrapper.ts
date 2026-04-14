import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { execute as upstreamHermesExecute } from "hermes-paperclip-adapter/server";

const AUTHENTICATED_PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

IMPORTANT: Use \`terminal\` tool with authenticated \`curl\` for ALL Paperclip API calls:
\`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY"\`

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{paperclipApiUrl}}

<mandatory_tool_use>
When the task asks about anything that must be observed or computed from the current runtime, use tools instead of memory.
Always use tools for:
- arithmetic, hashes, encodings, and exact string transforms
- current time, date, timezone, uptime, environment variables, installed tools, OS, machine state, network status, open ports, processes, disk, memory, and permissions
- files, directories, git state, diffs, logs, tests, build status, and anything inside the active workspace
- Paperclip API state, issue status, comments, agents, companies, and any current remote fact

Memory and user profile describe the user and past context. They do not describe the machine, workspace, network, or remote systems you are currently running against.
</mandatory_tool_use>

<act_dont_ask>
Default to action when the obvious interpretation is the current machine, current workspace, current repository, or current assigned Paperclip issue.
If a user asks something like "is port 443 open", "what OS is this", "what time is it", "what changed", or "is the build passing", check directly with tools first.
Ask for clarification only when the target or scope is genuinely ambiguous and different interpretations would change the outcome in a meaningful way.
</act_dont_ask>

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. When done, mark the issue as completed:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" -X PATCH "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" -X POST "{{paperclipApiUrl}}/issues/{{taskId}}/comments" -H "Content-Type: application/json" -d '{"body":"DONE: <your summary here>"}'\`
4. If this issue has a parent, post a brief notification on the parent issue.
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Read the comment:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" | python3 -m json.tool\`

Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress, blocked, routine_execution 포함):
   \`curl -s -H "Authorization: Bearer $PAPER...KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}&includeRoutineExecutions=true" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"status\"]:>12} {i[\"priority\"]:>6} {i[\"title\"]}') for i in issues if i['status'] not in ('done','cancelled')]"\`
2. If issues found, pick one and work on it.
3. If no issues assigned to you, check unassigned backlog issues:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"title\"]}') for i in issues if not i.get('assigneeAgentId')]"\`
4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function withHermesRuntimeContext(
  ctx: AdapterExecutionContext,
): AdapterExecutionContext {
  const currentConfig = isRecord(ctx.config) ? ctx.config : {};
  const currentEnv = isRecord(currentConfig.env) ? currentConfig.env : {};
  const currentContext = isRecord(ctx.context) ? ctx.context : {};
  const paperclipWorkspace = isRecord(currentContext.paperclipWorkspace)
    ? currentContext.paperclipWorkspace
    : {};
  const workspaceDir =
    (typeof currentConfig.workspaceDir === "string" && currentConfig.workspaceDir.trim()) ||
    (typeof paperclipWorkspace.cwd === "string" && paperclipWorkspace.cwd.trim()) ||
    undefined;

  const nextEnv: Record<string, unknown> = { ...currentEnv };
  if (!nextEnv.PAPERCLIP_API_KEY && ctx.authToken) {
    nextEnv.PAPERCLIP_API_KEY = ctx.authToken;
  }

  const nextConfig = {
    ...currentConfig,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(!currentConfig.promptTemplate ? { promptTemplate: AUTHENTICATED_PROMPT_TEMPLATE } : {}),
    env: nextEnv,
  };

  return {
    ...ctx,
    agent: {
      ...ctx.agent,
      adapterConfig: {
        ...(isRecord(ctx.agent?.adapterConfig) ? ctx.agent.adapterConfig : {}),
        ...(!isRecord(ctx.agent?.adapterConfig) || !(ctx.agent?.adapterConfig as Record<string, unknown>).promptTemplate
          ? { promptTemplate: AUTHENTICATED_PROMPT_TEMPLATE }
          : {}),
        env: nextEnv,
      },
    } as typeof ctx.agent,
    config: nextConfig,
  };
}

export async function hermesExecuteWithPaperclipContext(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  return upstreamHermesExecute(withHermesRuntimeContext(ctx) as any);
}
