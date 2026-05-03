import type { HeartbeatRun } from "@paperclipai/shared";

export function lifecyclePhaseForStatus(status: HeartbeatRun["status"]): HeartbeatRun["lifecyclePhase"] {
  if (status === "queued" || status === "running" || status === "succeeded") {
    return status;
  }
  return "failed";
}
