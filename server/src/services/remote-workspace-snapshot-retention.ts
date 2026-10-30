import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const REMOTE_WORKSPACE_SNAPSHOT_GRACE_MS = 7 * 86400_000;
export const REMOTE_WORKSPACE_SNAPSHOT_RETRY_MS = 15 * 60_000;
type Snapshot = typeof executionWorkspaceSnapshots.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReadDb = Pick<Db, "select"> | Pick<Tx, "select">;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value) : null;

export function notifyRemoteWorkspaceSnapshots(transaction: object, hint?: string) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.remoteWorkspaceSnapshots, hint);
}

async function pinned(db: ReadDb, row: Snapshot) {
  const [workspace] = await db.select({ id: executionWorkspaces.id, sourceIssueId: executionWorkspaces.sourceIssueId,
    metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, row.companyId), eq(executionWorkspaces.id, row.executionWorkspaceId),
  ));
  if ((workspace?.metadata?.remoteWorkspace as { snapshotId?: unknown } | undefined)?.snapshotId === row.id) return true;
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.companyId, row.companyId), eq(workspaceOperations.executionWorkspaceId, row.executionWorkspaceId),
    inArray(workspaceOperations.status, ["running", "pending"]),
    sql`(${workspaceOperations.id} = ${row.sourceOperationId}::uuid
      or ${workspaceOperations.metadata}->>'snapshotId' = ${row.id}
      or ${workspaceOperations.metadata}->>'parentSnapshotId' = ${row.id})`,
  )).limit(1);
  if (operation) return true;
  const [child] = await db.select({ id: executionWorkspaceSnapshots.id }).from(executionWorkspaceSnapshots).where(and(
    eq(executionWorkspaceSnapshots.companyId, row.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, row.executionWorkspaceId),
    eq(executionWorkspaceSnapshots.parentSnapshotId, row.id), inArray(executionWorkspaceSnapshots.status, ["pending", "uploaded"]),
  )).limit(1);
  if (child) return true;
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, row.companyId),
    inArray(heartbeatRuns.status, ["queued", "running"]),
    sql`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'->>'workspaceId' = ${row.executionWorkspaceId}`,
    sql`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'->>'snapshotId' = ${row.id}`,
  )).limit(1);
  if (run) return true;
  const [recovery] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, row.companyId), inArray(issueRecoveryActions.status, ["active", "escalated"]),
    sql`(${workspace?.sourceIssueId ? sql`${issueRecoveryActions.sourceIssueId} = ${workspace.sourceIssueId}::uuid` : sql`false`}
      or ${issueRecoveryActions.evidence}->>'snapshotId' = ${row.id}
      or ${issueRecoveryActions.evidence}->>'workspaceId' = ${row.executionWorkspaceId}
      or ${issueRecoveryActions.evidence}->'remoteWorkspace'->>'snapshotId' = ${row.id})`,
  )).limit(1);
  return Boolean(recovery);
}

/** Producers wake this owner; pinned history carries no speculative retry. */
export function remoteWorkspaceSnapshotRetentionService(db: Db, options: {
  storage: StorageService; now?: () => Date; batchSize?: number;
}) {
  const now = options.now ?? (() => new Date()), batch = options.batchSize ?? 50;
  let after: string | null = null;
  let scanning = false;
  let rescanRequested = false;
  async function tick(signal?: AbortSignal) {
    scanning = true;
    try {
    const at = now(), result = { checked: 0, pinned: 0, scheduled: 0, deleted: 0, failed: 0, truncated: false };
    const rows = await db.select().from(executionWorkspaceSnapshots).where(and(
      sql`${executionWorkspaceSnapshots.status} <> 'deleted'`,
      after ? sql`${executionWorkspaceSnapshots.id} > ${after}::uuid` : undefined,
    )).orderBy(asc(executionWorkspaceSnapshots.id)).limit(batch + 1);
    result.truncated = rows.length > batch;
    for (const candidate of rows.slice(0, batch)) {
      signal?.throwIfAborted(); result.checked++; after = candidate.id;
      try {
        const claimed = await db.transaction(async tx => {
          const [row] = await tx.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, candidate.id)).for("update");
          if (!row || row.status === "deleted") return null;
          if (await pinned(tx, row)) {
            result.pinned++;
            const metadata = { ...row.metadata };
            if (row.status === "superseded" && row.deleteAfter) metadata.retentionDueAt = row.deleteAfter.toISOString();
            if (row.status === "committed") delete metadata.retentionDueAt;
            if (row.deleteAfter) await tx.update(executionWorkspaceSnapshots).set({ deleteAfter: null, metadata }).where(eq(executionWorkspaceSnapshots.id, row.id));
            return null;
          }
          const deadline = row.deleteAfter ?? (row.status === "superseded" ? date(row.metadata?.retentionDueAt) : null)
            ?? new Date((row.status === "pending" || row.status === "uploaded" ? row.createdAt.getTime() : at.getTime()) + REMOTE_WORKSPACE_SNAPSHOT_GRACE_MS);
          if (row.status !== "delete_requested" && deadline > at) {
            result.scheduled++;
            await tx.update(executionWorkspaceSnapshots).set({ deleteAfter: deadline,
              ...(row.status === "committed" ? { status: "superseded" as const } : {}) }).where(eq(executionWorkspaceSnapshots.id, row.id));
            return null;
          }
          if (row.status === "delete_requested" && row.deleteAfter && row.deleteAfter > at) return null;
          const [saved] = await tx.update(executionWorkspaceSnapshots).set({ status: "delete_requested", deleteAfter: at, lastError: null })
            .where(eq(executionWorkspaceSnapshots.id, row.id)).returning();
          return saved!;
        });
        if (!claimed) continue;
        // New readers cannot adopt a delete_requested record. Recheck all
        // durable references immediately before any irreversible object I/O.
        if (await pinned(db, claimed)) {
          await db.update(executionWorkspaceSnapshots).set({ deleteAfter: null }).where(eq(executionWorkspaceSnapshots.id, claimed.id));
          result.pinned++; continue;
        }
        const uploads = Array.isArray(claimed.metadata?.uploads) ? claimed.metadata.uploads : [];
        const keys = new Set<string>();
        for (const value of uploads) {
          if (!value || typeof value !== "object" || typeof (value as { objectKey?: unknown }).objectKey !== "string") throw new Error("snapshot_upload_reference_invalid");
          keys.add((value as { objectKey: string }).objectKey);
        }
        if (claimed.objectKey) keys.add(claimed.objectKey);
        const prefix = `${claimed.companyId}/workspace-snapshots/${claimed.executionWorkspaceId}/${claimed.id}/`;
        for (const key of keys) {
          if (!key.startsWith(prefix) || key.includes("..") || key.includes("\\")) throw new Error("snapshot_upload_scope_invalid");
        }
        for (const key of keys) {
          signal?.throwIfAborted();
          await options.storage.deleteObject(claimed.companyId, key, { signal });
          if ((await options.storage.headObject(claimed.companyId, key, { signal })).exists) throw new Error("snapshot_object_still_present");
        }
        await db.update(executionWorkspaceSnapshots).set({ status: "deleted", deleteAfter: null, lastError: null, updatedAt: at })
          .where(and(eq(executionWorkspaceSnapshots.id, claimed.id), eq(executionWorkspaceSnapshots.status, "delete_requested")));
        result.deleted++;
      } catch (error) {
        if (signal?.aborted) throw error;
        result.failed++;
        await db.update(executionWorkspaceSnapshots).set({ lastError: "snapshot_cleanup_failed",
          deleteAfter: new Date(at.getTime() + REMOTE_WORKSPACE_SNAPSHOT_RETRY_MS) }).where(eq(executionWorkspaceSnapshots.id, candidate.id));
      }
    }
    if (!result.truncated) {
      after = null;
      // Finish the current ordered scan before revisiting a producer that may
      // have inserted a lower UUID. Repeated hints cannot starve later pages.
      if (rescanRequested) { rescanRequested = false; result.truncated = true; }
    }
    return result;
    } finally { scanning = false; }
  }
  async function nextDeadlineAt() {
    const [row] = await db.select({ at: sql<Date | null>`min(${executionWorkspaceSnapshots.deleteAfter})` }).from(executionWorkspaceSnapshots)
      .where(sql`${executionWorkspaceSnapshots.status} <> 'deleted'`);
    return row?.at ? new Date(row.at).getTime() : null;
  }
  return { tick, nextDeadlineAt, resetCursor: () => { if (scanning || after !== null) rescanRequested = true; } };
}

export function registerRemoteWorkspaceSnapshotRetentionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, service: ReturnType<typeof remoteWorkspaceSnapshotRetentionService>,
  onResult: (result: Awaited<ReturnType<typeof service.tick>>) => void,
) {
  let next: number | null = null;
  return coordinator.register(DELIVERY_QUEUES.remoteWorkspaceSnapshots, {
    retryMs: REMOTE_WORKSPACE_SNAPSHOT_RETRY_MS, pausePassiveMaintenance: true,
    onSettled: () => service.resetCursor(),
    run: async signal => { next = null; const result = await service.tick(signal); onResult(result);
      next = result.truncated ? Date.now() + 1000 : await service.nextDeadlineAt(); },
    hasPending: async () => false, nextRunAt: () => next,
  });
}
