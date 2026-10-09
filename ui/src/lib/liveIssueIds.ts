import type { IssueStatus } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";

function isLiveRunStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);

export function isTerminalIssueStatus(status: string | null | undefined): status is IssueStatus {
  return TERMINAL_ISSUE_STATUSES.has(status as IssueStatus);
}

export function isLiveIssueRun(
  run: Pick<LiveRunForIssue, "status">,
  issueStatus?: string | null,
): boolean {
  return isLiveRunStatus(run.status) && !isTerminalIssueStatus(issueStatus);
}

export interface LiveIssueStatusNode {
  id: string;
  status: IssueStatus | string;
  updatedAt?: Date | string | number | null;
}

function collectIssueStatusById(issues: readonly LiveIssueStatusNode[] | null | undefined): Map<string, string> {
  const snapshotByIssueId = new Map<string, { status: string; updatedAtMs: number | null }>();
  for (const issue of issues ?? []) {
    const candidate = {
      status: issue.status,
      updatedAtMs: issueUpdatedAtMs(issue.updatedAt),
    };
    const existing = snapshotByIssueId.get(issue.id);
    if (!existing || shouldReplaceIssueStatusSnapshot(existing, candidate)) snapshotByIssueId.set(issue.id, candidate);
  }
  return new Map([...snapshotByIssueId].map(([issueId, snapshot]) => [issueId, snapshot.status]));
}

function issueUpdatedAtMs(updatedAt: LiveIssueStatusNode["updatedAt"]): number | null {
  if (updatedAt === null || updatedAt === undefined) return null;
  const timestamp = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function shouldReplaceIssueStatusSnapshot(
  existing: { status: string; updatedAtMs: number | null },
  candidate: { status: string; updatedAtMs: number | null },
): boolean {
  if (candidate.updatedAtMs !== null && existing.updatedAtMs !== null) {
    if (candidate.updatedAtMs !== existing.updatedAtMs) return candidate.updatedAtMs > existing.updatedAtMs;
  } else if (candidate.updatedAtMs !== null) {
    return true;
  } else if (existing.updatedAtMs !== null) {
    return false;
  }

  return !isTerminalIssueStatus(existing.status) && isTerminalIssueStatus(candidate.status);
}

export function collectLiveIssueIds(
  liveRuns: readonly LiveRunForIssue[] | null | undefined,
  issues?: readonly LiveIssueStatusNode[] | null,
): Set<string> {
  const ids = new Set<string>();
  const statusByIssueId = collectIssueStatusById(issues);
  for (const run of liveRuns ?? []) {
    if (run.issueId && isLiveIssueRun(run, statusByIssueId.get(run.issueId))) ids.add(run.issueId);
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
