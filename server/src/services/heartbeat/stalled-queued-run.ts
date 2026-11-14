import { sql } from "drizzle-orm";
import type { HeartbeatQueueDependencies } from "./queue.js";

export const QUEUED_RUN_STALLED_CODE = "queued_run_stalled";
export const QUEUED_RUN_STALLED_MESSAGE =
  "Paperclip replaced this run with a new one: it had waited over an hour to start while its agent started other work.";

type StalledRunLifecycle = Pick<HeartbeatQueueDependencies,
  "setRunStatusFromLive" | "setWakeupStatus" | "appendRunEvent" | "releaseIssueExecutionAndPromote">;

export function stalledRunUnchangedCondition(fence: { version: string; attachedWakes: number }) {
  return sql`"heartbeat_runs".xmin::text = ${fence.version}
    and (select count(*)::int from agent_wakeup_requests attached where attached.company_id = "heartbeat_runs".company_id
      and (attached.run_id = "heartbeat_runs".id or attached.id = "heartbeat_runs".wakeup_request_id)) = ${fence.attachedWakes}`;
}

export function createStalledQueuedRunCancel(lifecycle: StalledRunLifecycle) {
  return async function cancelStalledQueuedRun(scope: { companyId: string; runId: string; version: string; attachedWakes: number }):
    Promise<boolean> {
    const finishedAt = new Date();
    const write = await lifecycle.setRunStatusFromLive(scope.runId, "cancelled", ["queued"], {
      finishedAt, errorCode: QUEUED_RUN_STALLED_CODE, error: QUEUED_RUN_STALLED_MESSAGE,
    }, undefined, stalledRunUnchangedCondition(scope));
    if (!write.updated || !write.run) return false;
    const cancelled = write.run;
    await lifecycle.setWakeupStatus(cancelled.wakeupRequestId, "cancelled", { finishedAt, error: QUEUED_RUN_STALLED_MESSAGE });
    await lifecycle.appendRunEvent(cancelled, { eventType: "lifecycle", stream: "system", level: "warn",
      message: QUEUED_RUN_STALLED_MESSAGE, payload: { reason: QUEUED_RUN_STALLED_CODE } });
    await lifecycle.releaseIssueExecutionAndPromote(cancelled, { suppressImmediateRecovery: true });
    return true;
  };
}
