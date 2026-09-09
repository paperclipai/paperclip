import { and, eq, isNotNull } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { publishLiveEvent } from "./live-events.js";
import { logger } from "../middleware/logger.js";

/** Status delivery is at-least-once; clients invalidate by run id. It grants no execution authority. */
export async function deliverExecutionStatuses(
  db: Db,
  options: {
    publish?: typeof publishLiveEvent;
    failpoint?: (phase: "published") => void;
  } = {},
) {
  const rows = await db
    .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
      executionStatusDeliveryId: heartbeatRuns.executionStatusDeliveryId })
    .from(heartbeatRuns)
    .where(isNotNull(heartbeatRuns.executionStatusDeliveryId))
    .limit(100);
  let delivered = 0;
  for (const run of rows) {
    try {
      (options.publish ?? publishLiveEvent)({
        companyId: run.companyId,
        type: "heartbeat.run.status",
        payload: {
          // This retryable broadcast only invalidates caches. Provider output,
          // errors, and tool results stay behind the run API's access/redaction policy.
          runId: run.id, agentId: run.agentId, status: run.status,
          startedAt: run.startedAt?.toISOString() ?? null,
          finishedAt: run.finishedAt?.toISOString() ?? null,
          deliveryId: run.executionStatusDeliveryId,
        },
      });
      options.failpoint?.("published");
      await db
        .update(heartbeatRuns)
        .set({ executionStatusDeliveryId: null })
        .where(
          and(
            eq(heartbeatRuns.companyId, run.companyId),
            eq(heartbeatRuns.id, run.id),
            eq(
              heartbeatRuns.executionStatusDeliveryId,
              run.executionStatusDeliveryId!,
            ),
          ),
        );
      delivered += 1;
    } catch (error) {
      if (options.failpoint) throw error;
      logger.warn(
        { runId: run.id },
        "Execution status delivery remains pending",
      );
    }
  }
  return { scanned: rows.length, delivered };
}
