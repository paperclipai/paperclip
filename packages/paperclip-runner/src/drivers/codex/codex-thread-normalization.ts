import type {
  HarnessThreadGoal,
  HarnessThreadLineageEntry,
} from "../../contracts/harness-driver.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function parseCodexThreadGoal(value: unknown): HarnessThreadGoal | null {
  const goal = record(value);
  const threadId = text(goal.threadId);
  const objective = text(goal.objective);
  const status = text(goal.status);
  if (
    threadId.length === 0 ||
    objective.length === 0 ||
    ![
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ].includes(status)
  ) {
    return null;
  }
  const tokenBudget = goal.tokenBudget === null || goal.tokenBudget === undefined
    ? null
    : nonNegativeInteger(goal.tokenBudget);
  const tokensUsed = goal.tokensUsed === undefined
    ? 0
    : nonNegativeInteger(goal.tokensUsed);
  const timeUsedSeconds = goal.timeUsedSeconds === undefined
    ? 0
    : nonNegativeInteger(goal.timeUsedSeconds);
  const createdAt = goal.createdAt === undefined
    ? 0
    : nonNegativeInteger(goal.createdAt);
  const updatedAt = goal.updatedAt === undefined
    ? 0
    : nonNegativeInteger(goal.updatedAt);
  if (
    (goal.tokenBudget !== null && goal.tokenBudget !== undefined && tokenBudget === null) ||
    tokensUsed === null ||
    timeUsedSeconds === null ||
    createdAt === null ||
    updatedAt === null
  ) return null;
  return {
    threadId,
    objective,
    status: status as HarnessThreadGoal["status"],
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
}

export function codexThreadStatus(value: unknown): string {
  if (typeof value === "string") return value;
  return text(record(value).type, "unknown");
}

export function codexThreadLineage(value: unknown): HarnessThreadLineageEntry {
  const thread = record(value);
  const source = record(thread.source);
  const subAgent = source.subAgent ?? source.subagent;
  const subAgentRecord = record(subAgent);
  const spawn = record(
    subAgentRecord.thread_spawn ?? subAgentRecord.threadSpawn,
  );
  const parentThreadId =
    text(
      spawn.parent_thread_id ?? spawn.parentThreadId,
      text(thread.forkedFromId),
    ) || null;
  return {
    threadId: text(thread.id),
    providerSessionId: text(thread.sessionId) || null,
    parentThreadId,
    depth: nonNegativeInteger(spawn.depth) ?? (parentThreadId === null ? 0 : 1),
    nickname:
      text(
        thread.agentNickname,
        text(spawn.agent_nickname ?? spawn.agentNickname),
      ) || null,
    role:
      text(thread.agentRole, text(spawn.agent_role ?? spawn.agentRole)) || null,
    status: codexThreadStatus(thread.status),
  };
}

export interface CodexNotificationBinding {
  runId: string;
  threadIds: readonly string[];
}

export interface BindableCodexNotification {
  method: string;
  params: Record<string, unknown>;
}

export function isSupportedCodexNotificationMethod(method: string): boolean {
  return (
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/closed" ||
    method === "thread/goal/updated" ||
    method === "thread/goal/cleared" ||
    method === "serverRequest/resolved" ||
    method === "thread/tokenUsage/updated" ||
    method === "error" ||
    method === "warning" ||
    method === "configWarning" ||
    method === "guardianWarning" ||
    method === "deprecationNotice" ||
    method === "windows/worldWritableWarning" ||
    method === "hook/started" ||
    method === "hook/completed" ||
    method === "thread/compacted" ||
    method === "model/rerouted" ||
    method === "model/verification" ||
    method === "model/safetyBuffering/updated" ||
    method.startsWith("item/") ||
    method === "paperclip/workspaceChange/updated" ||
    method === "paperclip/runResult" ||
    method === "turn/diff/updated" ||
    method === "turn/plan/updated"
  );
}

/**
 * Admits only known notifications that explicitly name the active run or one
 * of its known threads. A newly spawned child may bind through its parent.
 */
export function isBoundCodexNotification(
  notification: BindableCodexNotification,
  binding: CodexNotificationBinding,
): boolean {
  if (!isSupportedCodexNotificationMethod(notification.method)) return false;
  const params = record(notification.params);
  const claimedRunId = text(params.runId, text(params.paperclipRunId));
  if (claimedRunId.length > 0 && claimedRunId !== binding.runId) return false;

  const allowedThreads = new Set(binding.threadIds);
  const directThreadId = text(params.threadId, text(record(params.turn).threadId));
  if (directThreadId.length > 0) return allowedThreads.has(directThreadId);

  const thread = record(params.thread);
  const threadId = text(thread.id);
  if (threadId.length > 0 && allowedThreads.has(threadId)) return true;
  const source = record(thread.source);
  const subAgent = record(source.subAgent ?? source.subagent);
  const spawn = record(subAgent.thread_spawn ?? subAgent.threadSpawn);
  const parentThreadId = text(spawn.parent_thread_id ?? spawn.parentThreadId);
  if (notification.method === "thread/started" && parentThreadId.length > 0) {
    return allowedThreads.has(parentThreadId);
  }
  if (threadId.length > 0) return false;

  return false;
}

export function codexWorkspaceRelativePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replaceAll("\\", "/");
  if (
    path.length === 0 ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.startsWith("//") ||
    /^[A-Za-z]:/u.test(path) ||
    path.split("/").some((part) => part === ".." || part.length === 0)
  ) return null;
  return path;
}

export function boundedCodexWorkspaceStat(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function safeCodexRequestResponse(
  method: string,
  action: "decline" | "cancel" = "decline",
): Record<string, unknown> {
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action, content: null, _meta: null };
  }
  if (
    method === "item/tool/requestUserInput" ||
    method === "tool/requestUserInput"
  ) {
    return { answers: {} };
  }
  if (
    method.includes("requestApproval") ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  ) {
    return { decision: action };
  }
  return {};
}
