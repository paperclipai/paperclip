import { and, eq } from "drizzle-orm";
import { heartbeatRuns, nativeRunResults, type Db } from "@paperclipai/db";
import { NATIVE_FINALIZATION_SCHEMA, type NativeFinalizationResult } from "@paperclipai/shared";
import type { AdapterExecutionResult } from "../../adapters/index.js";
import { readAcceptedRunUsageCheckpoint } from "../usage-receipts.js";
import type { NativePostResultFailureDiagnostic } from "./native-post-result-failure.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const RUN_TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Rebuild the execution result of an accepted native run whose runner could not
 * prove suspension when it closed. The provider turn, its result and terminal
 * state are durable; only runner bookkeeping failed. Ordinary completion can
 * then settle the run from the result instead of reporting an adapter failure.
 * Returns null unless the exact accepted result and its terminal are present.
 */
export async function acceptedNativeAdapterResult(db: Db, input: {
  runId: string;
  companyId: string;
  resultId: string;
  model: string | null;
  driverKind: string;
  postResultFailure: NativePostResultFailureDiagnostic;
}): Promise<AdapterExecutionResult | null> {
  const [row] = await db.select({
    issueId: nativeRunResults.issueId,
    turnId: nativeRunResults.turnId,
    resultJson: nativeRunResults.resultJson,
    nativeSessionId: heartbeatRuns.nativeSessionId,
    runnerInstanceId: heartbeatRuns.runnerInstanceId,
  }).from(nativeRunResults)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunResults.runId), eq(heartbeatRuns.companyId, nativeRunResults.companyId)))
    .where(and(
      eq(nativeRunResults.id, input.resultId),
      eq(nativeRunResults.runId, input.runId),
      eq(nativeRunResults.companyId, input.companyId),
      eq(nativeRunResults.schemaStatus, "accepted"),
    )).limit(1);
  if (!row) return null;
  const result = record(row.resultJson.result);
  const terminal = record(row.resultJson.terminal);
  if (terminal.schema !== "paperclip.prp.terminal.v1" || !RUN_TERMINAL_STATES.has(String(terminal.runTerminalState))) return null;
  const nativeTerminal = terminal as unknown as NativeFinalizationResult["terminal"];
  const succeeded = nativeTerminal.runTerminalState === "succeeded";
  const usage = await readAcceptedRunUsageCheckpoint(db, { companyId: input.companyId, runId: input.runId });
  const normalizedSessionId = row.nativeSessionId ?? null;
  return {
    exitCode: succeeded ? 0 : 1,
    signal: null,
    timedOut: false,
    errorMessage: succeeded ? null : `Native session ${nativeTerminal.runTerminalState}`,
    resultJson: {
      nativeResult: result,
      nativeTerminal: terminal,
      nativePostResultFailure: { ...input.postResultFailure },
    },
    summary: typeof result.summary === "string" ? result.summary : null,
    ...(normalizedSessionId ? { sessionId: normalizedSessionId, sessionDisplayId: normalizedSessionId } : {}),
    model: input.model ?? undefined,
    ...(usage ?? {}),
    usageComplete: usage?.complete ?? false,
    ...(!usage ? { costStatus: "unpriced" as const } : {}),
    ...(normalizedSessionId && row.runnerInstanceId ? {
      nativeFinalization: {
        schema: NATIVE_FINALIZATION_SCHEMA,
        runtimeMode: "native",
        runId: input.runId,
        issueId: row.issueId,
        companyId: input.companyId,
        result,
        terminal: nativeTerminal,
        turnId: row.turnId,
        sourceInstanceId: row.runnerInstanceId,
        normalizedSessionId,
        providerSessionId: null,
        driverKind: input.driverKind,
        driverVersion: "unknown",
        nativeEventCount: 0,
        highestContiguousSourceSeq: 0,
        workspaceFinalizeStatus: "succeeded",
      },
    } : {}),
  };
}
