import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { readTaskRetryIntent } from "../task-retry.js";
import { hasNativeLocalProcessStop, hasHistoricalSuspendedNativeSession, recordedLocalExecutionStopped } from "../native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";

/** This receipt changes the workspace strategy, never the external principal,
 * accepted inbound batch, publication scope, or current conversation access. */
export async function readTaskChatRetryIntent(db: Db, input: {
  companyId: string; issueId: string; agentId: string; sourceRunId: string;
  intentId: string; chatActionId?: string;
}) {
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.intentId),
    eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.reason, "task_retry"),
    eq(agentWakeupRequests.requestedByActorType, "user"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`${agentWakeupRequests.idempotencyKey} like 'task-retry:%'`,
  ));
  const intent = readTaskRetryIntent(wake?.payload);
  return wake && intent && intent.generationId === wake.id && !intent.canonicalIntentId &&
    intent.sourceRunId === input.sourceRunId && intent.actorId === wake.requestedByActorId &&
    (!input.chatActionId || intent.chatActionId === input.chatActionId)
    ? { wake, intent } : null;
}

/** An unusable checkpoint does not prevent an isolated attempt. The old
 * executor must still be contained; a terminal database row is insufficient. */
export async function taskChatRetryExecutionStopped(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  if (adapterExecutionControls.has(run.id) ||
      (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date())) return false;
  const [coordinator] = await db.select().from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).for("share", { noWait: true });
  if (coordinator && (coordinator.leaseOwner || coordinator.resultId || coordinator.failureDetail?.successorRunId ||
      !["terminal_failure", "committed"].includes(coordinator.phase))) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  )).for("share", { noWait: true });
  if (leases.some(lease => lease.provider !== "local")) return leases.every(hasRemoteTerminationReceipt);
  return await recordedLocalExecutionStopped(db, run) ||
    await hasNativeLocalProcessStop(db, run.companyId, run.id) ||
    await hasHistoricalSuspendedNativeSession(db, run);
}
