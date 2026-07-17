import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companies } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const ACTIVITY_LOG_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
const DELETE_BATCH_SIZE = 1_000;
const MAX_BATCHES_PER_COMPANY = 100;
const DAY_MS = 24 * 60 * 60 * 1_000;

export async function pruneActivityLog(db: Db, now = new Date()): Promise<number> {
  const retentionPolicies = await db
    .select({
      companyId: companies.id,
      retentionDays: companies.activityLogRetentionDays,
    })
    .from(companies)
    .where(isNotNull(companies.activityLogRetentionDays));

  let totalDeleted = 0;
  for (const policy of retentionPolicies) {
    if (
      policy.retentionDays === null
      || !Number.isInteger(policy.retentionDays)
      || policy.retentionDays < 1
      || policy.retentionDays > 36_500
    ) {
      logger.warn(
        { companyId: policy.companyId, retentionDays: policy.retentionDays },
        "Skipping invalid activity log retention policy",
      );
      continue;
    }
    const cutoff = new Date(now.getTime() - policy.retentionDays * DAY_MS);
    let batches = 0;
    let companyDeleted = 0;

    while (batches < MAX_BATCHES_PER_COMPANY) {
      const expiredIds = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(
          eq(activityLog.companyId, policy.companyId),
          lt(activityLog.createdAt, cutoff),
        ))
        .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
        .limit(DELETE_BATCH_SIZE)
        .then((rows) => rows.map((row) => row.id));

      if (expiredIds.length === 0) break;

      const deleted = await db
        .delete(activityLog)
        .where(and(
          eq(activityLog.companyId, policy.companyId),
          inArray(activityLog.id, expiredIds),
        ))
        .returning({ id: activityLog.id });

      companyDeleted += deleted.length;
      totalDeleted += deleted.length;
      batches += 1;
      if (expiredIds.length < DELETE_BATCH_SIZE) break;
    }

    if (batches >= MAX_BATCHES_PER_COMPANY) {
      logger.warn(
        { companyId: policy.companyId, retentionDays: policy.retentionDays, companyDeleted },
        "Activity log retention hit the per-company batch limit",
      );
    } else if (companyDeleted > 0) {
      logger.info(
        { companyId: policy.companyId, retentionDays: policy.retentionDays, companyDeleted },
        "Pruned expired activity log rows",
      );
    }
  }

  return totalDeleted;
}

export function startActivityLogRetention(
  db: Db,
  intervalMs: number = ACTIVITY_LOG_RETENTION_INTERVAL_MS,
): () => void {
  let stopped = false;
  let sweepInFlight: Promise<void> | null = null;

  const runSweep = () => {
    if (stopped || sweepInFlight) return;
    sweepInFlight = pruneActivityLog(db)
      .then(() => undefined)
      .catch((err) => {
        logger.warn({ err }, "Activity log retention sweep failed");
      })
      .finally(() => {
        sweepInFlight = null;
      });
  };

  runSweep();
  const timer = setInterval(runSweep, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
