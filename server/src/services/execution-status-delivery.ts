import { and, eq, isNotNull } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { publishLiveEvent } from "./live-events.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "./heartbeat-run-status-payload.js";
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
    .select()
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
          ...buildHeartbeatRunStatusLiveEventPayload(run),
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
