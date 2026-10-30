import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

type Run = Pick<typeof heartbeatRuns.$inferSelect, "resultJson" | "executionStage">;

export const LEGACY_EXECUTION_SETTLEMENT_KEY = "legacyExecutionSettlement";
export const LEGACY_EXECUTION_SETTLEMENT_SCHEMA = "paperclip.legacy-execution-settlement.v1";

export type LegacyExecutionSettlement = {
  settledAt: string;
  controllerBootId: string | null;
  stage: string | null;
};

export function legacyExecutionSettlementReceipt(settledAt: Date, controllerBootId: string): SQL {
  return sql`case when ${heartbeatRuns.status} = 'cancelled'
    then coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object(
      ${LEGACY_EXECUTION_SETTLEMENT_KEY}::text, jsonb_build_object(
        'schema', ${LEGACY_EXECUTION_SETTLEMENT_SCHEMA}::text,
        'settledAt', ${settledAt.toISOString()}::text,
        'controllerBootId', ${controllerBootId}::text,
        'stage', ${heartbeatRuns.executionStage}))
    else ${heartbeatRuns.resultJson} end`;
}

export function readLegacyExecutionSettlement(run: Run): LegacyExecutionSettlement | null {
  const receipt = run.resultJson?.[LEGACY_EXECUTION_SETTLEMENT_KEY] as Record<string, unknown> | undefined;
  if (receipt?.schema !== LEGACY_EXECUTION_SETTLEMENT_SCHEMA || typeof receipt.settledAt !== "string") return null;
  return {
    settledAt: receipt.settledAt,
    controllerBootId: typeof receipt.controllerBootId === "string" ? receipt.controllerBootId : null,
    stage: typeof receipt.stage === "string" ? receipt.stage : null,
  };
}

export function hasLegacyExecutionSettlement(run: Run): boolean {
  return Boolean(readLegacyExecutionSettlement(run)) || run.executionStage === "settled";
}

export function reachedProviderDispatchStage(run: Run): boolean | null {
  const settlement = readLegacyExecutionSettlement(run);
  const stage = settlement ? settlement.stage : run.executionStage;
  if (stage === "settled") return null;
  return stage === "dispatching";
}
