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

/**
 * Minimal tree node shape needed to roll live descendants up to their ancestors.
 * Both list and inbox issue objects satisfy this.
 */
export interface SubtreeLiveNode {
  id: string;
  parentId: string | null;
}

/**
 * Derive, for every issue in the already-loaded tree, how many of its
 * descendants currently have their own live (queued/running) run.
 *
 * The count is strictly over descendants — an issue's own live run never
 * contributes to its own entry. Ancestors are walked through the loaded set
 * via `parentId`, so descendants that are not loaded are simply not counted.
 *
 * Pair with {@link collectLiveIssueIds}: keep `Live` for `liveIssueIds.has(id)`
 * (own run) and render the distinct "n live below" treatment only when an
 * issue is not itself live but has a positive subtree-live count.
 */
export function collectSubtreeLiveCounts(
  issues: readonly SubtreeLiveNode[] | null | undefined,
  liveIssueIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!issues || issues.length === 0 || liveIssueIds.size === 0) return counts;

  const parentById = new Map<string, string | null>();
  for (const issue of issues) parentById.set(issue.id, issue.parentId);

  for (const liveId of liveIssueIds) {
    // Only roll up live issues that belong to the loaded tree.
    if (!parentById.has(liveId)) continue;
    const seen = new Set<string>([liveId]);
    let parentId = parentById.get(liveId) ?? null;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
      parentId = parentById.get(parentId) ?? null;
    }
  }
  return counts;
}
