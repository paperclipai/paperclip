import { and, eq, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { stopIdleSessionRuntimeServicesForExecutionWorkspace } from "./workspace-runtime.js";

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

/**
 * Archives one superseded shared session record. A shared session points at the project
 * workspace directory, so this function changes no file on disk and never sets
 * `cleanup_failed`. Isolated worktrees and terminal issues stay with the terminal workspace
 * reaper (`executionWorkspaceService.sweepTerminalWorkspaces`).
 *
 * The decision and the write happen in one transaction. It locks the issues linked to the
 * session, then the session row, in the same order as `bindTaskWorkspace`, and re-checks
 * under those locks that the session is still stale, that no other open issue uses it, and
 * that no queued or running heartbeat uses it. A binding or reuse that commits first wins.
 */
async function archiveSharedSession(
  db: Db,
  input: {
    companyId: string;
    workspaceId: string;
    issueId: string;
    staleBefore: Date;
    actor: CleanupActor;
  },
): Promise<boolean> {
  const closedAt = new Date();
  const archived = await db.transaction(async (tx) => {
    await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.executionWorkspaceId, input.workspaceId)))
      .for("no key update");
    const [session] = await tx
      .select({ id: executionWorkspaces.id, lastUsedAt: executionWorkspaces.lastUsedAt })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.id, input.workspaceId),
          eq(executionWorkspaces.companyId, input.companyId),
          eq(executionWorkspaces.mode, "shared_workspace"),
          inArray(executionWorkspaces.status, [...OPEN_WORKSPACE_STATUSES]),
        ),
      )
      .for("update");
    if (!session) return false;
    if (session.lastUsedAt && session.lastUsedAt.getTime() >= input.staleBefore.getTime()) return false;
    const [otherOpenIssue] = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.executionWorkspaceId, input.workspaceId),
          notInArray(issues.status, [...TERMINAL_ISSUE_STATUSES]),
          sql`${issues.id} <> ${input.issueId}`,
        ),
      )
      .limit(1);
    if (otherOpenIssue) return false;
    const [liveRun] = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'executionWorkspaceId' = ${input.workspaceId}`,
        ),
      )
      .limit(1);
    if (liveRun) return false;
    await tx
      .update(executionWorkspaces)
      .set({
        status: "archived",
        closedAt,
        cleanupEligibleAt: null,
        cleanupReason: SUPERSEDED_SHARED_SESSION_CLEANUP_REASON,
        updatedAt: closedAt,
      })
      .where(eq(executionWorkspaces.id, input.workspaceId));
    // A newer session replaced this one, so no issue should still point at it.
    await tx
      .update(issues)
      .set({ executionWorkspaceId: null, updatedAt: closedAt })
      .where(and(eq(issues.companyId, input.companyId), eq(issues.executionWorkspaceId, input.workspaceId)));
    return true;
  });
  if (!archived) return false;

  const warnings: string[] = [];
  try {
    // Stop only services that this session owns and that no live run leases. A newer
    // session can reuse a service that this session started, and project-owned services
    // belong to the project workspace, so both keep running.
    await stopIdleSessionRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId: input.workspaceId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(message);
    await db
      .update(executionWorkspaces)
      .set({ cleanupReason: `${SUPERSEDED_SHARED_SESSION_CLEANUP_REASON} | ${message}`, updatedAt: new Date() })
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
    details: { source: "superseded_session", warnings },
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
 * The queries here only pick candidates; `archiveSharedSession` decides under locks.
 */
async function archiveSupersededSharedSessionsOfIssue(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    keepWorkspaceId: string;
    actor: CleanupActor;
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
        eq(executionWorkspaces.sourceIssueId, input.issueId),
        lt(executionWorkspaces.lastUsedAt, staleBefore),
      ),
    );
  const candidateIds = candidates
    .map((row) => row.id)
    .filter((id) => id !== input.keepWorkspaceId && !protectedWorkspaceIds.has(id));

  const archivedIds: string[] = [];
  for (const workspaceId of candidateIds) {
    try {
      const archived = await archiveSharedSession(db, {
        companyId: input.companyId,
        workspaceId,
        issueId: input.issueId,
        staleBefore,
        actor: input.actor,
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
    return archiveSupersededSharedSessionsOfIssue(db, input);
  }

  return {
    archiveSupersededSharedSessionsForIssue,
  };
}
