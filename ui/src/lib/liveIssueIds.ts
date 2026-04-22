import type { LiveRunForIssue } from "../api/heartbeats";

export function collectLiveIssueIds(liveRuns: readonly LiveRunForIssue[] | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const run of liveRuns ?? []) {
    if (run.issueId) ids.add(run.issueId);
  }
  return ids;
}
