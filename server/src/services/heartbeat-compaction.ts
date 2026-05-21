import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, instanceRetentionConfig } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const DEFAULT_SUCCEEDED_RETENTION_HOURS = 72;
const COMPACTION_BATCH_SIZE = 100;
const MAX_COMPACTION_BATCHES = 500;

interface RetentionConfig {
  succeededRunRetentionHours: number;
  failedRunRetentionHours: number;
}

export async function getRetentionConfig(db: Db): Promise<RetentionConfig> {
  const rows = await db
    .select({
      succeededRunRetentionHours: instanceRetentionConfig.succeededRunRetentionHours,
      failedRunRetentionHours: instanceRetentionConfig.failedRunRetentionHours,
    })
    .from(instanceRetentionConfig)
    .where(isNull(instanceRetentionConfig.companyId))
    .limit(1);

  if (rows.length > 0) {
    return rows[0];
  }
  return {
    succeededRunRetentionHours: DEFAULT_SUCCEEDED_RETENTION_HOURS,
    failedRunRetentionHours: 168,
  };
}

export async function compactHeartbeatRuns(db: Db): Promise<number> {
  const config = await getRetentionConfig(db);

  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - config.succeededRunRetentionHours);

  let totalCompacted = 0;
  let iterations = 0;

  while (iterations < MAX_COMPACTION_BATCHES) {
    const targets = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.status, "succeeded"),
          lt(heartbeatRuns.finishedAt, cutoff),
          isNull(heartbeatRuns.compactedAt),
        ),
      )
      .limit(COMPACTION_BATCH_SIZE);

    if (targets.length === 0) break;

    const ids = targets.map((r) => r.id);
    const now = new Date();

    await db
      .update(heartbeatRuns)
      .set({
        resultJson: null,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        contextSnapshot: null,
        compactedAt: now,
        updatedAt: now,
      })
      .where(inArray(heartbeatRuns.id, ids));

    totalCompacted += ids.length;
    iterations++;

    if (targets.length < COMPACTION_BATCH_SIZE) break;
  }

  if (iterations >= MAX_COMPACTION_BATCHES) {
    logger.warn(
      { totalCompacted, iterations, cutoffDate: cutoff },
      "Heartbeat compaction hit iteration limit; some runs may remain uncompacted",
    );
  }

  // Null out adapter.invoke event payloads for compacted runs
  await db.execute(sql`
    UPDATE heartbeat_run_events hre
    SET payload = NULL
    FROM heartbeat_runs hr
    WHERE hre.run_id = hr.id
      AND hre.event_type = 'adapter.invoke'
      AND hr.compacted_at IS NOT NULL
      AND hre.payload IS NOT NULL
  `).catch((err) => {
    logger.warn({ err }, "Failed to compact adapter.invoke event payloads");
  });

  if (totalCompacted > 0) {
    logger.info(
      { totalCompacted, retentionHours: config.succeededRunRetentionHours },
      "Compacted heartbeat runs",
    );
  }

  return totalCompacted;
}

export function startHeartbeatCompaction(
  db: Db,
  intervalMs: number = 60 * 60 * 1_000,
): () => void {
  const runSweep = () => {
    compactHeartbeatRuns(db).catch((err) => {
      logger.warn({ err }, "Heartbeat compaction sweep failed");
    });
  };

  const timer = setInterval(runSweep, intervalMs);

  // Run once immediately on startup
  runSweep();

  return () => clearInterval(timer);
}
