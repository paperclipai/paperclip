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
      runId: string;
      agentId: string;
      watchdogId: string;
      companyId: string;
      watchedIssueId: string;
      watchdogIssueId: string;
      initialStopFingerprint: string;
      cursorFingerprint: string;
      cursorState: "open" | "sealed";
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
    version: taskWatchdog?.version === 1 ? 1 : null,
    watchdogId: readString(taskWatchdog?.watchdogId),
    watchdogIssueId: readString(taskWatchdog?.watchdogIssueId),
    watchedIssueId: readString(taskWatchdog?.watchedIssueId) ?? readString(context?.watchedIssueId),
    companyId: readString(taskWatchdog?.companyId),
    agentId: readString(taskWatchdog?.agentId),
    initialStopFingerprint: readString(taskWatchdog?.stopFingerprint) ?? readString(context?.stopFingerprint),
    recoveryCursor: isPlainRecord(taskWatchdog?.recoveryCursor)
      ? {
          version: taskWatchdog.recoveryCursor.version === 1 ? 1 : null,
          state: taskWatchdog.recoveryCursor.state === "open" || taskWatchdog.recoveryCursor.state === "sealed"
            ? taskWatchdog.recoveryCursor.state
            : null,
          fingerprint: readString(taskWatchdog.recoveryCursor.fingerprint),
        }
      : null,
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
      status: heartbeatRuns.status,
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

  if (run.status !== "running") {
    return {
      kind: "invalid",
      detail: "Task-watchdog source mutation requires its exact heartbeat run to still be running.",
    };
  }

  if (
    taskWatchdog.version !== 1 ||
    !taskWatchdog.watchdogId ||
    !taskWatchdog.watchdogIssueId ||
    !taskWatchdog.watchedIssueId ||
    !taskWatchdog.companyId ||
    !taskWatchdog.agentId ||
    !taskWatchdog.initialStopFingerprint ||
    taskWatchdog.recoveryCursor?.version !== 1 ||
    !taskWatchdog.recoveryCursor.state ||
    !taskWatchdog.recoveryCursor.fingerprint
  ) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context is missing its immutable identity or recovery cursor.",
    };
  }
  if (taskWatchdog.companyId !== run.companyId || taskWatchdog.agentId !== run.agentId) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run snapshot identity does not match the heartbeat run.",
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
      eq(issueWatchdogs.id, taskWatchdog.watchdogId),
      eq(issueWatchdogs.companyId, taskWatchdog.companyId),
    ))
    .then((rows) => rows[0] ?? null);

  if (
    !watchdog ||
    watchdog.issueId !== taskWatchdog.watchedIssueId ||
    watchdog.watchdogAgentId !== taskWatchdog.agentId ||
    watchdog.watchdogIssueId !== taskWatchdog.watchdogIssueId ||
    watchdog.status !== "active"
  ) {
    return {
      kind: "invalid",
      detail: "Task-watchdog run context is not backed by an active persisted watchdog.",
    };
  }

  return {
    kind: "watchdog",
    runId: run.id,
    agentId,
    watchdogId: taskWatchdog.watchdogId,
    companyId: taskWatchdog.companyId,
    watchedIssueId: taskWatchdog.watchedIssueId,
    watchdogIssueId: taskWatchdog.watchdogIssueId,
    initialStopFingerprint: taskWatchdog.initialStopFingerprint,
    cursorFingerprint: taskWatchdog.recoveryCursor.fingerprint,
    cursorState: taskWatchdog.recoveryCursor.state as "open" | "sealed",
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
