import type { Issue } from "@paperclipai/shared";
import type { ActiveRunForIssue, LiveRunForIssue } from "../api/heartbeats";

function isTerminalIssueStatus(status: Issue["status"] | string | null | undefined): boolean {
  return status === "done" || status === "cancelled";
}

export function shouldTrackIssueActiveRun(
  issue: Pick<Issue, "status" | "executionRunId"> | null | undefined,
): boolean {
  if (isTerminalIssueStatus(issue?.status)) return false;
  return Boolean(issue && (issue.status === "in_progress" || issue.executionRunId));
}

export function resolveIssueActiveRun(
  issue: Pick<Issue, "status" | "executionRunId"> | null | undefined,
  activeRun: ActiveRunForIssue | null | undefined,
): ActiveRunForIssue | null {
  return shouldTrackIssueActiveRun(issue) ? (activeRun ?? null) : null;
}

export function filterIssueLiveRuns(
  issue: Pick<Issue, "id" | "status"> | null | undefined,
  liveRuns: readonly LiveRunForIssue[] | null | undefined,
): LiveRunForIssue[] {
  if (!issue || isTerminalIssueStatus(issue.status)) return [];
  return (liveRuns ?? []).filter((run) => run.issueId === issue.id);
}
