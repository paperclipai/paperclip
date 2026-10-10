import type { heartbeatRuns } from "@paperclipai/db";
import { buildHeartbeatRunIssueComment } from "./heartbeat-run-summary.js";

export function buildHeartbeatRunStatusLiveEventPayload(
  run: Pick<
    typeof heartbeatRuns.$inferSelect,
    | "id"
    | "agentId"
    | "status"
    | "invocationSource"
    | "triggerDetail"
    | "error"
    | "errorCode"
    | "startedAt"
    | "finishedAt"
    | "resultJson"
  > &
    Partial<Pick<typeof heartbeatRuns.$inferSelect, "contextSnapshot">>,
) {
  return {
    runId: run.id,
    agentId: run.agentId,
    issueId: typeof run.contextSnapshot?.issueId === "string"
      ? run.contextSnapshot.issueId
      : null,
    status: run.status,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    error: run.error ?? null,
    errorCode: run.errorCode ?? null,
    contextSource:
      typeof run.contextSnapshot?.source === "string" &&
      run.contextSnapshot.source.trim()
        ? run.contextSnapshot.source.trim()
        : null,
    startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    finalText: [
      "succeeded",
      "interrupted",
      "failed",
      "cancelled",
      "timed_out",
    ].includes(run.status)
      ? buildHeartbeatRunIssueComment(run.resultJson ?? {})
      : null,
  };
}
