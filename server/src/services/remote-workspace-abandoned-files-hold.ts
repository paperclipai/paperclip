import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { companies, environmentLeases, executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { reusableSandboxNotKeptAfterReplacementSql } from "./reusable-sandbox-kept-marker.js";
import {
  ABANDONED_WORKSPACE_FILES_RETENTION_DAYS, ABANDONED_WORKSPACE_FILES_RETENTION_MS, REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA,
} from "./remote-workspace-epoch-abandonment.js";

export { ABANDONED_WORKSPACE_FILES_RETENTION_DAYS, ABANDONED_WORKSPACE_FILES_RETENTION_MS };
export const ABANDONED_WORKSPACE_FILES_PARKED_KEY = "abandonedWorkspaceFilesParked";
export const ABANDONED_WORKSPACE_FILES_PARKED_REASON = "abandoned_workspace_files_held";
export const ABANDONED_WORKSPACE_FILES_RELEASED_REASON = "abandoned_workspace_files_released";
export const ABANDONED_WORKSPACE_FILES_RELEASE_KEY = "abandonedWorkspaceFilesRelease";
const ABANDONED_WORKSPACE_FILES_EXPIRY_BACKOFF_MS = 5 * 60_000;
const ABANDONED_WORKSPACE_FILES_EXPIRY_MAX_BACKOFF_MS = 6 * 60 * 60_000;

async function existingIssueId(db: Db, companyId: string, issueId: string | null): Promise<string | null> {
  if (!issueId) return null;
  const [issue] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
  return issue?.id ?? null;
}

async function existingRunId(db: Db, companyId: string, runId: string | null | undefined): Promise<string | undefined> {
  if (!runId) return undefined;
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  return run?.id;
}

function days(count: number) {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

export type AbandonedWorkspaceFilesReleaseReason = "recovered" | "discarded" | "retention_expired";

type HoldLease = Pick<typeof environmentLeases.$inferSelect, "companyId" | "provider" | "providerLeaseId">;
type Receipt = Record<string, unknown> & { location?: { providerLeaseId?: unknown }; released?: unknown };

export function abandonedWorkspaceFilesHeldSql(companyId: SQL | string, providerLeaseId: SQL | string): SQL {
  return sql`exists (select 1 from execution_workspaces held_workspace
    cross join lateral jsonb_array_elements(case when jsonb_typeof(held_workspace.metadata->'remoteWorkspaceAbandonedEpochs') = 'array'
      then held_workspace.metadata->'remoteWorkspaceAbandonedEpochs' else '[]'::jsonb end) held_receipt
    where held_workspace.company_id = ${companyId}
      and held_workspace.metadata ? 'remoteWorkspaceAbandonedEpochs'
      and held_receipt->>'schema' = ${REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA}
      and held_receipt->'location'->>'providerLeaseId' = ${providerLeaseId}
      and coalesce(jsonb_typeof(held_receipt->'released'), 'null') = 'null')`;
}

export function abandonedWorkspaceFilesHeldOnLeaseRowSql(): SQL {
  return sql`(${environmentLeases.providerLeaseId} is not null and coalesce(${environmentLeases.provider}, 'local') <> 'local'
    and ${abandonedWorkspaceFilesHeldSql(sql`${environmentLeases.companyId}`, sql`${environmentLeases.providerLeaseId}`)})`;
}

export async function abandonedWorkspaceFilesHeldOnLease(db: Pick<Db, "select">, lease: HoldLease): Promise<boolean> {
  if (!lease.providerLeaseId || !lease.provider || lease.provider === "local") return false;
  const [row] = await db.select({ held: sql<boolean>`${abandonedWorkspaceFilesHeldSql(sql`${companies.id}`, lease.providerLeaseId)}` })
    .from(companies).where(eq(companies.id, lease.companyId)).limit(1);
  return row?.held === true;
}

export function abandonedWorkspaceFilesParked(lease: { metadata?: Record<string, unknown> | null }): boolean {
  return lease.metadata?.[ABANDONED_WORKSPACE_FILES_PARKED_KEY] != null;
}

export async function parkAbandonedWorkspaceFilesLease(db: Db, lease: Pick<typeof environmentLeases.$inferSelect,
  "id" | "companyId" | "heartbeatRunId">, statuses: string[]): Promise<boolean> {
  const now = new Date();
  const parked = await writeEnvironmentCleanup(db, tx => tx.update(environmentLeases).set({
    status: "retained", cleanupStatus: "failed", failureReason: ABANDONED_WORKSPACE_FILES_PARKED_REASON, updatedAt: now,
    metadata: sql`(case when jsonb_typeof(${environmentLeases.metadata}) = 'object' then ${environmentLeases.metadata} else '{}'::jsonb end)
      || ${JSON.stringify({ [ABANDONED_WORKSPACE_FILES_PARKED_KEY]: { parkedAt: now.toISOString() }, pendingCleanupInFlight: false })}::jsonb`,
  }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
    inArray(environmentLeases.status, statuses),
    sql`coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') != 'true'`,
    abandonedWorkspaceFilesHeldOnLeaseRowSql())).returning({ id: environmentLeases.id }),
  { companyId: lease.companyId, runId: lease.heartbeatRunId ?? undefined, leaseId: lease.id });
  return parked.length > 0;
}

function receiptDueAt(receipt: Receipt): number {
  const retry = typeof receipt.expiryRetryAt === "string" ? Date.parse(receipt.expiryRetryAt) : Number.NaN;
  return Math.max(receiptRetainUntil(receipt), Number.isFinite(retry) ? retry : 0);
}

function receiptRetainUntil(receipt: Receipt): number {
  const explicit = typeof receipt.retainUntil === "string" ? Date.parse(receipt.retainUntil) : Number.NaN;
  if (Number.isFinite(explicit)) return explicit;
  const abandonedAt = typeof receipt.abandonedAt === "string" ? Date.parse(receipt.abandonedAt) : Number.NaN;
  return (Number.isFinite(abandonedAt) ? abandonedAt : 0) + ABANDONED_WORKSPACE_FILES_RETENTION_MS;
}

function unreleased(receipt: unknown): receipt is Receipt {
  const value = receipt as Receipt | null;
  return value?.schema === REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA && value.released == null
    && typeof value.location?.providerLeaseId === "string";
}

export async function releaseAbandonedWorkspaceFiles(db: Db, input: {
  companyId: string; workspaceId: string; epoch: number; reason: AbandonedWorkspaceFilesReleaseReason;
  actorType: "system" | "user" | "agent"; actorId: string; now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
    const receipts = Array.isArray(workspace?.metadata?.remoteWorkspaceAbandonedEpochs)
      ? workspace!.metadata!.remoteWorkspaceAbandonedEpochs as unknown[] : [];
    const target = receipts.find(receipt => unreleased(receipt) && receipt.epoch === input.epoch) as Receipt | undefined;
    if (!workspace || !target) return false;
    const released = { reason: input.reason, releasedAt: now.toISOString(), actorType: input.actorType, actorId: input.actorId };
    await tx.update(executionWorkspaces).set({ updatedAt: now, metadata: { ...workspace.metadata,
      remoteWorkspaceAbandonedEpochs: receipts.map(receipt => receipt === target ? { ...target, released } : receipt) } })
      .where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, workspace.id)));
    const providerLeaseId = target.location!.providerLeaseId as string;
    const recordedRunId = typeof target.runId === "string" ? target.runId : undefined;
    const [run] = recordedRunId ? await tx.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.issueId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, recordedRunId))) : [];
    const runId = run?.id;
    const issueId = await existingIssueId(tx, input.companyId, workspace.sourceIssueId ?? run?.issueId ?? null);
    const keptDays = Math.max(1, Math.round((now.getTime() - Date.parse(String(target.abandonedAt ?? now.toISOString()))) / 86_400_000));
    const marker = { issueId, workspaceId: workspace.id, abandonedEpoch: input.epoch, reason: input.reason, keptDays, runId: runId ?? null };
    const unparked = await writeEnvironmentCleanup(tx, write => write.update(environmentLeases).set({
      status: "pending_cleanup", cleanupStatus: "failed", failureReason: ABANDONED_WORKSPACE_FILES_RELEASED_REASON,
      releasedAt: now, updatedAt: now,
      metadata: sql`(${environmentLeases.metadata} - ${ABANDONED_WORKSPACE_FILES_PARKED_KEY})
        || ${JSON.stringify({ [ABANDONED_WORKSPACE_FILES_RELEASE_KEY]: marker })}::jsonb`,
    }).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.providerLeaseId, providerLeaseId),
      eq(environmentLeases.status, "retained"), sql`${environmentLeases.metadata} ? ${ABANDONED_WORKSPACE_FILES_PARKED_KEY}`,
      sql`not ${abandonedWorkspaceFilesHeldOnLeaseRowSql()}`, reusableSandboxNotKeptAfterReplacementSql())).returning({ id: environmentLeases.id }),
    { companyId: input.companyId });
    const scheduled = unparked.length > 0;
    const summary = input.reason === "retention_expired"
      ? `Unsaved files from an interrupted run were kept for ${days(keptDays)}, and their retention period has ended.${scheduled ? " They are scheduled for removal." : ""}`
      : input.reason === "discarded"
        ? `Unsaved files from an interrupted run were discarded.${scheduled ? " They are scheduled for removal." : ""}`
        : "Unsaved files from an interrupted run were saved to the task's recovered files.";
    logger.info({ companyId: input.companyId, workspaceId: workspace.id, abandonedEpoch: input.epoch, reason: input.reason,
      actorType: input.actorType, actorId: input.actorId, leasesHandedToCleanup: unparked.length, issueId, runId: runId ?? null,
      summary }, "abandoned workspace files released");
    if (issueId) await logActivity(tx, { companyId: input.companyId, actorType: input.actorType, actorId: input.actorId,
      action: "workspace.abandoned_files_released", entityType: "issue", entityId: issueId, runId,
      details: { summary, reason: input.reason, workspaceId: workspace.id, abandonedEpoch: input.epoch,
        retainUntil: new Date(receiptRetainUntil(target)).toISOString(), leasesHandedToCleanup: unparked.length } });
    return true;
  });
}

export async function expireAbandonedWorkspaceFileHolds(db: Db, now = new Date()): Promise<{ expired: number }> {
  const rows = await db.select({ id: executionWorkspaces.id, companyId: executionWorkspaces.companyId,
    receipts: sql<unknown>`${executionWorkspaces.metadata}->'remoteWorkspaceAbandonedEpochs'` }).from(executionWorkspaces)
    .where(sql`jsonb_typeof(${executionWorkspaces.metadata}->'remoteWorkspaceAbandonedEpochs') = 'array'
      and exists (select 1 from jsonb_array_elements(${executionWorkspaces.metadata}->'remoteWorkspaceAbandonedEpochs') receipt
        where receipt->>'schema' = ${REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA}
          and coalesce(jsonb_typeof(receipt->'released'), 'null') = 'null')`);
  let expired = 0;
  let failed = 0;
  const held = new Map<string, number>();
  for (const row of rows) {
    for (const receipt of Array.isArray(row.receipts) ? row.receipts : []) {
      if (!unreleased(receipt)) continue;
      if (receiptDueAt(receipt) > now.getTime() || typeof receipt.epoch !== "number") {
        held.set(row.companyId, (held.get(row.companyId) ?? 0) + 1);
        continue;
      }
      try {
        if (await releaseAbandonedWorkspaceFiles(db, { companyId: row.companyId, workspaceId: row.id, epoch: receipt.epoch,
          reason: "retention_expired", actorType: "system", actorId: "workspace-retention", now })) expired += 1;
      } catch (error) {
        failed += 1;
        const retryAt = await deferAbandonedWorkspaceFilesExpiry(db, row.companyId, row.id, receipt, now);
        logger.warn({ err: error, companyId: row.companyId, workspaceId: row.id, abandonedEpoch: receipt.epoch, retryAt },
          "abandoned workspace file expiry failed; it retries later");
      }
    }
  }
  if (expired > 0 || failed > 0 || held.size > 0) {
    const parked = await db.select({ companyId: environmentLeases.companyId, count: sql<number>`count(*)::int` })
      .from(environmentLeases).where(sql`${environmentLeases.metadata} ? ${ABANDONED_WORKSPACE_FILES_PARKED_KEY}`)
      .groupBy(environmentLeases.companyId);
    logger.info({ expired, failed, retentionDays: ABANDONED_WORKSPACE_FILES_RETENTION_DAYS,
      heldReceiptsByCompany: Object.fromEntries(held), parkedLeasesByCompany: Object.fromEntries(parked.map(p => [p.companyId, p.count])) },
    "abandoned workspace file holds checked");
  }
  return { expired };
}

async function deferAbandonedWorkspaceFilesExpiry(db: Db, companyId: string, workspaceId: string, receipt: Receipt, now: Date) {
  const attempts = (typeof receipt.expiryAttempts === "number" ? receipt.expiryAttempts : 0) + 1;
  const retryAt = new Date(now.getTime() + Math.min(ABANDONED_WORKSPACE_FILES_EXPIRY_MAX_BACKOFF_MS,
    ABANDONED_WORKSPACE_FILES_EXPIRY_BACKOFF_MS * 2 ** (attempts - 1))).toISOString();
  try {
    await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, workspaceId))).for("update");
      const receipts = Array.isArray(workspace?.metadata?.remoteWorkspaceAbandonedEpochs)
        ? workspace!.metadata!.remoteWorkspaceAbandonedEpochs as unknown[] : [];
      if (!workspace) return;
      await tx.update(executionWorkspaces).set({ metadata: { ...workspace.metadata,
        remoteWorkspaceAbandonedEpochs: receipts.map(value => unreleased(value) && value.epoch === receipt.epoch
          && value.location?.providerLeaseId === receipt.location?.providerLeaseId
          ? { ...value, expiryAttempts: attempts, expiryRetryAt: retryAt } : value) } })
        .where(and(eq(executionWorkspaces.companyId, companyId), eq(executionWorkspaces.id, workspaceId)));
    });
  } catch (error) {
    logger.warn({ err: error, companyId, workspaceId }, "abandoned workspace file expiry retry could not be recorded");
  }
  return retryAt;
}

function receiptExpirySql() {
  return sql`coalesce(case when receipt->>'retainUntil' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (receipt->>'retainUntil')::timestamptz end,
    case when receipt->>'abandonedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
      then (receipt->>'abandonedAt')::timestamptz + ${`${ABANDONED_WORKSPACE_FILES_RETENTION_DAYS} days`}::interval end,
    'epoch'::timestamptz)`;
}

function receiptDueSql() {
  return sql`greatest(${receiptExpirySql()},
    case when receipt->>'expiryRetryAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (receipt->>'expiryRetryAt')::timestamptz
      else 'epoch'::timestamptz end)`;
}

export async function nextAbandonedWorkspaceFileHoldExpiryAt(db: Pick<Db, "execute">): Promise<number | null> {
  const [row] = await db.execute<{ next: string | Date | null }>(sql`select min(${receiptDueSql()}) as next
    from execution_workspaces workspace
    cross join lateral jsonb_array_elements(case when jsonb_typeof(workspace.metadata->'remoteWorkspaceAbandonedEpochs') = 'array'
      then workspace.metadata->'remoteWorkspaceAbandonedEpochs' else '[]'::jsonb end) receipt
    where workspace.metadata ? 'remoteWorkspaceAbandonedEpochs'
      and receipt->>'schema' = ${REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA}
      and jsonb_typeof(receipt->'location'->'providerLeaseId') = 'string'
      and coalesce(jsonb_typeof(receipt->'released'), 'null') = 'null'`);
  return row?.next ? new Date(row.next).getTime() : null;
}

export async function expireAbandonedWorkspaceFileHoldsWhenDue(db: Db, now = new Date()): Promise<{ expired: number }> {
  const next = await nextAbandonedWorkspaceFileHoldExpiryAt(db);
  if (next === null || next > now.getTime()) return { expired: 0 };
  return await expireAbandonedWorkspaceFileHolds(db, now);
}

export async function recordAbandonedWorkspaceFilesRemoved(db: Db, lease: Pick<typeof environmentLeases.$inferSelect,
  "id" | "companyId" | "metadata">): Promise<void> {
  const marker = lease.metadata?.[ABANDONED_WORKSPACE_FILES_RELEASE_KEY] as {
    issueId?: string | null; workspaceId?: string; abandonedEpoch?: number; reason?: string; keptDays?: number; runId?: string | null;
  } | undefined;
  if (!marker || (marker.reason !== "retention_expired" && marker.reason !== "discarded")) return;
  const issueId = await existingIssueId(db, lease.companyId, marker.issueId ?? null);
  const runId = await existingRunId(db, lease.companyId, marker.runId);
  const summary = marker.reason === "retention_expired"
    ? `Unsaved files from an interrupted run were kept for ${days(marker.keptDays ?? ABANDONED_WORKSPACE_FILES_RETENTION_DAYS)} and have now been removed.`
    : "Discarded unsaved files from an interrupted run have now been removed.";
  logger.info({ companyId: lease.companyId, leaseId: lease.id, workspaceId: marker.workspaceId, issueId, summary },
    "abandoned workspace files removed");
  if (!issueId) return;
  await logActivity(db, { companyId: lease.companyId, actorType: "system", actorId: "workspace-retention",
    action: "workspace.abandoned_files_removed", entityType: "issue", entityId: issueId, runId,
    details: { summary, reason: marker.reason, workspaceId: marker.workspaceId, abandonedEpoch: marker.abandonedEpoch, leaseId: lease.id } });
}
