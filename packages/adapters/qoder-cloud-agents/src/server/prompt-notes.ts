import type { AdapterExecutionContext, AdapterRuntimeToolAccess } from "@paperclipai/adapter-utils";
import { readPaperclipIssueWorkModeFromContext } from "@paperclipai/adapter-utils/server-utils";
import { asRecord, trimNullable, type QoderRepo } from "./shared.js";

export function buildRunContextNote(ctx: AdapterExecutionContext, sessionEnv: Record<string, string>, repo: QoderRepo | null): string {
  const { runId, context } = ctx;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const runValues: Array<[string, string | null]> = [
    ["PAPERCLIP_RUN_ID", runId],
    ["PAPERCLIP_TASK_ID", trimNullable(context.taskId) ?? trimNullable(context.issueId)],
    ["PAPERCLIP_WAKE_REASON", trimNullable(context.wakeReason)],
    ["PAPERCLIP_WAKE_COMMENT_ID", trimNullable(context.wakeCommentId) ?? trimNullable(context.commentId)],
    ["PAPERCLIP_APPROVAL_ID", trimNullable(context.approvalId)],
    ["PAPERCLIP_APPROVAL_STATUS", trimNullable(context.approvalStatus)],
    ["PAPERCLIP_LINKED_ISSUE_IDS", linkedIssueIds.length > 0 ? linkedIssueIds.join(",") : null],
    ["PAPERCLIP_ISSUE_WORK_MODE", readPaperclipIssueWorkModeFromContext(context)],
  ];
  const lines = [
    "Paperclip runtime note:",
    "Values for this run (not set in the shell, because Qoder fixes session env vars at session creation):",
    ...runValues.filter(([, value]) => value).map(([key, value]) => `- ${key}=${value}`),
  ];
  const envKeys = Object.keys(sessionEnv).filter((key) => key.startsWith("PAPERCLIP_")).sort();
  if (envKeys.length > 0) {
    lines.push(`These PAPERCLIP_* environment variables are set in the session shell: ${envKeys.join(", ")}`);
  }
  if (repo) {
    lines.push(
      `Repository ${repo.url} is cloned at ${repo.mountPath}. Run git commands there.`,
      "Container storage is temporary: commit and push any work that must survive this session.",
    );
  }
  return lines.join("\n");
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127\./.test(host);
  } catch {
    return true;
  }
}

export function readRuntimeTools(ctx: AdapterExecutionContext): AdapterRuntimeToolAccess | null {
  const tools = asRecord(ctx.runtimeTools ?? ctx.context.paperclipRuntimeTools);
  const rest = asRecord(tools?.rest);
  if (!tools || !rest) return null;
  if (!trimNullable(tools.bearerToken) || !trimNullable(rest.connectionsSearch) || !trimNullable(rest.connectionRequest)) {
    return null;
  }
  return tools as unknown as AdapterRuntimeToolAccess;
}

/**
 * Run-scoped connection tools cannot live in the session env, which Qoder
 * fixes at creation, so each turn carries them in its prompt.
 */
export function buildRuntimeToolsNote(tools: AdapterRuntimeToolAccess): string {
  return [
    "Paperclip connection tools for this run:",
    `- connections_search: POST ${tools.rest.connectionsSearch}`,
    `- connection_request: POST ${tools.rest.connectionRequest}`,
    ...(trimNullable(tools.mcpEndpoint) ? [`- MCP endpoint: ${tools.mcpEndpoint}`] : []),
    `Send the header "Authorization: Bearer ${tools.bearerToken}" with each request.`,
    `The token is valid for this run only${trimNullable(tools.expiresAt) ? ` and expires at ${tools.expiresAt}` : ""}. Do not write it to files or output.`,
  ].join("\n");
}
