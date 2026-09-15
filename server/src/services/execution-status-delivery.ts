import { and, eq, isNotNull, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
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
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      issueId: issues.id,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      executionStatusDeliveryId: heartbeatRuns.executionStatusDeliveryId,
    })
    .from(heartbeatRuns)
    // Match terminalization's native-first association, but expose only an
    // existing same-company canonical task ID. Compare text so malformed
    // context values cannot cause a UUID cast error or escape onto the wire.
    .leftJoin(
      issues,
      and(
        eq(issues.companyId, heartbeatRuns.companyId),
        sql`${issues.id}::text = coalesce(
        ${heartbeatRuns.nativeIssueId}::text,
        case when jsonb_typeof(${heartbeatRuns.contextSnapshot} -> 'issueId') = 'string'
          then ${heartbeatRuns.contextSnapshot} ->> 'issueId' end
      )`,
      ),
    )
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
          runId: run.id,
          agentId: run.agentId,
          issueId: run.issueId,
          status: run.status,
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
