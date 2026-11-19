import type { heartbeatRuns } from "@paperclipai/db";
import type { StorageOutageWaitObserver } from "../../storage/storage-unavailable.js";
import { setHeartbeatRunRuntimeStatus } from "../heartbeat-run-runtime-status.js";
import { publishHeartbeatRunRuntimeProgress, type createHeartbeatLifecycle } from "./run-lifecycle.js";

type Run = typeof heartbeatRuns.$inferSelect;

export const STORAGE_WAIT_PHASE = "waiting_for_storage";

const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));

function runIssueId(run: Pick<Run, "contextSnapshot">): string | null {
  const issueId = (run.contextSnapshot as Record<string, unknown> | null)?.issueId;
  return typeof issueId === "string" && issueId.trim() ? issueId : null;
}

export function createStorageWaitNotice(input: {
  run: Run;
  appendRunEvent: ReturnType<typeof createHeartbeatLifecycle>["appendRunEvent"];
}): StorageOutageWaitObserver {
  const { run, appendRunEvent } = input;
  const status = (phase: typeof STORAGE_WAIT_PHASE | "run_activity", message: string) => {
    const at = new Date();
    const published = setHeartbeatRunRuntimeStatus({
      companyId: run.companyId, issueId: runIssueId(run), agentId: run.agentId, runId: run.id,
      phase, message, updatedAt: at, lastEventAt: at,
    });
    if (published) publishHeartbeatRunRuntimeProgress(published);
  };
  return {
    waiting({ purpose, waitedMs }) {
      status(STORAGE_WAIT_PHASE, `Waiting for file storage before ${purpose} (${seconds(waitedMs)}s so far)`);
    },
    ended({ purpose, waitedMs, recovered }) {
      const waited = seconds(waitedMs);
      status("run_activity", recovered
        ? `File storage is back after ${waited}s`
        : `Stopped waiting for file storage after ${waited}s`);
      void Promise.resolve().then(() => appendRunEvent(run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: recovered
          ? `Waited ${waited}s for file storage before ${purpose}.`
          : `Waited ${waited}s for file storage before ${purpose}; it was still unavailable.`,
        payload: { reason: "storage_outage_wait", purpose, waitedMs, recovered },
      })).catch(() => undefined);
    },
  };
}
