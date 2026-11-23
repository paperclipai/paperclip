import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { activityLog, assets, runnerApiResponseReservations, type Db } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { logger } from "../../middleware/logger.js";
import { incrementToolRuntimeMetricCounter } from "../tool-runtime-metrics.js";
import { RUNNER_API_RESPONSE_DEADLINE_MS } from "./runner-api-response-limits.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
export const CAPTURE_EVICTION_MIN_AGE_MS = 60 * 60_000;
export const RUNNER_API_CAPTURE_EVICTION_PASSES = 2;
export const RUNNER_API_CAPTURE_RETENTION_ACTOR = "api-response-retention";
const EVICTION_PAGE_SIZE = 200;
const PENDING_DELETE_BATCH_SIZE = 50;
export const STALE_CAPTURE_RESERVATION_MS = 2 * RUNNER_API_RESPONSE_DEADLINE_MS;
export const CAPTURE_EVICTION_DELETE_TIMEOUT_MS = 30_000;
export const CAPTURE_CLEANUP_STALLED_MS = 5 * 60_000;
export const RUNNER_API_CAPTURE_DELETE_FAILURE_METRIC = "runner_api_capture_delete_failed";

function activeRunStatusList() {
  return sql.join(ACTIVE_RUN_STATUSES.map(status => sql`${status}`), sql`, `);
}

function terminalRunStatusList() {
  return sql.join(TERMINAL_RUN_STATUSES.map(status => sql`${status}`), sql`, `);
}

export async function runnerApiCaptureUsageBytes(tx: Db, companyId: string): Promise<number> {
  const [row] = await tx.execute<{ bytes: string | number }>(sql`select
    coalesce((select sum(${assets.byteSize}) from ${assets}
      where ${assets.companyId} = ${companyId}
        and (${assets.objectKey} like ${`${companyId}/runner-api/%`}
          or exists (select 1 from ${runnerApiResponseReservations} capture
            where capture.asset_id = ${assets.id} and capture.company_id = ${companyId}))), 0)
    + coalesce((select sum(${runnerApiResponseReservations.reservedBytes}) from ${runnerApiResponseReservations}
      where ${runnerApiResponseReservations.companyId} = ${companyId}
        and ${runnerApiResponseReservations.assetId} is null), 0) as bytes`);
  return Number(row?.bytes ?? 0);
}

export async function markRunnerApiCaptureEvictions(tx: Db, companyId: string, neededBytes: number, now = new Date()) {
  const released = await tx.delete(runnerApiResponseReservations).where(and(
    eq(runnerApiResponseReservations.companyId, companyId),
    isNull(runnerApiResponseReservations.assetId),
    isNull(runnerApiResponseReservations.pendingDeleteObjectKey),
    lt(runnerApiResponseReservations.createdAt, new Date(now.getTime() - STALE_CAPTURE_RESERVATION_MS)),
    sql`not exists (select 1 from heartbeat_runs run where run.id = ${runnerApiResponseReservations.runId}
      and run.status in (${activeRunStatusList()}))`,
  )).returning({ bytes: runnerApiResponseReservations.reservedBytes });
  let reclaimedBytes = released.reduce((sum, row) => sum + row.bytes, 0);
  const [pending] = await tx.select({ bytes: sql<string>`coalesce(sum(${runnerApiResponseReservations.reservedBytes}), 0)` })
    .from(runnerApiResponseReservations).where(and(
      eq(runnerApiResponseReservations.companyId, companyId), isNotNull(runnerApiResponseReservations.pendingDeleteObjectKey),
    ));
  let pendingBytes = Number(pending?.bytes ?? 0);
  while (reclaimedBytes + pendingBytes < neededBytes) {
    const candidates = await tx.select({ id: assets.id, objectKey: assets.objectKey, byteSize: assets.byteSize,
      runId: sql<string | null>`(select capture.run_id from runner_api_response_reservations capture
        where capture.asset_id = "assets"."id" and capture.run_id is not null limit 1)` }).from(assets).where(and(
      eq(assets.companyId, companyId),
      lt(assets.createdAt, new Date(now.getTime() - CAPTURE_EVICTION_MIN_AGE_MS)),
      sql`(${assets.objectKey} like ${`${companyId}/runner-api/%`}
        or exists (select 1 from runner_api_response_reservations capture
          where capture.asset_id = ${assets.id} and capture.company_id = ${companyId}))`,
      sql`not exists (select 1 from runner_api_response_reservations capture
        join heartbeat_runs run on run.id = capture.run_id
        where capture.asset_id = ${assets.id} and run.status not in (${terminalRunStatusList()}))`,
      sql`not exists (select 1 from issue_attachments link where link.asset_id = ${assets.id})`,
      sql`not exists (select 1 from case_attachments link where link.asset_id = ${assets.id})`,
      sql`not exists (select 1 from company_logos link where link.asset_id = ${assets.id})`,
    )).orderBy(asc(assets.createdAt), asc(assets.id)).limit(EVICTION_PAGE_SIZE);
    const chosen: typeof candidates = [];
    for (const candidate of candidates) {
      if (reclaimedBytes + pendingBytes >= neededBytes) break;
      chosen.push(candidate);
      pendingBytes += candidate.byteSize;
    }
    if (chosen.length) {
      await tx.delete(assets).where(and(eq(assets.companyId, companyId), inArray(assets.id, chosen.map(candidate => candidate.id))));
      await tx.insert(runnerApiResponseReservations).values(chosen.map(candidate => ({
        companyId, runId: null, assetId: null, reservedBytes: candidate.byteSize, pendingDeleteObjectKey: candidate.objectKey,
      })));
      await tx.insert(activityLog).values(chosen.map(candidate => ({
        companyId, actorType: "system", actorId: RUNNER_API_CAPTURE_RETENTION_ACTOR, action: "asset.evicted",
        entityType: "asset", entityId: candidate.id, runId: candidate.runId,
        details: { source: "runner.call_api", reason: "company_capture_storage_full", byteSize: candidate.byteSize, runId: candidate.runId },
      })));
    }
    if (candidates.length < EVICTION_PAGE_SIZE) break;
  }
  return { releasedBytes: reclaimedBytes, pendingBytes };
}

export async function finishPendingRunnerApiCaptureDeletes(db: Db, storage: StorageService, companyId: string,
  timeoutMs = CAPTURE_EVICTION_DELETE_TIMEOUT_MS) {
  const signal = AbortSignal.timeout(timeoutMs);
  let deletedCount = 0;
  let failedCount = 0;
  let after: string | undefined;
  while (!signal.aborted) {
    const pending = await db.select({ id: runnerApiResponseReservations.id, objectKey: runnerApiResponseReservations.pendingDeleteObjectKey })
      .from(runnerApiResponseReservations).where(and(
        eq(runnerApiResponseReservations.companyId, companyId), isNotNull(runnerApiResponseReservations.pendingDeleteObjectKey),
        after ? gt(runnerApiResponseReservations.id, after) : undefined,
      )).orderBy(asc(runnerApiResponseReservations.id)).limit(PENDING_DELETE_BATCH_SIZE);
    if (!pending.length) break;
    after = pending[pending.length - 1].id;
    const results = await Promise.all(pending.map(row => storage.deleteObject(companyId, row.objectKey!, { signal, allVersions: true })
      .then(() => ({ id: row.id, error: null as unknown }), (error: unknown) => ({ id: row.id, error }))));
    const deleted = results.filter(result => result.error === null).map(result => result.id);
    const failures = results.filter(result => result.error !== null);
    if (failures.length) {
      failedCount += failures.length;
      logger.warn({ companyId, failedDeletes: failures.length, err: failures[0].error },
        "Failed to delete evicted API response snapshots; they stay counted and will be retried");
      await Promise.all(failures.map(() => incrementToolRuntimeMetricCounter(db, { companyId, metric: RUNNER_API_CAPTURE_DELETE_FAILURE_METRIC })
        .catch(() => undefined)));
    }
    if (deleted.length) {
      await db.delete(runnerApiResponseReservations).where(and(
        eq(runnerApiResponseReservations.companyId, companyId), inArray(runnerApiResponseReservations.id, deleted),
      ));
      deletedCount += deleted.length;
    }
    if (pending.length < PENDING_DELETE_BATCH_SIZE) break;
  }
  return { deleted: deletedCount, failed: failedCount };
}

export async function runnerApiCaptureCleanupStalled(db: Db, companyId: string, now = new Date()) {
  const [row] = await db.select({ id: runnerApiResponseReservations.id }).from(runnerApiResponseReservations).where(and(
    eq(runnerApiResponseReservations.companyId, companyId), isNotNull(runnerApiResponseReservations.pendingDeleteObjectKey),
    lt(runnerApiResponseReservations.createdAt, new Date(now.getTime() - CAPTURE_CLEANUP_STALLED_MS)),
  )).limit(1);
  return Boolean(row);
}
