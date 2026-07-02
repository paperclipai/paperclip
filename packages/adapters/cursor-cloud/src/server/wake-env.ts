import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  buildPaperclipEnv,
  clampEnvVarsForCloud,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
} from "@paperclipai/adapter-utils/server-utils";

function trimNullable(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function buildCursorCloudWakeEnv(
  ctx: AdapterExecutionContext,
  configEnv: Record<string, string>,
): Record<string, string> {
  const { runId, agent, context, authToken } = ctx;
  const env: Record<string, string> = {
    ...configEnv,
    ...buildPaperclipEnv(agent),
    PAPERCLIP_RUN_ID: runId,
  };

  const wakeTaskId = trimNullable(context.taskId) ?? trimNullable(context.issueId);
  const wakeReason = trimNullable(context.wakeReason);
  const wakeCommentId = trimNullable(context.wakeCommentId) ?? trimNullable(context.commentId);
  const approvalId = trimNullable(context.approvalId);
  const approvalStatus = trimNullable(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);

  if (wakeTaskId) env.PAPERCLIP_TASK_ID = wakeTaskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;
  if (!trimNullable(env.PAPERCLIP_API_KEY) && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceMappings: Array<[string, unknown]> = [
    ["PAPERCLIP_WORKSPACE_CWD", workspace.cwd],
    ["PAPERCLIP_WORKSPACE_SOURCE", workspace.source],
    ["PAPERCLIP_WORKSPACE_ID", workspace.workspaceId],
    ["PAPERCLIP_WORKSPACE_REPO_URL", workspace.repoUrl],
    ["PAPERCLIP_WORKSPACE_REPO_REF", workspace.repoRef],
    ["PAPERCLIP_WORKSPACE_BRANCH", workspace.branch],
    ["PAPERCLIP_WORKSPACE_WORKTREE_PATH", workspace.worktreePath],
    ["AGENT_HOME", workspace.agentHome],
  ];
  for (const [key, value] of workspaceMappings) {
    const normalized = trimNullable(value);
    if (normalized) env[key] = normalized;
  }

  delete env.CURSOR_API_KEY;
  return clampEnvVarsForCloud(env);
}
