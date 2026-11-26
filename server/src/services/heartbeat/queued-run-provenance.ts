import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { AGENT_TOOL_CALL_LOOP } from "../native-runtime/repeated-tool-failure-guard.js";
import { ISSUE_CONTINUATION_NEEDED_WAKE_REASON } from "./queued-run-dispatch-order.js";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLEAN_CONTINUATION_CAUSES: ReadonlySet<string> = new Set([AGENT_TOOL_CALL_LOOP]);

export const QUEUED_RUN_ORDER_CONTEXT_KEYS = [
  "issueId", "wakeReason", "previousRunId", "retryOfRunId", "retryReason",
  "livenessContinuationReason", "livenessContinuationSourceRunId",
] as const;

const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 ? value : null;

export function cleanContinuationSourceRunId(run: { retryOfRunId: string | null; contextSnapshot: unknown }) {
  const context = parseObject(run.contextSnapshot);
  const cause = text(context.livenessContinuationReason);
  if (context.wakeReason !== ISSUE_CONTINUATION_NEEDED_WAKE_REASON || !cause || !CLEAN_CONTINUATION_CAUSES.has(cause)) return null;
  if (run.retryOfRunId || context.retryOfRunId || context.retryReason || context.previousRunId) return null;
  const sourceRunId = text(context.livenessContinuationSourceRunId);
  return sourceRunId && RUN_ID_PATTERN.test(sourceRunId) ? sourceRunId.toLowerCase() : null;
}

export async function listCleanContinuationSourceRunIds(db: Db, companyId: string, sourceRunIds: string[]) {
  if (!sourceRunIds.length) return new Set<string>();
  const rows = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
    cause: sql<string | null>`${heartbeatRuns.contextSnapshot}->>'livenessContinuationReason'` })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, sourceRunIds)));
  return new Set(rows.filter(row => row.status === "succeeded" && !(row.cause && CLEAN_CONTINUATION_CAUSES.has(row.cause)))
    .map(row => row.id));
}
