import {
  terminateRunMarkedProcesses,
  type RunDescendantTerminateResult,
} from "@paperclipai/adapter-utils/run-descendants";
import { logger } from "../../middleware/logger.js";
import { listLocalServiceRegistryRecords } from "../local-service-supervisor.js";

export const RUN_DESCENDANT_DEFAULT_GRACE_MS = 5_000;

/**
 * Stops processes a local legacy run left behind after its CLI process group
 * was handled. Processes that a registered local service owns are excluded,
 * so a server-managed runtime service is never stopped here. The scan uses
 * only the run id, so it also works for a cancel after a server restart.
 * Failures are logged and never thrown: teardown must not block run settlement.
 */
export async function reapRunDescendants(input: {
  runId: string;
  graceMs?: number;
  reason: string;
}): Promise<RunDescendantTerminateResult | null> {
  try {
    const records = await listLocalServiceRegistryRecords();
    const result = await terminateRunMarkedProcesses(input.runId, {
      graceMs: input.graceMs ?? RUN_DESCENDANT_DEFAULT_GRACE_MS,
      excludePids: records.map((record) => record.pid).filter((pid) => Number.isInteger(pid) && pid > 0),
      excludeProcessGroupIds: records
        .map((record) => record.processGroupId)
        .filter((pgid): pgid is number => typeof pgid === "number" && pgid > 0),
    });
    if (result.found.length > 0) {
      const log = result.survivors.length > 0 ? logger.warn.bind(logger) : logger.info.bind(logger);
      log(
        {
          runId: input.runId,
          reason: input.reason,
          found: result.found.map((entry) => entry.pid),
          forceKilled: result.forceKilled.map((entry) => entry.pid),
          survivors: result.survivors.map((entry) => entry.pid),
        },
        result.survivors.length > 0
          ? "run descendant processes survived SIGKILL"
          : "stopped run descendant processes left after the run",
      );
    }
    return result;
  } catch (err) {
    logger.warn({ err, runId: input.runId, reason: input.reason }, "failed to reap run descendant processes");
    return null;
  }
}
