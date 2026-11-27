import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { notifyScheduledRetryCancellation } from "../../../services/scheduled-retry-cancellation-notifications.js";

export async function parkScheduledRetryInTx(tx: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId">,
  now: Date, recheckAt: Date): Promise<boolean> {
  await notifyScheduledRetryCancellation(tx, { companyId: run.companyId, runId: run.id });
  const [parked] = await tx.update(heartbeatRuns).set({
    scheduledRetryAt: recheckAt,
    updatedAt: now,
    contextSnapshot: sql`jsonb_set(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb), '{scheduledRetryAt}', to_jsonb(${recheckAt.toISOString()}::text))`,
  }).where(and(
    eq(heartbeatRuns.id, run.id),
    eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "scheduled_retry"),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(parked);
}
