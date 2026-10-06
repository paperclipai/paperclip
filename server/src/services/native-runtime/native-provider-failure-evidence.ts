import { and, desc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { parseNativeExecutionInput, validatePrpEvent, type PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { createNativeProviderFailureObservation } from "./native-provider-failure.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Re-derive authority from immutable run-bound evidence, including after restart. */
export async function readPersistedNativeModelRejection(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  turnId: string | null,
  terminal: PrpTerminalState,
) {
  if (run.runtimeMode !== "native" || !turnId || !run.nativeSessionId || !run.runnerInstanceId ||
      terminal.turnTerminalState !== "failed" || terminal.runTerminalState !== "failed") return null;
  let execution;
  try { execution = parseNativeExecutionInput(record(run.runnerProfileJson).nativeExecutionInput); } catch { return null; }
  if (execution.provider.kind !== "codex" || !execution.provider.model ||
      execution.binding.runId !== run.id || execution.binding.companyId !== run.companyId ||
      execution.binding.agentId !== run.agentId || execution.binding.issueId !== run.nativeIssueId ||
      execution.session.normalizedSessionId !== run.nativeSessionId ||
      execution.completionContract.id !== run.completionContractId ||
      execution.completionContract.sha256 !== run.completionContractSha256) return null;

  const [row] = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.sourceInstanceId, run.runnerInstanceId), eq(heartbeatRunEvents.eventType, "turn.failed"),
    sql`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId' = ${turnId}`,
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  if (!row) return null;
  const parsed = validatePrpEvent(record(row.payload).prpEvent);
  if (!parsed.ok || parsed.event.runId !== run.id || parsed.event.normalizedSessionId !== run.nativeSessionId ||
      parsed.event.sourceKind !== "runner" || parsed.event.sourceInstanceId !== run.runnerInstanceId ||
      parsed.event.sourceEventId !== row.sourceEventId || parsed.event.sourceSeq !== row.sourceSeq ||
      parsed.event.eventType !== row.eventType || parsed.event.turnId !== turnId ||
      row.sourcePayloadSha256 !== nativeSha256(parsed.event)) return null;
  const observed = createNativeProviderFailureObservation(execution.provider);
  observed.observe(parsed.event);
  return observed.forTerminal(turnId, terminal);
}
