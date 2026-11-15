import { and, asc, eq, exists, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, type EnvironmentLease } from "@paperclipai/shared";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import type { StorageService } from "../storage/types.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { STORAGE_FAILURE_CLEANUP_MS } from "../storage/failure-cleanup.js";
import { logger } from "../middleware/logger.js";

export const REMOTE_WORKSPACE_SNAPSHOT_GRACE_MS = 7 * 86400_000;
export const REMOTE_WORKSPACE_SNAPSHOT_RETRY_MS = 15 * 60_000;
export const REMOTE_WORKSPACE_SNAPSHOT_COALESCE_MS = 1_000;
const SNAPSHOT_ABORT_CONCURRENCY = 8;
type Snapshot = typeof executionWorkspaceSnapshots.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type ReadDb = Pick<Db, "select"> | Pick<Tx, "select">;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value) : null;

export function notifyRemoteWorkspaceSnapshots(transaction: object, hint?: string) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.remoteWorkspaceSnapshots, hint);
}

export function snapshotAttemptKeys(row: Snapshot) {
  const uploads = Array.isArray(row.metadata?.uploads) ? row.metadata.uploads as Array<{ objectKey?: unknown }> : [];
  const prefix = `${row.companyId}/workspace-snapshots/${row.executionWorkspaceId}/${row.id}/`;
  return [...new Set(uploads.flatMap(upload => typeof upload?.objectKey === "string" && upload.objectKey !== row.objectKey
    && upload.objectKey.startsWith(prefix) && !upload.objectKey.includes("..") ? [upload.objectKey] : []))];
}

export async function abortSnapshotAttemptUploads(storage: StorageService, companyId: string, keys: Iterable<string>, signal?: AbortSignal) {
  const abort = storage.abortIncompleteUploads?.bind(storage);
  const pending = [...keys];
  if (!abort || !pending.length) return 0;
  signal?.throwIfAborted();
  const bounded = AbortSignal.timeout(STORAGE_FAILURE_CLEANUP_MS);
  const deadline = signal ? AbortSignal.any([signal, bounded]) : bounded;
  let aborted = 0;
  const worker = async () => {
    for (let key = pending.shift(); key !== undefined && !deadline.aborted; key = pending.shift()) {
      try {
        const count = await abort(companyId, key, { signal: deadline });
        aborted += count;
      } catch (error) {
        if (signal?.aborted) throw error;
        logger.warn({ err: error, companyId, objectKey: key }, "workspace snapshot multipart upload abort failed");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SNAPSHOT_ABORT_CONCURRENCY, pending.length) }, worker));
  signal?.throwIfAborted();
  if (pending.length) logger.warn({ companyId, remaining: pending.length }, "workspace snapshot multipart upload abort ran out of time");
  return aborted;
}

function abandonedUploadOperationId(row: Snapshot) {
  if (row.status !== "delete_requested") return null;
  const abandoned = row.metadata?.abandonedUpload as { operationId?: unknown } | undefined;
  return typeof abandoned?.operationId === "string" && abandoned.operationId === row.sourceOperationId ? abandoned.operationId : null;
}

type Pin = { kind: "workspace" } | { kind: "import" | "child"; snapshotId: string } | { kind: "operation"; operationId: string }
  | { kind: "run"; runId: string } | { kind: "recovery"; actionId: string };
type PinRow = { companyId: SQL; id: SQL; workspaceId: SQL; sourceOperationId: SQL; abandonedOperationId: SQL; sourceIssueId: SQL; importedChild: SQL };
const RETENTION_PIN = "retentionPin";
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const pinSource = alias(executionWorkspaceSnapshots, "retention_pin_source");
const snapshot = executionWorkspaceSnapshots;

function literalPinRow(row: Snapshot, sourceIssueId: string | null | undefined): PinRow {
  return { companyId: sql`${row.companyId}::uuid`, id: sql`${row.id}::uuid`, workspaceId: sql`${row.executionWorkspaceId}::uuid`,
    sourceOperationId: sql`${row.sourceOperationId}::uuid`, abandonedOperationId: sql`${abandonedUploadOperationId(row)}::text`,
    sourceIssueId: sourceIssueId ? sql`${sourceIssueId}::uuid` : sql`null::uuid`,
    importedChild: sql`${JSON.stringify([{ workspaceId: row.executionWorkspaceId, snapshotId: row.id }])}::jsonb` };
}

const correlatedPinRow: PinRow = {
  companyId: sql`${snapshot.companyId}`, id: sql`${snapshot.id}`, workspaceId: sql`${snapshot.executionWorkspaceId}`,
  sourceOperationId: sql`${snapshot.sourceOperationId}`,
  abandonedOperationId: sql`(case when ${snapshot.status} = 'delete_requested'
    and ${snapshot.metadata}->'abandonedUpload'->>'operationId' = ${snapshot.sourceOperationId}::text
    then ${snapshot.sourceOperationId}::text end)`,
  sourceIssueId: sql`(select w.source_issue_id from ${executionWorkspaces} w
    where w.company_id = ${snapshot.companyId} and w.id = ${snapshot.executionWorkspaceId})`,
  importedChild: sql`jsonb_build_array(jsonb_build_object('workspaceId', ${snapshot.executionWorkspaceId}::text, 'snapshotId', ${snapshot.id}::text))`,
};

const importPin = (row: PinRow) => and(sql`${pinSource.companyId} = ${row.companyId}`, ne(pinSource.status, "deleted"),
  sql`${pinSource.metadata} ? 'importedWorkspaceChildren'`,
  sql`${pinSource.metadata}->'importedWorkspaceChildren' @> ${row.importedChild}`);

const operationPin = (row: PinRow) => and(sql`${workspaceOperations.companyId} = ${row.companyId}`,
  sql`${workspaceOperations.executionWorkspaceId} = ${row.workspaceId}`,
  or(inArray(workspaceOperations.status, ["running", "pending"]),
    sql`(${workspaceOperations.status} = 'failed' and ${workspaceOperations.metadata} ? 'lastFailure'
      and ${workspaceOperations.metadata}->'retiredSave' is null
      and ${workspaceOperations.id}::text is distinct from ${row.abandonedOperationId})`,
    sql`(${workspaceOperations.metadata}->'saveWork'->>'schema' = 'paperclip.remote-workspace-save-work.v1'
      and (${workspaceOperations.metadata}#>'{saveWork,unknown}' is distinct from 'false'::jsonb
        or case when jsonb_typeof(${workspaceOperations.metadata}#>'{saveWork,activeIds}') = 'array'
          then jsonb_array_length(${workspaceOperations.metadata}#>'{saveWork,activeIds}') <> 0 else true end))`),
  sql`(${workspaceOperations.id} = ${row.sourceOperationId}
    or ${workspaceOperations.metadata}->>'snapshotId' = ${row.id}::text
    or ${workspaceOperations.metadata}->>'parentSnapshotId' = ${row.id}::text)`);

const childPin = (row: PinRow) => and(sql`${pinSource.companyId} = ${row.companyId}`,
  sql`${pinSource.executionWorkspaceId} = ${row.workspaceId}`, sql`${pinSource.parentSnapshotId} = ${row.id}`,
  inArray(pinSource.status, ["pending", "uploaded"]));

const runPin = (row: PinRow) => and(sql`${heartbeatRuns.companyId} = ${row.companyId}`, inArray(heartbeatRuns.status, ["queued", "running"]),
  sql`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'->>'workspaceId' = ${row.workspaceId}::text`,
  sql`${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'->>'snapshotId' = ${row.id}::text`);

const recoveryPin = (row: PinRow) => and(sql`${issueRecoveryActions.companyId} = ${row.companyId}`,
  inArray(issueRecoveryActions.status, ["active", "escalated"]),
  sql`(${issueRecoveryActions.sourceIssueId} = ${row.sourceIssueId}
    or ${issueRecoveryActions.evidence}->>'snapshotId' = ${row.id}::text
    or ${issueRecoveryActions.evidence}->>'workspaceId' = ${row.workspaceId}::text
    or ${issueRecoveryActions.evidence}->'remoteWorkspace'->>'snapshotId' = ${row.id}::text)`);

async function pinned(db: ReadDb, row: Snapshot): Promise<Pin | null> {
  const [workspace] = await db.select({ sourceIssueId: executionWorkspaces.sourceIssueId, metadata: executionWorkspaces.metadata })
    .from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, row.companyId), eq(executionWorkspaces.id, row.executionWorkspaceId)));
  if ((workspace?.metadata?.remoteWorkspace as { snapshotId?: unknown } | undefined)?.snapshotId === row.id) return { kind: "workspace" };
  const ref = literalPinRow(row, workspace?.sourceIssueId);
  const [importedBy] = await db.select({ id: pinSource.id }).from(pinSource).where(importPin(ref)).limit(1);
  if (importedBy) return { kind: "import", snapshotId: importedBy.id };
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(operationPin(ref)).limit(1);
  if (operation) return { kind: "operation", operationId: operation.id };
  const [child] = await db.select({ id: pinSource.id }).from(pinSource).where(childPin(ref)).limit(1);
  if (child) return { kind: "child", snapshotId: child.id };
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(runPin(ref)).limit(1);
  if (run) return { kind: "run", runId: run.id };
  const [recovery] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(recoveryPin(ref)).limit(1);
  return recovery ? { kind: "recovery", actionId: recovery.id } : null;
}

function recordedPinId(key: "snapshotId" | "operationId" | "runId" | "actionId") {
  const value = sql`${snapshot.metadata}->${sql.raw(`'${RETENTION_PIN}'`)}->>${sql.raw(`'${key}'`)}`;
  return sql`(case when ${value} ~* ${UUID_PATTERN} then (${value})::uuid end)`;
}

function recordedPinHolds(db: Db) {
  const row = correlatedPinRow;
  return sql`(case ${snapshot.metadata}->${sql.raw(`'${RETENTION_PIN}'`)}->>'kind'
    when 'workspace' then exists (select 1 from ${executionWorkspaces} w where w.company_id = ${row.companyId}
      and w.id = ${row.workspaceId} and w.metadata->'remoteWorkspace'->>'snapshotId' = ${row.id}::text)
    when 'import' then ${exists(db.select({ id: pinSource.id }).from(pinSource).where(and(eq(pinSource.id, recordedPinId("snapshotId")), importPin(row))))}
    when 'operation' then ${exists(db.select({ id: workspaceOperations.id }).from(workspaceOperations)
      .where(and(eq(workspaceOperations.id, recordedPinId("operationId")), operationPin(row))))}
    when 'child' then ${exists(db.select({ id: pinSource.id }).from(pinSource).where(and(eq(pinSource.id, recordedPinId("snapshotId")), childPin(row))))}
    when 'run' then ${exists(db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, recordedPinId("runId")), runPin(row))))}
    when 'recovery' then ${exists(db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.id, recordedPinId("actionId")), recoveryPin(row))))}
    else false end)`;
}

function samePin(value: unknown, pin: Pin) {
  if (!value || typeof value !== "object") return false;
  const recorded = value as Record<string, unknown>, entries = Object.entries(pin);
  return Object.keys(recorded).length === entries.length && entries.every(([key, item]) => recorded[key] === item);
}

function withoutPin(metadata: Snapshot["metadata"]) {
  if (!metadata || !Object.hasOwn(metadata, RETENTION_PIN)) return {};
  const { [RETENTION_PIN]: _released, ...rest } = metadata;
  return { metadata: rest };
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
      sql`not (${executionWorkspaceSnapshots.deleteAfter} is null and ${recordedPinHolds(db)})`,
      after ? sql`${executionWorkspaceSnapshots.id} > ${after}::uuid` : undefined,
    )).orderBy(asc(executionWorkspaceSnapshots.id)).limit(batch + 1);
    result.truncated = rows.length > batch;
    for (const candidate of rows.slice(0, batch)) {
      signal?.throwIfAborted(); result.checked++; after = candidate.id;
      try {
        const claimed = await db.transaction(async tx => {
          const [row] = await tx.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, candidate.id)).for("update");
          if (!row || row.status === "deleted") return null;
          const pin = await pinned(tx, row);
          if (pin) {
            result.pinned++;
            const metadata: Record<string, unknown> = { ...row.metadata, [RETENTION_PIN]: pin };
            if (row.status === "superseded" && row.deleteAfter) metadata.retentionDueAt = row.deleteAfter.toISOString();
            if (row.status === "committed") delete metadata.retentionDueAt;
            if (row.deleteAfter || !samePin(row.metadata?.[RETENTION_PIN], pin)) {
              await tx.update(executionWorkspaceSnapshots).set({ deleteAfter: null, metadata }).where(eq(executionWorkspaceSnapshots.id, row.id));
            }
            return null;
          }
          const deadline = row.deleteAfter ?? (row.status === "superseded" ? date(row.metadata?.retentionDueAt) : null)
            ?? new Date((row.status === "pending" || row.status === "uploaded" ? row.createdAt.getTime() : at.getTime()) + REMOTE_WORKSPACE_SNAPSHOT_GRACE_MS);
          if (row.status !== "delete_requested" && deadline > at) {
            result.scheduled++;
            await tx.update(executionWorkspaceSnapshots).set({ deleteAfter: deadline, ...withoutPin(row.metadata),
              ...(row.status === "committed" ? { status: "superseded" as const } : {}) }).where(eq(executionWorkspaceSnapshots.id, row.id));
            return null;
          }
          if (row.status === "delete_requested" && row.deleteAfter && row.deleteAfter > at) return null;
          const [saved] = await tx.update(executionWorkspaceSnapshots).set({ status: "delete_requested", deleteAfter: at, lastError: null, ...withoutPin(row.metadata) })
            .where(eq(executionWorkspaceSnapshots.id, row.id)).returning();
          return saved!;
        });
        if (!claimed) continue;
        // New readers cannot adopt a delete_requested record. Recheck all
        // durable references immediately before any irreversible object I/O.
        const pin = await pinned(db, claimed);
        if (pin) {
          await db.update(executionWorkspaceSnapshots).set({ deleteAfter: null,
            metadata: sql`coalesce(${executionWorkspaceSnapshots.metadata}, '{}'::jsonb) || ${JSON.stringify({ [RETENTION_PIN]: pin })}::jsonb` })
            .where(eq(executionWorkspaceSnapshots.id, claimed.id));
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
        await abortSnapshotAttemptUploads(options.storage, claimed.companyId, keys, signal);
        for (const key of keys) {
          signal?.throwIfAborted();
          await options.storage.deleteObject(claimed.companyId, key, { signal, allVersions: true });
          if ((await options.storage.headObject(claimed.companyId, key, { signal })).exists) throw new Error("snapshot_object_still_present");
        }
        await db.update(executionWorkspaceSnapshots).set({ status: "deleted", deleteAfter: null, lastError: null, updatedAt: at })
          .where(and(eq(executionWorkspaceSnapshots.id, claimed.id), eq(executionWorkspaceSnapshots.status, "delete_requested")));
        // A parent inspected earlier in this page can now lose its last pin.
        // Revisit it once instead of waiting for an unrelated execution event.
        if (claimed.parentSnapshotId || Array.isArray(claimed.metadata?.importedWorkspaceChildren)
          && claimed.metadata.importedWorkspaceChildren.length > 0) rescanRequested = true;
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
    retryMs: REMOTE_WORKSPACE_SNAPSHOT_RETRY_MS, coalesceMs: REMOTE_WORKSPACE_SNAPSHOT_COALESCE_MS, pausePassiveMaintenance: true,
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
