import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { HermesProfileAdapterConfig } from "./config.js";

function stringFromRecord(record: Record<string, unknown> | null | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function recordFromRecord(
  record: Record<string, unknown> | null | undefined,
  ...keys: string[]
): Record<string, unknown> | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

export function buildHermesProfileEnv(
  config: HermesProfileAdapterConfig,
  ctx: AdapterExecutionContext,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HERMES_PROFILE: config.profile,
    PAPERCLIP_ADAPTER_TYPE: "hermes_profile",
  };

  const runtimeParams = ctx.runtime.sessionParams ?? undefined;
  const contextParams = ctx.context as Record<string, unknown> | undefined;
  const taskContext =
    recordFromRecord(runtimeParams, "task", "issue") ??
    recordFromRecord(contextParams, "task", "issue") ??
    recordFromRecord(ctx.config, "task", "issue");
  const commentContext =
    recordFromRecord(runtimeParams, "comment", "wakeComment") ??
    recordFromRecord(contextParams, "comment", "wakeComment") ??
    recordFromRecord(ctx.config, "comment", "wakeComment");

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  if (ctx.agent.id) env.PAPERCLIP_AGENT_ID = ctx.agent.id;
  if (ctx.agent.companyId) env.PAPERCLIP_COMPANY_ID = ctx.agent.companyId;
  if (ctx.authToken && !env.PAPERCLIP_API_KEY) env.PAPERCLIP_API_KEY = ctx.authToken;

  const taskId =
    stringFromRecord(runtimeParams, "taskId", "task_id", "issueId", "issue_id") ??
    stringFromRecord(contextParams, "taskId", "task_id", "issueId", "issue_id") ??
    stringFromRecord(taskContext, "id", "taskId", "issueId") ??
    ctx.runtime.taskKey ??
    (typeof ctx.config.taskId === "string" ? ctx.config.taskId : undefined);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  const wakeReason =
    stringFromRecord(runtimeParams, "wakeReason", "wake_reason", "reason") ??
    stringFromRecord(contextParams, "wakeReason", "wake_reason", "reason");
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;

  const wakeCommentId =
    stringFromRecord(runtimeParams, "wakeCommentId", "wake_comment_id", "commentId", "comment_id") ??
    stringFromRecord(contextParams, "wakeCommentId", "wake_comment_id", "commentId", "comment_id") ??
    stringFromRecord(commentContext, "id", "wakeCommentId", "commentId");
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;

  const linkedIssueIds = runtimeParams?.linkedIssueIds ?? contextParams?.linkedIssueIds;
  if (Array.isArray(linkedIssueIds)) {
    const joined = linkedIssueIds
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0)
      .join(",");
    if (joined) env.PAPERCLIP_LINKED_ISSUE_IDS = joined;
  }

  if (config.paperclipApiUrl) env.PAPERCLIP_API_URL = config.paperclipApiUrl;

  if (config.env) {
    Object.assign(env, config.env);
  }

  return env;
}
