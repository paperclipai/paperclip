import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, type EnvironmentLease } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
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
    or(inArray(workspaceOperations.status, ["running", "pending"]),
      sql`(${workspaceOperations.metadata}->'saveWork'->>'schema' = 'paperclip.remote-workspace-save-work.v1'
        and (${workspaceOperations.metadata}#>'{saveWork,unknown}' is distinct from 'false'::jsonb
          or case when jsonb_typeof(${workspaceOperations.metadata}#>'{saveWork,activeIds}') = 'array'
            then jsonb_array_length(${workspaceOperations.metadata}#>'{saveWork,activeIds}') <> 0 else true end))`),
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
      // Ordinary execution notifications must not turn each healthy current
      // version into a per-workspace maintenance read. A version with a stale
      // deadline still needs one pass to clear it; orphaned versions need grace.
      or(ne(executionWorkspaceSnapshots.status, "committed"), isNotNull(executionWorkspaceSnapshots.deleteAfter),
        sql`not exists (select 1 from ${executionWorkspaces} w
          where w.company_id = ${executionWorkspaceSnapshots.companyId}
            and w.id = ${executionWorkspaceSnapshots.executionWorkspaceId}
            and w.metadata->'remoteWorkspace'->>'snapshotId' = ${executionWorkspaceSnapshots.id}::text)`),
      or(isNull(executionWorkspaceSnapshots.deleteAfter),
        lte(executionWorkspaceSnapshots.deleteAfter, at),
        eq(executionWorkspaceSnapshots.status, "committed")),
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
          await options.storage.deleteObject(claimed.companyId, key, { signal, allVersions: true });
          if ((await options.storage.headObject(claimed.companyId, key, { signal })).exists) throw new Error("snapshot_object_still_present");
        }
        await db.update(executionWorkspaceSnapshots).set({ status: "deleted", deleteAfter: null, lastError: null, updatedAt: at })
          .where(and(eq(executionWorkspaceSnapshots.id, claimed.id), eq(executionWorkspaceSnapshots.status, "delete_requested")));
        // A parent inspected earlier in this page can now lose its last pin.
        // Revisit it once instead of waiting for an unrelated execution event.
        if (claimed.parentSnapshotId) rescanRequested = true;
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

/** Called in the lease-release transaction; an absent PID/timeout grants no authority. */
export async function clearRemoteWorkspaceLocationForReleasedLease(input: { db: Db | Tx; lease: EnvironmentLease }) {
  if (!hasRemoteTerminationReceipt(input.lease)
    || (input.lease.metadata?.remoteExecutionTermination as { state?: unknown } | undefined)?.state !== "destroyed") return;
  const workspaces = await input.db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.lease.companyId),
    sql`${executionWorkspaces.metadata}->'remoteWorkspace'->'location'->>'leaseId' = ${input.lease.id}`,
  )).for("update");
  for (const workspace of workspaces) {
    const authority = readRemoteWorkspaceAuthority(workspace.metadata);
    if (!authority?.location || authority.dirty || !authority.snapshotId || authority.writerRunId
      || authority.location.providerLeaseId !== input.lease.providerLeaseId || authority.location.environmentId !== input.lease.environmentId) continue;
    const [saved] = await input.db.select({ id: executionWorkspaceSnapshots.id }).from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.companyId, workspace.companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id),
      eq(executionWorkspaceSnapshots.id, authority.snapshotId), eq(executionWorkspaceSnapshots.status, "committed")));
    if (!saved) continue;
    await notifyRemoteWorkspaceSnapshots(input.db, `workspace:${workspace.id}`);
    await input.db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspace: { ...authority, location: null } }, updatedAt: new Date() })
      .where(and(eq(executionWorkspaces.id, workspace.id),
        sql`${executionWorkspaces.metadata}->'remoteWorkspace' = ${JSON.stringify(authority)}::jsonb`));
  }
}
