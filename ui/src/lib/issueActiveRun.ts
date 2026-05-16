import type { Issue } from "@paperclipai/shared";
import type { ActiveRunForIssue } from "../api/heartbeats";

export function shouldTrackIssueActiveRun(
  issue: Pick<Issue, "status" | "executionRunId"> | null | undefined,
): boolean {
  return Boolean(issue && (issue.status === "in_progress" || issue.executionRunId));
}

export function resolveIssueActiveRun(
  issue: Pick<Issue, "status" | "executionRunId"> | null | undefined,
  activeRun: ActiveRunForIssue | null | undefined,
): ActiveRunForIssue | null {
  return shouldTrackIssueActiveRun(issue) ? (activeRun ?? null) : null;
}
