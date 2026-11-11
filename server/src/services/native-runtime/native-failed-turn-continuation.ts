import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db, type heartbeatRuns } from "@paperclipai/db";
import { NATIVE_RUN_FAILED_RETRY_CAUSE } from "./status-arbiter.js";

/**
 * True when this run was dispatched from the committer's `schedule_retry` wake
 * for an earlier failed turn. The intent id is set by the native-status wake
 * dispatcher, and the intent row itself proves the retry cause, so provider
 * output or a copied context cannot claim or hide the used continuation.
 */
export async function isFailedTurnContinuationRun(
  db: Pick<Db, "select">,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "contextSnapshot" | "wakeupRequestId">,
  issueId: string,
): Promise<boolean> {
  const intentId = run.contextSnapshot?.nativeStatusWakeIntentId;
  if (typeof intentId !== "string" || !/^[0-9a-f-]{36}$/i.test(intentId) || !run.wakeupRequestId) return false;
  // The run's own dispatch receipt must be the one the dispatcher created for
  // this intent, so a copied intent id on another run proves nothing.
  const [dispatch] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.runId, run.id),
    eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${intentId}`),
  )).limit(1);
  if (!dispatch) return false;
  const [intent] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.id, intentId),
    eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    sql`${agentWakeupRequests.payload}->>'retryCause' = ${NATIVE_RUN_FAILED_RETRY_CAUSE}`,
  )).limit(1);
  return Boolean(intent);
}
