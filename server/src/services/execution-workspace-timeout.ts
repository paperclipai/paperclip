import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces } from "@paperclipai/db";
import type {
  ExecutionWorkspacePullRequestRecord,
  PullRequestPolicy,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import {
  applyPullRequestResult,
  mergePullRequestRecordIntoMetadata,
  readPullRequestRecord,
  toExecutionWorkspace,
} from "./execution-workspaces.js";
import { runArchiveSideEffects } from "./execution-workspace-archive.js";
import { logger } from "../middleware/logger.js";

type TimerHandle = { handle: ReturnType<typeof setTimeout>; deadline: number };

const scheduled = new Map<string, TimerHandle>();

/**
 * Cancels any scheduled timer for the given workspace. Safe to call
 * when nothing is scheduled.
 */
export function cancelArchiveTimeout(workspaceId: string): void {
  const existing = scheduled.get(workspaceId);
  if (!existing) return;
  clearTimeout(existing.handle);
  scheduled.delete(workspaceId);
}

function computeDeadline(record: ExecutionWorkspacePullRequestRecord): number | null {
  const policy: PullRequestPolicy | undefined = record.policy;
  const timeoutMs = policy?.archiveTimeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  const requestedAt = record.requestedAt ? new Date(record.requestedAt).getTime() : Number.NaN;
  if (!Number.isFinite(requestedAt)) return null;
  return requestedAt + timeoutMs;
}

/**
 * Race-safe resolution of a timeout. Acquires a row lock on the
 * workspace to serialize against a consumer result call that may be
 * arriving at the same moment. Returns false when the record is
 * already terminal (the consumer won the race) or the workspace has
 * been deleted.
 */
async function finalizeTimeout(
  db: Db,
  companyId: string,
  workspaceId: string,
  archiveTimeoutMs: number,
): Promise<{ transitioned: boolean; archived: boolean }> {
  // Phase 1 (inside tx): acquire the workspace row lock so a
  // concurrent consumer /result call cannot overwrite us. Re-read
  // the record; if it is already terminal, exit without touching
  // state. Otherwise, stamp the synthetic `skipped` record and move
  // the workspace to `archived` + `closedAt`. We deliberately do NOT
  // emit any events yet — events carry `workspaceStatus` and the
  // final status is only known after phase 2 (cleanup) has had a
  // chance to downgrade to `cleanup_failed`.
  const phase1 = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT ${executionWorkspaces.id} FROM ${executionWorkspaces}
          WHERE ${and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, workspaceId))}
          FOR UPDATE`,
    );
    const row = await tx
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, companyId),
          eq(executionWorkspaces.id, workspaceId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
    const existingRecord = readPullRequestRecord(metadata);
    if (!existingRecord) return null;
    if (existingRecord.mode !== "blocking") return null;
    if (existingRecord.status !== "requested" && existingRecord.status !== "opened") return null;

    const result = applyPullRequestResult(existingRecord, row.status as any, {
      status: "skipped",
      error: "archive_timeout_reached",
    });
    const nextMetadata = mergePullRequestRecordIntoMetadata(metadata, result.record);
    const timedOutAt = new Date();
    await tx
      .update(executionWorkspaces)
      .set({
        metadata: nextMetadata,
        status: result.workspaceStatus,
        closedAt: timedOutAt,
        updatedAt: timedOutAt,
      })
      .where(
        and(
          eq(executionWorkspaces.companyId, companyId),
          eq(executionWorkspaces.id, workspaceId),
        ),
      );

    return {
      projectId: row.projectId,
      record: result.record,
      workspaceStatusAfterTransition: result.workspaceStatus,
      previousStatus: result.previousStatus,
      timedOutAt,
      existingRequestedAt: existingRecord.requestedAt ?? null,
    };
  });

  if (!phase1) return { transitioned: false, archived: false };

  // Phase 2 (outside tx): run the same archive side effects PATCH
  // archive would run (stop runtime services, detach shared-workspace
  // issue links, run cleanup + teardown commands). If cleanup fails,
  // downgrade the workspace to `cleanup_failed` so the events we emit
  // in phase 3 can tell the truth.
  let finalWorkspaceStatus = phase1.workspaceStatusAfterTransition;
  if (phase1.workspaceStatusAfterTransition === "archived") {
    const workspaceRow = await db
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.companyId, companyId),
          eq(executionWorkspaces.id, workspaceId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (workspaceRow) {
      const workspace = toExecutionWorkspace(workspaceRow);
      const sideEffects = await runArchiveSideEffects({ db, workspace });
      if (sideEffects.status !== "archived" || sideEffects.cleanupReason !== null) {
        await db
          .update(executionWorkspaces)
          .set({
            status: sideEffects.status,
            closedAt: sideEffects.closedAt,
            cleanupReason: sideEffects.cleanupReason,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(executionWorkspaces.companyId, companyId),
              eq(executionWorkspaces.id, workspaceId),
            ),
          );
        finalWorkspaceStatus = sideEffects.status;
      }
    }
  }

  // Phase 3: emit events with the true final state. Ordering is
  // preserved — `timed_out` first, `resolved` second — so auditors
  // can tell a consumer-driven close apart from a server-driven one
  // even if they only see one of the two events. The two activity-log
  // inserts are wrapped in a single transaction so a transient DB
  // failure cannot leave a `timed_out` row in the audit log without
  // its `resolved` counterpart (and vice versa).
  const deadlineIso = phase1.existingRequestedAt
    ? new Date(new Date(phase1.existingRequestedAt).getTime() + archiveTimeoutMs).toISOString()
    : null;
  await db.transaction(async (tx) => {
    await logActivity(tx as unknown as Db, {
      companyId,
      actorType: "system",
      actorId: "server",
      action: "execution_workspace.pull_request_timed_out",
      entityType: "execution_workspace",
      entityId: workspaceId,
      details: {
        workspaceId,
        projectId: phase1.projectId,
        record: phase1.record,
        archiveTimeoutMs,
        deadline: deadlineIso,
        timedOutAt: phase1.timedOutAt.toISOString(),
      },
    });
    await logActivity(tx as unknown as Db, {
      companyId,
      actorType: "system",
      actorId: "server",
      action: "execution_workspace.pull_request_resolved",
      entityType: "execution_workspace",
      entityId: workspaceId,
      details: {
        workspaceId,
        projectId: phase1.projectId,
        record: phase1.record,
        workspaceStatus: finalWorkspaceStatus,
        source: "archive_timeout",
        previousStatus: phase1.previousStatus,
        nextStatus: phase1.record.status,
        resolvedAt: phase1.record.resolvedAt,
      },
    });
  });
  return {
    transitioned: true,
    archived: phase1.workspaceStatusAfterTransition === "archived",
  };
}

function scheduleAt(
  db: Db,
  companyId: string,
  workspaceId: string,
  deadline: number,
  archiveTimeoutMs: number,
) {
  cancelArchiveTimeout(workspaceId);
  const delayMs = Math.max(0, deadline - Date.now());
  const handle = setTimeout(() => {
    scheduled.delete(workspaceId);
    void finalizeTimeout(db, companyId, workspaceId, archiveTimeoutMs).catch((err) => {
      logger.error({ err, workspaceId }, "pull-request timeout finalization failed");
    });
  }, delayMs);
  // node's setTimeout may keep the event loop alive; we want the
  // timer to not prevent process shutdown in tests.
  if (typeof (handle as any)?.unref === "function") (handle as any).unref();
  scheduled.set(workspaceId, { handle, deadline });
}

export function onPullRequestRequested(input: {
  db: Db;
  companyId: string;
  workspaceId: string;
  record: ExecutionWorkspacePullRequestRecord;
}): void {
  if (input.record.mode !== "blocking") return;
  const deadline = computeDeadline(input.record);
  if (deadline === null) return;
  const archiveTimeoutMs = input.record.policy?.archiveTimeoutMs;
  if (typeof archiveTimeoutMs !== "number") return;
  scheduleAt(input.db, input.companyId, input.workspaceId, deadline, archiveTimeoutMs);
}

/**
 * Boot-time re-scan. Called from server startup after the DB pool is
 * ready. Re-schedules blocking, non-terminal records whose deadline is
 * in the future, and processes immediately any whose deadline has
 * already passed.
 */
export async function rescheduleBlockingPullRequestTimeouts(db: Db): Promise<{ rescheduled: number }> {
  const rows = await db
    .select({
      id: executionWorkspaces.id,
      companyId: executionWorkspaces.companyId,
      metadata: executionWorkspaces.metadata,
    })
    .from(executionWorkspaces)
    .where(eq(executionWorkspaces.status, "in_review"));

  let rescheduled = 0;
  for (const row of rows) {
    const metadata = (row.metadata as Record<string, unknown> | null) ?? null;
    const record = readPullRequestRecord(metadata);
    if (!record) continue;
    if (record.mode !== "blocking") continue;
    if (record.status !== "requested" && record.status !== "opened") continue;
    const deadline = computeDeadline(record);
    if (deadline === null) continue;
    const archiveTimeoutMs = record.policy?.archiveTimeoutMs;
    if (typeof archiveTimeoutMs !== "number") continue;
    scheduleAt(db, row.companyId, row.id, deadline, archiveTimeoutMs);
    rescheduled += 1;
  }
  return { rescheduled };
}

// Test-only: clears all pending timers without executing them. Not
// exported through the module's canonical surface; callers should
// import it by name from this file.
export function __resetArchiveTimeoutSchedulerForTests(): void {
  for (const { handle } of scheduled.values()) clearTimeout(handle);
  scheduled.clear();
}

export function __getScheduledArchiveTimeoutForTests(workspaceId: string): number | null {
  return scheduled.get(workspaceId)?.deadline ?? null;
}
