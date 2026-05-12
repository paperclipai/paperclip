import type { LiveRunForIssue } from "../api/heartbeats";

function isLiveRunStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

export function collectLiveIssueIds(liveRuns: readonly LiveRunForIssue[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const run of liveRuns ?? []) {
    if (run.issueId && isLiveRunStatus(run.status)) ids.add(run.issueId);
  }
  return ids;
}
