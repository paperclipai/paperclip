import { and, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, type heartbeatRuns, type Db } from "@paperclipai/db";
import { validatePrpEvent } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";

export const NATIVE_TOOL_RECEIPT_LIMIT_CODE = "semantic_tool_turn_receipt_limit";
export const NATIVE_TOOL_RECEIPT_LIMIT_MAX_CONTINUATIONS = 2;
export const NATIVE_TOOL_RECEIPT_LIMIT_CONTINUATION_DELAY_MS = 5_000;
export const NATIVE_TOOL_RECEIPT_LIMIT_MESSAGE = "The agent's turn held too many tool results at once. Paperclip continues the task in a fresh session.";
export const NATIVE_TOOL_RECEIPT_LIMIT_HINT = "The previous turn stopped because it held too many tool results at once. "
  + "Continue the task from its saved work. Make fewer tool calls in parallel, and do not re-read data you already have.";

export async function readPersistedNativeToolReceiptLimitStop(
  db: Pick<Db, "select">,
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "runtimeMode" | "runnerInstanceId">,
): Promise<boolean> {
  if (run.runtimeMode !== "native" || !run.runnerInstanceId) return false;
  const rows = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.sourceInstanceId, run.runnerInstanceId), eq(heartbeatRunEvents.eventType, "harness.diagnostic"),
    sql`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'code' = ${NATIVE_TOOL_RECEIPT_LIMIT_CODE}`,
  )).limit(4);
  return rows.some(row => {
    const prpEvent = (row.payload as Record<string, unknown> | null)?.prpEvent;
    const parsed = validatePrpEvent(prpEvent);
    return parsed.ok && parsed.event.runId === run.id && parsed.event.sourceKind === "runner"
      && parsed.event.sourceInstanceId === run.runnerInstanceId && parsed.event.eventType === row.eventType
      && parsed.event.sourceEventId === row.sourceEventId && parsed.event.sourceSeq === row.sourceSeq
      && row.sourcePayloadSha256 === nativeSha256(parsed.event);
  });
}
