import type { heartbeatRuns } from "@paperclipai/db";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { SERVER_SHUTDOWN_INTERRUPTED_CODE } from "./legacy-shutdown-before-dispatch.js";
import { readControllerProcess } from "./controller-process-identity.js";

type Run = Pick<typeof heartbeatRuns.$inferSelect,
  "runtimeMode" | "status" | "errorCode" | "resultJson" | "controllerBootId">;

/**
 * A legacy run that ended only because its server process was replaced or
 * restarted. Its continuation is not a retry of a failed attempt, so it uses
 * the server-restart lane and never spends the failure budget.
 *
 * - A graceful shutdown (deploy, restart) wrote `server_shutdown_interrupted`.
 * - A later server found the run without its owner (`process_lost`) and the
 *   owner was another server boot. The reaper records that verdict as
 *   `processLossDiagnostic.controllerReplaced`. Rows saved by an older release
 *   have no verdict: their recorded owner boot must differ from this boot, or
 *   the run must have started before this server process.
 */
export function isServerReplacementInterruption(run: Run, currentBootId: string = legacyControllerBootId): boolean {
  if (run.runtimeMode !== "legacy") return false;
  if (run.status === "interrupted" && run.errorCode === SERVER_SHUTDOWN_INTERRUPTED_CODE) return true;
  if (run.status !== "failed" || run.errorCode !== "process_lost") return false;
  const diagnostic = run.resultJson?.processLossDiagnostic;
  const verdict = diagnostic && typeof diagnostic === "object" && !Array.isArray(diagnostic)
    ? (diagnostic as Record<string, unknown>).controllerReplaced : undefined;
  if (typeof verdict === "boolean") return verdict;
  if (run.controllerBootId) return run.controllerBootId !== currentBootId;
  return diagnostic !== null && typeof diagnostic === "object"
    && (diagnostic as Record<string, unknown>).runPredatesObserver === true;
}

/**
 * A replacement stopped this legacy run's setup before adapter dispatch
 * (bootstrap evidence `providerWorkStarted: false`), and the row names the
 * server process that owned it. No provider action happened, so it continues
 * in the server-restart lane even when its failure budget is spent. A row
 * saved by an older release without a controller process stamp cannot show
 * its owner and stays in the charged lane.
 */
export function isReplacedPreparation(run: Run & { controllerProcess?: unknown }, currentBootId: string = legacyControllerBootId): boolean {
  const evidence = run.resultJson?.executionRecovery;
  const record = evidence && typeof evidence === "object" && !Array.isArray(evidence)
    ? evidence as Record<string, unknown> : null;
  return record?.kind === "bootstrap" && record.providerWorkStarted === false
    && readControllerProcess(run.controllerProcess) !== null && isServerReplacementInterruption(run, currentBootId);
}
