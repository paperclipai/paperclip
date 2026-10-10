import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, issueWatchdogs } from "@paperclipai/db";

const MAX_WATCHDOG_SCOPE_ANCESTRY_DEPTH = 100;
export const TASK_WATCHDOG_ORIGIN_KIND = "task_watchdog";

type AgentRunActor = {
  type: string;
  agentId?: string | null;
  companyId?: string | null;
  runId?: string | null;
};

type IssueScopeTarget = {
  id: string;
  companyId: string;
  parentId?: string | null;
};

export type TaskWatchdogMutationScope =
  | { kind: "none" }
  | { kind: "invalid"; detail: string }
  | {
      kind: "watchdog";
      watchdogId: string;
      companyId: string;
      watchedIssueId: string;
      watchdogIssueId: string | null;
      stopFingerprint: string | null;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readTaskWatchdogContext(contextSnapshot: unknown) {
  const context = isPlainRecord(contextSnapshot) ? contextSnapshot : null;
  const taskWatchdog = isPlainRecord(context?.taskWatchdog) ? context.taskWatchdog : null;
  if (!taskWatchdog && context?.taskWatchdog !== true) return null;
  return {
    watchedIssueId: readString(taskWatchdog?.watchedIssueId) ?? readString(context?.watchedIssueId),
    stopFingerprint: readString(taskWatchdog?.stopFingerprint) ?? readString(context?.stopFingerprint),
  };
}

export async function resolveTaskWatchdogMutationScope(
  db: Db,
  actor: AgentRunActor,
): Promise<TaskWatchdogMutationScope> {
  if (actor.type !== "agent") return { kind: "none" };
  const agentId = readString(actor.agentId);
  const runId = readString(actor.runId);
  const actorCompanyId = readString(actor.companyId);
  if (!agentId || !runId) return { kind: "none" };

  const run = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);

  if (!run) return { kind: "none" };
  const taskWatchdog = readTaskWatchdogContext(run.contextSnapshot);
  if (!taskWatchdog) return { kind: "none" };
  if (run.agentId !== agentId || (actorCompanyId && run.companyId !== actorCompanyId)) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context does not belong to this agent.",
    };
  }

  if (!taskWatchdog.watchedIssueId) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context is missing a persisted watched issue id.",
    };
  }

  const watchdog = await db
    .select({
      id: issueWatchdogs.id,
      companyId: issueWatchdogs.companyId,
      issueId: issueWatchdogs.issueId,
      watchdogAgentId: issueWatchdogs.watchdogAgentId,
      watchdogIssueId: issueWatchdogs.watchdogIssueId,
      status: issueWatchdogs.status,
    })
    .from(issueWatchdogs)
    .where(and(
      eq(issueWatchdogs.companyId, run.companyId),
      eq(issueWatchdogs.issueId, taskWatchdog.watchedIssueId),
      eq(issueWatchdogs.watchdogAgentId, agentId),
      eq(issueWatchdogs.status, "active"),
    ))
    .then((rows) => rows[0] ?? null);

  if (!watchdog) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context is not backed by an active persisted watchdog.",
    };
  }

  return {
    kind: "watchdog",
    watchdogId: watchdog.id,
    companyId: watchdog.companyId,
    watchedIssueId: watchdog.issueId,
    watchdogIssueId: watchdog.watchdogIssueId ?? null,
    stopFingerprint: taskWatchdog.stopFingerprint,
  };
}

export async function issueIsInTaskWatchdogSubtree(
  db: Db,
  companyId: string,
  issueId: string,
  watchedIssueId: string,
) {
  let currentId: string | null = issueId;
  const seen = new Set<string>();

  for (let depth = 0; currentId && depth < MAX_WATCHDOG_SCOPE_ANCESTRY_DEPTH; depth += 1) {
    if (seen.has(currentId)) return false;
    seen.add(currentId);

    const parent: { id: string; companyId: string; parentId: string | null; originKind: string | null } | null = await db
      .select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId, originKind: issues.originKind })
      .from(issues)
      .where(and(eq(issues.id, currentId), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!parent) return false;
    if (parent.originKind === TASK_WATCHDOG_ORIGIN_KIND) return false;
    if (currentId === watchedIssueId) return true;
    currentId = parent.parentId ?? null;
  }

  return false;
}

export async function taskWatchdogScopeAllowsIssueMutation(
  db: Db,
  scope: TaskWatchdogMutationScope,
  issue: IssueScopeTarget,
  opts: { allowWatchdogIssue?: boolean } = {},
) {
  if (scope.kind !== "watchdog") return scope;
  if (issue.companyId !== scope.companyId) {
    return {
      kind: "invalid" as const,
      detail: "Task-watchdog mutation target is outside the watchdog company.",
    };
  }
  if (opts.allowWatchdogIssue !== false && scope.watchdogIssueId && issue.id === scope.watchdogIssueId) {
    return scope;
  }
  if (await issueIsInTaskWatchdogSubtree(db, scope.companyId, issue.id, scope.watchedIssueId)) {
    return scope;
  }
  return {
    kind: "invalid" as const,
    detail: "Task-watchdog runs can only mutate the watched issue subtree.",
  };
}
