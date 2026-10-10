import { and, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { ISSUE_TERMINAL_WORKSPACE_CLEANUP_REASON } from "./execution-workspaces.js";
import { stopRuntimeServicesForExecutionWorkspace } from "./workspace-runtime.js";

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const OPEN_WORKSPACE_STATUSES = ["active", "idle", "in_review"] as const;

export const SUPERSEDED_SHARED_SESSION_CLEANUP_REASON = "superseded_session";

/**
 * Two runs on the same issue can overlap. Each run creates its own shared session and then
 * archives the other sessions of the issue. Without a guard, the runs archive each other's
 * sessions and stop the runtime services of a live run. A session that a run used recently
 * can still be live, so this pass does not archive it. A later pass archives it when it is
 * no longer used.
 */
const SUPERSEDED_SHARED_SESSION_GRACE_MS = 15 * 60_000;

type CleanupActor = Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId">;

type SharedSessionArchiveSource = "superseded_session" | "terminal_issue";

export type TerminalWorkspaceCleanupResult = {
  outcome: "not_applicable" | "deferred" | "archived";
  archivedWorkspaceIds: string[];
};

/**
 * Archives one shared session record. A shared session points at the project workspace
 * directory, so this function changes no file on disk and never sets `cleanup_failed`.
 * Isolated worktrees are not handled here: the terminal workspace reaper
 * (`executionWorkspaceService.sweepTerminalWorkspaces`) archives and cleans them after
 * the work is merged.
 */
async function archiveSharedSession(
  db: Db,
  input: {
    companyId: string;
    workspaceId: string;
    actor: CleanupActor;
    source: SharedSessionArchiveSource;
  },
): Promise<boolean> {
  const closedAt = new Date();
  const cleanupReason = input.source === "terminal_issue"
    ? ISSUE_TERMINAL_WORKSPACE_CLEANUP_REASON
    : SUPERSEDED_SHARED_SESSION_CLEANUP_REASON;
  const archived = await db
    .update(executionWorkspaces)
    .set({
      status: "archived",
      closedAt,
      cleanupEligibleAt: null,
      cleanupReason,
      updatedAt: closedAt,
    })
    .where(
      and(
        eq(executionWorkspaces.id, input.workspaceId),
        eq(executionWorkspaces.companyId, input.companyId),
        eq(executionWorkspaces.mode, "shared_workspace"),
        inArray(executionWorkspaces.status, [...OPEN_WORKSPACE_STATUSES]),
      ),
    )
    .returning({ id: executionWorkspaces.id })
    .then((rows) => rows[0] ?? null);
  if (!archived) return false;

  // A terminal issue keeps its link: it records where the work ran. Only a
  // superseded session is unlinked, because a newer session replaced it.
  if (input.source !== "terminal_issue") {
    await db
      .update(issues)
      .set({ executionWorkspaceId: null, updatedAt: closedAt })
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.executionWorkspaceId, input.workspaceId),
        ),
      );
  }

  const warnings: string[] = [];
  try {
    // Stop only the services that this session owns. Do not pass the session cwd: it is
    // the project workspace directory, and services of other sessions also run there.
    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId: input.workspaceId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(message);
    await db
      .update(executionWorkspaces)
      .set({ cleanupReason: `${cleanupReason} | ${message}`, updatedAt: new Date() })
      .where(eq(executionWorkspaces.id, input.workspaceId));
  }

  await logActivity(db, {
    companyId: input.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId ?? null,
    runId: input.actor.runId ?? null,
    action: "execution_workspace.shared_session_archived",
    entityType: "execution_workspace",
    entityId: input.workspaceId,
    details: { source: input.source, warnings },
  });
  return true;
}

async function listLiveRunWorkspaceIds(db: Db, companyId: string, issueId: string) {
  const rows = await db
    .select({
      id: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'executionWorkspaceId'`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        or(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issueId}`,
        ),
      ),
    );
  return new Set(rows.map((row) => row.id).filter((id): id is string => Boolean(id)));
}

/**
 * Each run on an issue creates its own shared_workspace session, but only the session that
 * issues.execution_workspace_id points at was archived. Sessions of earlier runs stayed open:
 * one instance had 870 open sessions for 252 issues, and up to 45 sessions for one issue.
 */
async function archiveSharedSessionsOfIssue(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    keepWorkspaceId: string | null;
    actor: CleanupActor;
    source: SharedSessionArchiveSource;
    /** Archive sessions of any age. Use this only when the issue is terminal. */
    ignoreGrace?: boolean;
    /** Also archive this session when it is shared, even if another issue created it. */
    linkedWorkspaceId?: string | null;
    now?: Date;
  },
): Promise<string[]> {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - SUPERSEDED_SHARED_SESSION_GRACE_MS);
  const protectedWorkspaceIds = await listLiveRunWorkspaceIds(db, input.companyId, input.issueId);
  const candidates = await db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, input.companyId),
        eq(executionWorkspaces.mode, "shared_workspace"),
        inArray(executionWorkspaces.status, [...OPEN_WORKSPACE_STATUSES]),
        input.linkedWorkspaceId
          ? or(
              eq(executionWorkspaces.sourceIssueId, input.issueId),
              eq(executionWorkspaces.id, input.linkedWorkspaceId),
            )
          : eq(executionWorkspaces.sourceIssueId, input.issueId),
        ...(input.ignoreGrace ? [] : [lt(executionWorkspaces.lastUsedAt, staleBefore)]),
      ),
    );
  const candidateIds = candidates
    .map((row) => row.id)
    .filter((id) => id !== input.keepWorkspaceId && !protectedWorkspaceIds.has(id));
  if (candidateIds.length === 0) return [];

  // Keep a session that an open issue other than this one still uses.
  const usedByOtherOpenIssue = new Set(
    await db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          inArray(issues.executionWorkspaceId, candidateIds),
          notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
          sql`${issues.id} <> ${input.issueId}`,
        ),
      )
      .then((rows) => rows.map((row) => row.executionWorkspaceId)),
  );

  const archivedIds: string[] = [];
  for (const workspaceId of candidateIds) {
    if (usedByOtherOpenIssue.has(workspaceId)) continue;
    try {
      const archived = await archiveSharedSession(db, {
        companyId: input.companyId,
        workspaceId,
        actor: input.actor,
        source: input.source,
      });
      if (archived) archivedIds.push(workspaceId);
    } catch (error) {
      logger.warn(
        { err: error, executionWorkspaceId: workspaceId, sourceIssueId: input.issueId },
        "failed to archive shared execution workspace session",
      );
    }
  }
  return archivedIds;
}

export function executionWorkspaceLifecycleService(db: Db) {
  /**
   * Archives the shared sessions of an issue that became terminal. When a heartbeat run
   * still works on the issue, `defer` is true and the run-finish path calls
   * `finishDeferredCleanup` later.
   */
  async function reconcileTerminalIssueWorkspace(input: {
    issueId: string;
    defer: boolean;
    actor: CleanupActor;
  }): Promise<TerminalWorkspaceCleanupResult> {
    const issue = await db
      .select({
        companyId: issues.companyId,
        executionWorkspaceId: issues.executionWorkspaceId,
        status: issues.status,
      })
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || !(TERMINAL_ISSUE_STATUSES as readonly string[]).includes(issue.status)) {
      return { outcome: "not_applicable", archivedWorkspaceIds: [] };
    }
    if (input.defer) {
      return { outcome: "deferred", archivedWorkspaceIds: [] };
    }
    const archivedWorkspaceIds = await archiveSharedSessionsOfIssue(db, {
      companyId: issue.companyId,
      issueId: input.issueId,
      keepWorkspaceId: null,
      linkedWorkspaceId: issue.executionWorkspaceId,
      actor: input.actor,
      source: "terminal_issue",
      ignoreGrace: true,
    });
    return {
      outcome: archivedWorkspaceIds.length > 0 ? "archived" : "not_applicable",
      archivedWorkspaceIds,
    };
  }

  async function finishDeferredCleanup(input: {
    issueId: string;
    actor: CleanupActor;
  }): Promise<TerminalWorkspaceCleanupResult> {
    return reconcileTerminalIssueWorkspace({ ...input, defer: false });
  }

  /**
   * Called after a run persists a new shared session. Archives the sessions of earlier runs
   * on the same issue. Keeps the current session and the sessions that are possibly live.
   */
  async function archiveSupersededSharedSessionsForIssue(input: {
    companyId: string;
    issueId: string;
    keepWorkspaceId: string;
    actor: CleanupActor;
    now?: Date;
  }): Promise<string[]> {
    return archiveSharedSessionsOfIssue(db, {
      companyId: input.companyId,
      issueId: input.issueId,
      keepWorkspaceId: input.keepWorkspaceId,
      actor: input.actor,
      source: "superseded_session",
      now: input.now,
    });
  }

  return {
    reconcileTerminalIssueWorkspace,
    finishDeferredCleanup,
    archiveSupersededSharedSessionsForIssue,
  };
}
