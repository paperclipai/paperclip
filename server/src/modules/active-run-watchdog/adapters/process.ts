import { runningProcesses } from "../../../adapters/index.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../../../services/local-service-supervisor.js";
import type { RunProcessController } from "../application/ports.js";
import type { RunProcessCleanupOutcome, RunProcessMetadata } from "../application/types.js";

const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
]);

function isValidPositivePid(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function createProcessAdapter(): RunProcessController {
  return {
    async cleanupRunProcess(input: RunProcessMetadata): Promise<RunProcessCleanupOutcome> {
      if (!SESSIONED_LOCAL_ADAPTERS.has(input.adapterType)) {
        return { attempted: false, outcome: "skipped_non_local_adapter", adapterType: input.adapterType };
      }

      const running = runningProcesses.get(input.runId);
      const pid = running?.child.pid ?? input.fallbackPid ?? null;
      const processGroupId = running?.processGroupId ?? input.fallbackProcessGroupId ?? null;
      if (typeof pid !== "number" && typeof processGroupId !== "number") {
        return { attempted: false, outcome: "no_process_metadata", adapterType: input.adapterType };
      }

      const wasAlive =
        (typeof pid === "number" && isPidAlive(pid)) ||
        (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
      if (!wasAlive) {
        runningProcesses.delete(input.runId);
        return { attempted: false, outcome: "not_running", adapterType: input.adapterType, pid, processGroupId };
      }

      try {
        await terminateLocalService(
          {
            pid: isValidPositivePid(pid) ? pid : (processGroupId ?? 0),
            processGroupId: isValidPositivePid(processGroupId) ? processGroupId : null,
          },
          running ? { forceAfterMs: Math.max(1, running.graceSec) * 1000 } : undefined,
        );
        runningProcesses.delete(input.runId);
        const stillAlive =
          (typeof pid === "number" && isPidAlive(pid)) ||
          (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
        return {
          attempted: true,
          outcome: stillAlive ? "termination_sent_still_running" : "terminated",
          adapterType: input.adapterType,
          pid,
          processGroupId,
        };
      } catch (error) {
        return {
          attempted: true,
          outcome: "failed",
          adapterType: input.adapterType,
          pid,
          processGroupId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
