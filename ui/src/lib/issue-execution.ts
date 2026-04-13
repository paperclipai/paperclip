import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";

type RunLike =
  | { status: string; startedAt: string | Date | null }
  | Pick<ActiveRunForIssue, "status" | "startedAt">
  | Pick<LiveRunForIssue, "status" | "startedAt">
  | null
  | undefined;

type IssueLike = { status: string; activeRun?: RunLike };

export function issueExecutionStatus(run: RunLike): "queued" | "running" | null {
  if (!run) return null;
  if (run.status === "queued") return "queued";
  if (run.status === "running") {
    return run.startedAt ? "running" : "queued";
  }
  return null;
}

export function issueDisplayStatus(
  issue: IssueLike,
  run?: RunLike,
): string {
  return issueExecutionStatus(run ?? issue.activeRun) ?? issue.status;
}
