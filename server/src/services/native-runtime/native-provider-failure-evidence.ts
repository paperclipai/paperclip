import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { parseNativeExecutionInput, validatePrpEvent, type PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";
import { createNativeProviderFailureObservation, nativeProviderUsageLimitFromEvent } from "./native-provider-failure.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function observePersistedNativeTurnFailure(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  turnId: string | null,
  terminal: PrpTerminalState,
) {
  if (run.runtimeMode !== "native" || !turnId || !run.nativeSessionId || !run.runnerInstanceId ||
      terminal.turnTerminalState !== "failed" || terminal.runTerminalState !== "failed") return null;
  let execution;
  try { execution = parseNativeExecutionInput(record(run.runnerProfileJson).nativeExecutionInput); } catch { return null; }
  if (execution.binding.runId !== run.id || execution.binding.companyId !== run.companyId ||
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
  return observed;
}

/** Re-derive authority from immutable run-bound evidence, including after restart. */
export async function readPersistedNativeProviderFailure(
  ...args: Parameters<typeof observePersistedNativeTurnFailure>
) {
  const [, , turnId, terminal] = args;
  return (await observePersistedNativeTurnFailure(...args))?.forTerminal(turnId, terminal) ?? null;
}

/**
 * Recovery can finalize before heartbeat saves the adapter result. Rebuild the
 * classified failure and the diagnostics-only turn failure from one event.
 */
export async function readPersistedNativeFailureEvidence(
  ...args: Parameters<typeof observePersistedNativeTurnFailure>
) {
  const [, , turnId, terminal] = args;
  const observed = await observePersistedNativeTurnFailure(...args);
  return {
    providerFailure: observed?.forTerminal(turnId, terminal) ?? null,
    turnFailure: observed?.unclassifiedTurnFailure(turnId, terminal) ?? null,
    providerExplanation: observed?.providerFailureForTerminal(turnId, terminal) ?? null,
  };
}

const TURN_LIFECYCLE_EVENT_TYPES = [
  "turn.submitted", "turn.started", "turn.accepted", "turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled",
] as const;

/**
 * True only when the run's last committed runner turn terminal is an exhausted
 * provider allowance. A restart can end such a run before its executor saves
 * `native_provider_usage_limit`; this re-derives that fact from the same
 * immutable, run-bound event the executor classified.
 */
export async function readPersistedNativeTerminalUsageLimit(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
): Promise<boolean> {
  if (run.runtimeMode !== "native" || !run.nativeSessionId || !run.runnerInstanceId) return false;
  const [row] = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    sql`${heartbeatRunEvents.sourceInstanceId} is not null`,
    inArray(heartbeatRunEvents.eventType, [...TURN_LIFECYCLE_EVENT_TYPES]),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  // A later turn, or one from another runner, means this failure did not end the run.
  if (!row || row.eventType !== "turn.failed" || row.sourceInstanceId !== run.runnerInstanceId) return false;
  const parsed = validatePrpEvent(record(row.payload).prpEvent);
  if (!parsed.ok || parsed.event.runId !== run.id || parsed.event.normalizedSessionId !== run.nativeSessionId ||
      parsed.event.sourceKind !== "runner" || parsed.event.sourceInstanceId !== run.runnerInstanceId ||
      parsed.event.sourceEventId !== row.sourceEventId || parsed.event.sourceSeq !== row.sourceSeq ||
      parsed.event.eventType !== row.eventType || row.sourcePayloadSha256 !== nativeSha256(parsed.event)) return false;
  return nativeProviderUsageLimitFromEvent(parsed.event);
}

export async function readPersistedNativeModelRejection(
  ...args: Parameters<typeof readPersistedNativeProviderFailure>
) {
  const failure = await readPersistedNativeProviderFailure(...args);
  return failure?.errorCode === "native_provider_model_rejected" ? failure : null;
}
