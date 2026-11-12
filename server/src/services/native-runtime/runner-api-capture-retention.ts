import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { assets, runnerApiResponseReservations, type Db } from "@paperclipai/db";
import { RUNNER_API_RESPONSE_DEADLINE_MS } from "./runner-api-response-limits.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const EVICTION_PAGE_SIZE = 200;
export const STALE_CAPTURE_RESERVATION_MS = 2 * RUNNER_API_RESPONSE_DEADLINE_MS;

function activeRunStatusList() {
  return sql.join(ACTIVE_RUN_STATUSES.map(status => sql`${status}`), sql`, `);
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

export async function reclaimRunnerApiCaptureStorage(tx: Db, companyId: string, neededBytes: number, now = new Date()) {
  const evictedObjectKeys: string[] = [];
  const released = await tx.delete(runnerApiResponseReservations).where(and(
    eq(runnerApiResponseReservations.companyId, companyId),
    isNull(runnerApiResponseReservations.assetId),
    lt(runnerApiResponseReservations.createdAt, new Date(now.getTime() - STALE_CAPTURE_RESERVATION_MS)),
    sql`not exists (select 1 from heartbeat_runs run where run.id = ${runnerApiResponseReservations.runId}
      and run.status in (${activeRunStatusList()}))`,
  )).returning({ bytes: runnerApiResponseReservations.reservedBytes });
  let reclaimedBytes = released.reduce((sum, row) => sum + row.bytes, 0);
  while (reclaimedBytes < neededBytes) {
    const candidates = await tx.select({ id: assets.id, objectKey: assets.objectKey, byteSize: assets.byteSize }).from(assets).where(and(
      eq(assets.companyId, companyId),
      sql`(${assets.objectKey} like ${`${companyId}/runner-api/%`}
        or exists (select 1 from runner_api_response_reservations capture
          where capture.asset_id = ${assets.id} and capture.company_id = ${companyId}))`,
      sql`not exists (select 1 from runner_api_response_reservations capture
        join heartbeat_runs run on run.id = capture.run_id
        where capture.asset_id = ${assets.id} and run.status in (${activeRunStatusList()}))`,
      sql`not exists (select 1 from issue_attachments link where link.asset_id = ${assets.id})`,
      sql`not exists (select 1 from case_attachments link where link.asset_id = ${assets.id})`,
      sql`not exists (select 1 from company_logos link where link.asset_id = ${assets.id})`,
    )).orderBy(asc(assets.createdAt), asc(assets.id)).limit(EVICTION_PAGE_SIZE);
    const chosen: typeof candidates = [];
    for (const candidate of candidates) {
      if (reclaimedBytes >= neededBytes) break;
      chosen.push(candidate);
      reclaimedBytes += candidate.byteSize;
    }
    if (chosen.length) {
      await tx.delete(assets).where(and(eq(assets.companyId, companyId), inArray(assets.id, chosen.map(candidate => candidate.id))));
      evictedObjectKeys.push(...chosen.map(candidate => candidate.objectKey));
    }
    if (candidates.length < EVICTION_PAGE_SIZE) break;
  }
  return { reclaimedBytes, releasedReservations: released.length, evictedObjectKeys };
}
