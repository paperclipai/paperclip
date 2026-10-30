import { readFile } from "node:fs/promises";
import { runnerMatrix } from "./catalog.js";
import { controllerOutageForExecution, parseControllerOutage, type ControllerOutage } from "./controller-outage.js";
import { parseRecoveryBinding, type RecoveryBinding } from "./controller-recovery-observer.js";
import { parseFinalizationCrashBinding, type FinalizationCrashBinding } from "./finalization-crash-boundary.js";
import { parseRestartRunnerIdentity, type RestartRunnerIdentity } from "./process-tree-owner.js";

export interface RestartRequest {
  requestId: string;
  controllerDowntimeMs?: number;
  preserveRunner?: RestartRunnerIdentity;
  discardControllerCache?: boolean;
  crashAfterResult?: FinalizationCrashBinding;
  controllerOutage?: ControllerOutage;
  recoveryBinding?: RecoveryBinding;
}

export async function readRestartRequest(restartRequestPath: string, executionIds: readonly string[]): Promise<RestartRequest | null> {
  let encoded: string;
  try {
    encoded = await readFile(restartRequestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    // The writer may not have completed its atomic replacement yet.
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const requestId = (value as { requestId?: unknown }).requestId;
  if (
    typeof requestId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(requestId)
  ) {
    return null;
  }
  const preserveRunner = (value as { preserveRunner?: unknown }).preserveRunner;
  const controllerDowntimeMs = (value as { controllerDowntimeMs?: unknown }).controllerDowntimeMs;
  if (controllerDowntimeMs !== undefined && (!Number.isSafeInteger(controllerDowntimeMs)
    || Number(controllerDowntimeMs) < 0 || Number(controllerDowntimeMs) > 300_000)) {
    throw new Error("Controller downtime must be an integer between zero and five minutes");
  }
  const discardControllerCache = (value as { discardControllerCache?: unknown }).discardControllerCache === true;
  if (discardControllerCache && !executionIds.some(id => {
    const execution = runnerMatrix.find(row => row.id === id);
    return execution !== undefined && controllerOutageForExecution(execution, {}) !== undefined;
  })) throw new Error("Controller cache replacement requires an explicit remote controller-outage cell");
  const crashAfterResult = (value as { crashAfterResult?: unknown }).crashAfterResult;
  const controllerOutage = (value as { controllerOutage?: unknown }).controllerOutage;
  const recoveryBinding = (value as { recoveryBinding?: unknown }).recoveryBinding;
  if (recoveryBinding !== undefined && controllerOutage === undefined) throw new Error("Recovery observation requires a controller outage");
  if (controllerOutage !== undefined && (!discardControllerCache || preserveRunner !== undefined || crashAfterResult !== undefined)) {
    throw new Error("Controller outage requires the explicit remote cache-replacement cell without another crash boundary");
  }
  if (crashAfterResult !== undefined && (preserveRunner !== undefined || discardControllerCache)) {
    throw new Error("A finalization crash cannot preserve a running provider or discard its controller cache");
  }
  return { requestId, discardControllerCache, ...(controllerDowntimeMs === undefined ? {} : { controllerDowntimeMs: Number(controllerDowntimeMs) }),
    ...(recoveryBinding === undefined ? {} : { recoveryBinding: parseRecoveryBinding(recoveryBinding) }),
    ...(controllerOutage === undefined ? {} : { controllerOutage: parseControllerOutage(controllerOutage) }),
    ...(preserveRunner === undefined ? {} : { preserveRunner: parseRestartRunnerIdentity(preserveRunner) }),
    ...(crashAfterResult === undefined ? {} : { crashAfterResult: parseFinalizationCrashBinding(crashAfterResult) }) };

}
