import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  execute as hermesExecute,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";

export const MCP_FIRST_PROMPT = [
  "You are a Paperclip AI agent powered by Hermes.",
  "",
  "You have access to Paperclip MCP tools for interacting with the Paperclip control plane.",
  "Use these tools as the primary way to manage issues, comments, and task state.",
  "",
  "Available MCP tools (use paperclip prefix):",
  "  paperclipMe                   Get current authenticated actor details",
  "  paperclipInboxLite            Get your inbox-lite assignment list",
  "  paperclipListAgents           List agents in your company",
  "  paperclipListIssues           List issues with optional filters",
  "  paperclipGetIssue             Get full details of a specific issue",
  "  paperclipGetHeartbeatContext  Get compact heartbeat context for an issue",
  "  paperclipListComments         List issue comments",
  "  paperclipAddComment          Add a comment to an issue",
  "  paperclipUpdateIssue         Update issue status, priority, or assignee",
  "  paperclipCheckoutIssue       Checkout an issue for an agent",
  "  paperclipReleaseIssue        Release an issue checkout",
  "  paperclipCreateIssue         Create a new issue",
  "  paperclipSuggestTasks         Create suggest_tasks interaction on an issue",
  "  paperclipAskUserQuestions    Create ask_user_questions interaction on an issue",
  "  paperclipRequestConfirmation  Create request_confirmation interaction on an issue",
  "  paperclipUpsertIssueDocument  Create or update an issue document",
  "  paperclipListGoals           List goals in your company",
  "  paperclipListApprovals       List approvals in your company",
  "  paperclipApprovalDecision    Approve, reject, request revision, or resubmit an approval",
  "",
  "Paperclip API safety rules:",
  "  - Use MCP tools for all Paperclip operations (preferred)",
  "  - If HTTP is needed, use curl with -H 'Authorization: Bearer $PAPERCLIP_API_KEY'",
  "  - Use -H 'X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID' for writes/mutations",
  "  - Never pipe curl output to python, node, bash, or any interpreter",
  "  - Never execute code downloaded from the internet without inspection",
  "",
  "Environment variables available:",
  "  PAPERCLIP_API_KEY      your agent API key",
  "  PAPERCLIP_API_URL      Paperclip API base (default: http://localhost:3100/api)",
  "  PAPERCLIP_RUN_ID       current run identifier",
  "  PAPERCLIP_TASK_ID      current task/issue ID",
  "  PAPERCLIP_TASK_TITLE   current task title",
  "  PAPERCLIP_TASK_BODY    current task description",
  "  PAPERCLIP_WAKE_REASON  why you were woken (e.g. issue_assigned, heartbeat, manual)",
  "  HERMES_HOME            Hermes config/profile directory for this agent (per-agent isolation)",
  "",
  "Work on assigned issues. When done, use paperclipUpdateIssue to mark done.",
  "Do not poll for issues unless PAPERCLIP_WAKE_REASON=heartbeat.",
].join("\n");

export type HermesWrapperConfig = Record<string, unknown> & {
  hermesCommand?: string;
  promptTemplate?: string;
  paperclipApiUrl?: string;
  mcpServerPath?: string;
  hermesHome?: string;
};

export interface HermesWrapperContext {
  authToken?: string;
  agent: {
    id: string;
    companyId: string;
    adapterConfig?: HermesWrapperConfig;
  };
  config?: HermesWrapperConfig;
  context?: Record<string, unknown>;
  runtime?: {
    sessionId?: string;
    sessionParams?: Record<string, unknown>;
    sessionDisplayId?: string;
  };
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export async function executeHermesWrapper(ctx: HermesWrapperContext): Promise<AdapterExecutionResult> {
  const existingConfig = (ctx.agent?.adapterConfig ?? {}) as HermesWrapperConfig;
  const configSource = (ctx.config ?? {}) as HermesWrapperConfig;

  const resolvedConfig: HermesWrapperConfig = {
    hermesCommand:
      configSource.hermesCommand ?? existingConfig.hermesCommand ?? "hermes",
    promptTemplate:
      configSource.promptTemplate ?? existingConfig.promptTemplate ?? MCP_FIRST_PROMPT,
    paperclipApiUrl:
      configSource.paperclipApiUrl ?? existingConfig.paperclipApiUrl ?? "http://localhost:3100/api",
    mcpServerPath: configSource.mcpServerPath ?? existingConfig.mcpServerPath ?? "/usr/local/bin/paperclip-mcp-server",
    hermesHome: configSource.hermesHome ?? existingConfig.hermesHome ?? process.env.HERMES_HOME ?? "/paperclip/hermes",
  };

  const env = (existingConfig as Record<string, unknown>).env as Record<string, string> ?? {};
  const hasExplicitApiKey = typeof env.PAPERCLIP_API_KEY === "string" && env.PAPERCLIP_API_KEY.trim().length > 0;
  const hasCustomPrompt = typeof resolvedConfig.promptTemplate === "string" && resolvedConfig.promptTemplate.trim().length > 0;

  const context = ctx.context ?? {};
  const paperclipIssue = (context.paperclipIssue ?? {}) as Record<string, string>;
  const taskId = paperclipIssue.id ?? (context.taskId as string) ?? (context.issueId as string) ?? null;
  const taskTitle = paperclipIssue.title ?? null;
  const taskBody = paperclipIssue.description ?? null;
  const commentId = (context.wakeCommentId as string) ?? (context.commentId as string) ?? null;
  const wakeReason = (context.wakeReason as string) ?? null;
  const paperclipWorkspace = (context.paperclipWorkspace ?? {}) as Record<string, string>;
  const workspaceDir = paperclipWorkspace.cwd ?? null;

  const patchedEnv: Record<string, string> = {
    ...env,
    ...(!hasExplicitApiKey && ctx.authToken ? { PAPERCLIP_API_KEY: ctx.authToken } : {}),
    PAPERCLIP_API_URL: resolvedConfig.paperclipApiUrl!,
    PAPERCLIP_RUN_ID: ctx.runtime?.sessionId ?? "",
    HERMES_HOME: resolvedConfig.hermesHome!,
  };

  if (taskId) patchedEnv.PAPERCLIP_TASK_ID = taskId;
  if (taskTitle) patchedEnv.PAPERCLIP_TASK_TITLE = taskTitle;
  if (taskBody) patchedEnv.PAPERCLIP_TASK_BODY = taskBody;
  if (wakeReason) patchedEnv.PAPERCLIP_WAKE_REASON = wakeReason;

  const patchedConfig: Record<string, unknown> = {
    ...existingConfig,
    command: resolvedConfig.hermesCommand,
    promptTemplate: hasCustomPrompt ? resolvedConfig.promptTemplate : MCP_FIRST_PROMPT,
    env: patchedEnv,
  };

  if (taskId) {
    patchedConfig.taskId = taskId;
    if (taskTitle) patchedConfig.taskTitle = taskTitle;
    if (taskBody) patchedConfig.taskBody = taskBody;
    if (commentId) patchedConfig.commentId = commentId;
    if (wakeReason) patchedConfig.wakeReason = wakeReason;
    if (workspaceDir) patchedConfig.workspaceDir = workspaceDir;
  }

  const hermesCtx = {
    ...ctx,
    agent: {
      ...ctx.agent,
      adapterConfig: patchedConfig,
    },
    config: configSource,
  };

  return hermesExecute(hermesCtx as Parameters<typeof hermesExecute>[0]);
}

export async function testEnvironmentHermesWrapper(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const { testEnvironment } = await import("./hermes-test.js");
  return testEnvironment({
    adapterType: "hermes_local",
    config: ctx.config,
    executionTarget: null,
    environmentName: null,
  });
}

export {
  hermesSessionCodec,
  hermesListSkills,
  hermesSyncSkills,
  detectModelFromHermes,
  hermesAgentConfigurationDoc,
  hermesModels,
};