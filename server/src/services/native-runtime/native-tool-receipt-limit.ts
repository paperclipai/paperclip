import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, type heartbeatRuns, type Db } from "@paperclipai/db";
import { validatePrpEvent } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { readRunCancellation } from "../run-cancellation.js";

export const NATIVE_TOOL_RECEIPT_LIMIT_CODE = "semantic_tool_turn_receipt_limit";
export const NATIVE_TOOL_RECEIPT_LIMIT_MAX_CONTINUATIONS = 2;
export const NATIVE_TOOL_RECEIPT_LIMIT_CONTINUATION_DELAY_MS = 5_000;
export const NATIVE_TOOL_RECEIPT_LIMIT_MESSAGE = "The agent's turn held too many tool results at once. Paperclip continues the task in a fresh session.";
export const NATIVE_TOOL_RECEIPT_LIMIT_HINT = "The previous turn stopped because it held too many tool results at once. "
  + "Continue the task from its saved work. Make fewer tool calls in parallel, and do not re-read data you already have.";

export function nativeRunHasStopRequest(resultJson: Record<string, unknown> | null | undefined): boolean {
  if (!resultJson) return false;
  const cancellation = readRunCancellation(resultJson);
  return Boolean(resultJson.nativeCancellation || resultJson.executionCancellation || resultJson.cancelledByActorType
    || resultJson.cancelledByUserId || resultJson.interruptedByActorType || resultJson.queuedCommentInterruptQueueId
    || resultJson.issueMutationStopId || resultJson.operatorInterrupted === true
    || (cancellation && cancellation.initiator.type !== "system" && cancellation.initiator.type !== "provider"));
}

export async function cancelStoppedRunContinuation(
  db: Pick<Db, "update">,
  run: Pick<typeof heartbeatRuns.$inferSelect, "companyId" | "resultJson">,
  idempotencyKey: string,
): Promise<number> {
  if (!nativeRunHasStopRequest(run.resultJson)) return 0;
  const now = new Date();
  const cancelled = await db.update(agentWakeupRequests).set({
    status: "cancelled", finishedAt: now, updatedAt: now, error: "The run that asked for this continuation was stopped",
  }).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
    inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]), isNull(agentWakeupRequests.runId),
  )).returning({ id: agentWakeupRequests.id });
  return cancelled.length;
}

export async function readPersistedNativeToolReceiptLimitStop(
  db: Pick<Db, "select">,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "runtimeMode" | "runnerInstanceId" | "nativeSessionId">,
  turnId: string | null,
): Promise<boolean> {
  if (run.runtimeMode !== "native" || !run.runnerInstanceId || !run.nativeSessionId || !turnId) return false;
  const rows = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.sourceInstanceId, run.runnerInstanceId), eq(heartbeatRunEvents.eventType, "harness.diagnostic"),
    sql`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'code' = ${NATIVE_TOOL_RECEIPT_LIMIT_CODE}`,
    sql`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId' = ${turnId}`,
  )).limit(4);
  return rows.some(row => {
    const prpEvent = (row.payload as Record<string, unknown> | null)?.prpEvent;
    const parsed = validatePrpEvent(prpEvent);
    return parsed.ok && parsed.event.runId === run.id && parsed.event.sourceKind === "runner"
      && parsed.event.turnId === turnId && parsed.event.normalizedSessionId === run.nativeSessionId
      && parsed.event.sourceInstanceId === run.runnerInstanceId && parsed.event.eventType === row.eventType
      && parsed.event.sourceEventId === row.sourceEventId && parsed.event.sourceSeq === row.sourceSeq
      && row.sourcePayloadSha256 === nativeSha256(parsed.event);
  });
}
