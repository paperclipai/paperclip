import { heartbeatRuns, type Db } from "@paperclipai/db";
import { museRunnerBroker } from "../muse-runner-broker.js";
import { logger } from "../../middleware/logger.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Call only after run projection commits and outside issue/run transactions.
 * Reconcile the original binding, including after a provider configuration change.
 * The broker retains failed-worker and unsettled-native-effect uncertainty.
 */
export async function reconcileMuseNativeTerminalRun(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "runtimeMode" | "status" | "runnerProfileJson">): Promise<void> {
  if (run.runtimeMode !== "native" || !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return;
  const execution = record(record(run.runnerProfileJson).nativeExecutionInput);
  const provider = record(execution.provider);
  const binding = record(provider.binding);
  if (execution.schema !== "paperclip.native-execution-input.v7" || provider.kind !== "muse"
      || binding.companyId !== run.companyId || binding.agentId !== run.agentId
      || typeof binding.bindingId !== "string" || !binding.bindingId) return;
  await museRunnerBroker(db).reconcileTerminalAssignments(run.companyId, run.agentId, binding.bindingId).catch(err => {
    logger.warn({ err, runId: run.id, bindingId: binding.bindingId }, "Muse terminal assignment reconciliation deferred to maintenance");
  });
}
