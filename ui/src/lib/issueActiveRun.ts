import type { Issue } from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";

export function shouldTrackIssueActiveRun(
  issue: Pick<Issue, "status" | "executionRunId"> | null | undefined,
): boolean {
  return Boolean(issue && (issue.status === "in_progress" || issue.executionRunId));
}

export function resolveIssueActiveRun(
  issue: Pick<Issue, "status" | "executionRunId"> | null | undefined,
  activeRun: ActiveRunForIssue | null | undefined,
  liveRuns?: readonly LiveRunForIssue[],
): ActiveRunForIssue | null {
  if (!shouldTrackIssueActiveRun(issue) || !activeRun) return null;
  // The active-run query stops polling while the live-run list is populated.
  // Keep its selected identity, but use the refreshed snapshot for that run.
  return liveRuns?.find((run) => run.id === activeRun.id) ?? activeRun;
}
