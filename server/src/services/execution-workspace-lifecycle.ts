import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import type { ExecutionWorkspace, ExecutionWorkspaceCloseReadiness } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import {
  executionWorkspaceService,
  readExecutionWorkspaceConfig,
} from "./execution-workspaces.js";
import { parseProjectExecutionWorkspacePolicy } from "./execution-workspace-policy.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  stopRuntimeServicesForExecutionWorkspace,
} from "./workspace-runtime.js";

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

/**
 * Two runs on the same issue can overlap: each creates its own shared session and then
 * archives "everything but mine". Without a guard they archive each other's sessions and
 * stop the workspace-scoped runtime services of a live run. A session that was used
 * recently is therefore treated as possibly live and left alone; the next pass archives
 * it once it really stops being used.
 */
const SUPERSEDED_SHARED_SESSION_GRACE_MS = 15 * 60_000;

type CleanupActor = Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId">;

export type TerminalWorkspaceCleanupResult =
  | { outcome: "not_applicable" | "deferred"; workspace: ExecutionWorkspace | null }
  | { outcome: "blocked"; workspace: ExecutionWorkspace; reason: string }
  | { outcome: "archived" | "cleanup_failed"; workspace: ExecutionWorkspace; warnings: string[] };

function automaticCleanupBlockReason(readiness: ExecutionWorkspaceCloseReadiness) {
  const openIssueCount = readiness.linkedIssues.filter((issue) => !issue.isTerminal).length;
  if (openIssueCount > 0) {
    return openIssueCount === 1
      ? "Automatic cleanup is waiting for 1 linked issue to reach a terminal status."
      : `Automatic cleanup is waiting for ${openIssueCount} linked issues to reach a terminal status.`;
  }
  if (readiness.blockingReasons.length > 0) {
    return readiness.blockingReasons.join(" | ");
  }
  if (
    !readiness.isSharedWorkspace
    && (readiness.git?.hasDirtyTrackedFiles || readiness.git?.hasUntrackedFiles)
  ) {
    return "Automatic cleanup skipped because the workspace contains uncommitted files.";
  }
  return null;
}

async function writeLifecycleActivity(
  db: Db,
  workspace: ExecutionWorkspace,
  actor: CleanupActor,
  action: string,
  details: Record<string, unknown>,
) {
  await logActivity(db, {
    companyId: workspace.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId ?? null,
    runId: actor.runId ?? null,
    action,
    entityType: "execution_workspace",
    entityId: workspace.id,
    details,
  });
}

async function archiveExecutionWorkspace(
  db: Db,
  workspace: ExecutionWorkspace,
  actor: CleanupActor,
  source: "terminal_issue" | "superseded_session" = "terminal_issue",
): Promise<TerminalWorkspaceCleanupResult> {
  const svc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const closedAt = new Date();
  const claimedWorkspaceId = await db
    .update(executionWorkspaces)
    .set({
      status: "archived",
      closedAt,
      cleanupEligibleAt: null,
      cleanupReason: null,
      updatedAt: closedAt,
    })
    .where(
      and(
        eq(executionWorkspaces.id, workspace.id),
        eq(executionWorkspaces.companyId, workspace.companyId),
        inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
      ),
    )
    .returning({ id: executionWorkspaces.id })
    .then((rows) => rows[0]?.id ?? null);
  if (!claimedWorkspaceId) {
    return { outcome: "not_applicable", workspace: await svc.getById(workspace.id) };
  }

  let archivedWorkspace = await svc.getById(claimedWorkspaceId);
  if (!archivedWorkspace) {
    return { outcome: "not_applicable", workspace: null };
  }

  if (workspace.mode === "shared_workspace") {
    await db
      .update(issues)
      .set({
        executionWorkspaceId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issues.companyId, workspace.companyId),
          eq(issues.executionWorkspaceId, workspace.id),
        ),
      );
  }

  let cleanupWarnings: string[] = [];
  try {
    await stopRuntimeServicesForExecutionWorkspace({
      db,
      executionWorkspaceId: workspace.id,
      workspaceCwd: workspace.cwd,
    });
    const projectWorkspace = workspace.projectWorkspaceId
      ? await db
          .select({
            cwd: projectWorkspaces.cwd,
            cleanupCommand: projectWorkspaces.cleanupCommand,
          })
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.id, workspace.projectWorkspaceId),
              eq(projectWorkspaces.companyId, workspace.companyId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const projectPolicy = workspace.projectId
      ? await db
          .select({
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, workspace.companyId)))
          .then((rows) => parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy))
      : null;
    const config = readExecutionWorkspaceConfig(workspace.metadata);
    const cleanupResult = await cleanupExecutionWorkspaceArtifacts({
      workspace,
      projectWorkspace,
      teardownCommand: config?.teardownCommand ?? projectPolicy?.workspaceStrategy?.teardownCommand ?? null,
      cleanupCommand: config?.cleanupCommand ?? null,
      recorder: workspaceOperationsSvc.createRecorder({
        companyId: workspace.companyId,
        executionWorkspaceId: workspace.id,
      }),
    });
    cleanupWarnings = cleanupResult.warnings;
    const cleanupPatch: Record<string, unknown> = {
      closedAt,
      cleanupReason: cleanupWarnings.length > 0 ? cleanupWarnings.join(" | ") : null,
    };
    if (!cleanupResult.cleaned) cleanupPatch.status = "cleanup_failed";
    if (cleanupWarnings.length > 0 || !cleanupResult.cleaned) {
      archivedWorkspace = (await svc.update(workspace.id, cleanupPatch)) ?? archivedWorkspace;
    }
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    archivedWorkspace =
      (await svc.update(workspace.id, {
        status: "cleanup_failed",
        closedAt,
        cleanupReason: failureReason,
      })) ?? archivedWorkspace;
    cleanupWarnings = [failureReason];
  }

  const outcome = archivedWorkspace.status === "cleanup_failed" ? "cleanup_failed" : "archived";
  await writeLifecycleActivity(db, archivedWorkspace, actor, "execution_workspace.terminal_issue_cleanup", {
    outcome,
    cleanupWarnings,
    source,
  });
  return { outcome, workspace: archivedWorkspace, warnings: cleanupWarnings };
}

/**
 * Every run on an issue creates its own shared_workspace session, but only the one
 * issues.execution_workspace_id points at was ever archived. Sessions from earlier runs
 * stayed open forever: 870 open sessions across 252 issues in one measurement, up to 45
 * on a single issue. A shared session owns no directory on disk (see the early return in
 * cleanupExecutionWorkspaceArtifacts), so archiving a superseded one archives the record
 * and nothing else.
 */
async function archiveSupersededSharedSessions(
  db: Db,
  input: {
    companyId: string;
    sourceIssueId: string;
    keepWorkspaceId: string | null;
    actor: CleanupActor;
    /** Archive regardless of age: the issue is terminal, so it has no live runs left. */
    ignoreGrace?: boolean;
    now?: Date;
  },
): Promise<string[]> {
  const svc = executionWorkspaceService(db);
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - SUPERSEDED_SHARED_SESSION_GRACE_MS);
  const liveRunWorkspaces = await db
    .select({
      id: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'executionWorkspaceId'`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        or(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.sourceIssueId}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${input.sourceIssueId}`,
        ),
      ),
    );
  const protectedWorkspaceIds = new Set(
    liveRunWorkspaces
      .map((row) => row.id)
      .filter((id): id is string => Boolean(id)),
  );
  const rows = await db
    .select({ id: executionWorkspaces.id })
    .from(executionWorkspaces)
    .where(
      and(
        eq(executionWorkspaces.companyId, input.companyId),
        eq(executionWorkspaces.sourceIssueId, input.sourceIssueId),
        eq(executionWorkspaces.mode, "shared_workspace"),
        inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
        ...(input.ignoreGrace ? [] : [lt(executionWorkspaces.lastUsedAt, staleBefore)]),
      ),
    );
  const archivedIds: string[] = [];
  for (const row of rows) {
    if (input.keepWorkspaceId && row.id === input.keepWorkspaceId) continue;
    if (protectedWorkspaceIds.has(row.id)) continue;
    const workspace = await svc.getById(row.id);
    if (!workspace) continue;
    try {
      const result = await archiveExecutionWorkspace(db, workspace, input.actor, "superseded_session");
      if (result.outcome === "archived") archivedIds.push(row.id);
    } catch (error) {
      logger.warn(
        { err: error, executionWorkspaceId: row.id, sourceIssueId: input.sourceIssueId },
        "failed to archive superseded shared execution workspace session",
      );
    }
  }
  return archivedIds;
}

export function executionWorkspaceLifecycleService(db: Db) {
  const svc = executionWorkspaceService(db);

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
    if (!issue || !TERMINAL_ISSUE_STATUSES.has(issue.status)) {
      return { outcome: "not_applicable", workspace: null };
    }
    // The issue is terminal, so sessions from earlier runs are of no use to anyone,
    // whichever one issues.execution_workspace_id happens to point at.
    if (!input.defer) {
      await archiveSupersededSharedSessions(db, {
        companyId: issue.companyId,
        sourceIssueId: input.issueId,
        keepWorkspaceId: issue.executionWorkspaceId,
        actor: input.actor,
        ignoreGrace: true,
      });
    }
    if (!issue.executionWorkspaceId) {
      return { outcome: "not_applicable", workspace: null };
    }

    const workspace = await svc.getById(issue.executionWorkspaceId);
    if (!workspace || workspace.status === "archived" || workspace.status === "cleanup_failed") {
      return { outcome: "not_applicable", workspace };
    }

    const readiness = await svc.getCloseReadiness(workspace.id);
    if (!readiness) return { outcome: "not_applicable", workspace };
    const blockReason = automaticCleanupBlockReason(readiness);
    if (blockReason) {
      const shouldPersistReason = workspace.cleanupEligibleAt !== null || workspace.cleanupReason !== blockReason;
      const updated = shouldPersistReason
        ? (await svc.update(workspace.id, {
            cleanupEligibleAt: null,
            cleanupReason: blockReason,
          })) ?? workspace
        : workspace;
      if (shouldPersistReason) {
        await writeLifecycleActivity(db, updated, input.actor, "execution_workspace.cleanup_blocked", {
          issueId: input.issueId,
          reason: blockReason,
          source: "terminal_issue",
        });
      }
      return { outcome: "blocked", workspace: updated, reason: blockReason };
    }

    if (input.defer) {
      const updated = (await svc.update(workspace.id, {
        cleanupEligibleAt: new Date(),
        cleanupReason: "Automatic cleanup is waiting for the terminal heartbeat run to finish.",
      })) ?? workspace;
      await writeLifecycleActivity(db, updated, input.actor, "execution_workspace.cleanup_scheduled", {
        issueId: input.issueId,
        source: "terminal_issue",
      });
      return { outcome: "deferred", workspace: updated };
    }

    return archiveExecutionWorkspace(db, workspace, input.actor);
  }

  async function finishDeferredCleanup(input: {
    issueId: string;
    actor: CleanupActor;
  }): Promise<TerminalWorkspaceCleanupResult> {
    try {
      return await reconcileTerminalIssueWorkspace({
        ...input,
        defer: false,
      });
    } catch (error) {
      logger.warn(
        { err: error, issueId: input.issueId },
        "failed to automatically clean terminal issue execution workspace",
      );
      throw error;
    }
  }

  /**
   * Called when a new shared session is created: archives the sessions of earlier runs on
   * the same issue, keeping the current one and anything used recently — otherwise
   * overlapping runs archive each other's sessions.
   */
  async function archiveSupersededSharedSessionsForIssue(input: {
    companyId: string;
    issueId: string;
    keepWorkspaceId: string;
    actor: CleanupActor;
    now?: Date;
  }): Promise<string[]> {
    return archiveSupersededSharedSessions(db, {
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      keepWorkspaceId: input.keepWorkspaceId,
      actor: input.actor,
      now: input.now,
    });
  }

  return {
    reconcileTerminalIssueWorkspace,
    finishDeferredCleanup,
    archiveSupersededSharedSessionsForIssue,
  };
}
