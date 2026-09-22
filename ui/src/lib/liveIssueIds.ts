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

/**
 * Page size of `GET /api/companies/:companyId/live-runs`. The route clamps
 * `limit` to this value (`readLiveRunsQueryInt(req.query.limit, 50, 50)` in
 * `server/src/routes/agents.ts`), so no client can read a wider window.
 */
export const LIVE_RUNS_PAGE_LIMIT = 50;

/**
 * True when a live-run response lists *every* queued/running run in the
 * company — i.e. the server did not hand back a full page.
 *
 * Reading a missing issue as "nothing is running" is only sound over a complete
 * window. Above {@link LIVE_RUNS_PAGE_LIMIT} concurrent runs the newest page
 * hides the rest, so absence proves nothing and callers that infer *inactivity*
 * (the in-progress glyph, PAP-640) must fall back instead of claiming idle.
 * Counting Live pills is unaffected: a truncated page under-counts, it never
 * invents a live run.
 *
 * A response that has not arrived yet counts as complete. There is no evidence
 * of work in hand, and starting calm beats a flash of motion on every load.
 *
 * This reads the array as it stands. The cached array also shrinks between
 * fetches — `removeRunFromList` drops a run when it finishes — so a caller that
 * holds the verdict over time must latch it with {@link trackLiveRunCoverage}
 * rather than recompute it from a list that events have edited.
 */
export function isLiveRunCoverageComplete(
  liveRuns: readonly LiveRunForIssue[] | null | undefined,
): boolean {
  return (liveRuns?.length ?? 0) < LIVE_RUNS_PAGE_LIMIT;
}

/**
 * Coverage verdict per company: `true` while that company's live-run window is
 * known to be whole. A company with no entry has nothing against it yet.
 */
export type LiveRunCoverageByCompany = ReadonlyMap<string | null, boolean>;

export const INITIAL_LIVE_RUN_COVERAGE: LiveRunCoverageByCompany = new Map<string | null, boolean>();

/**
 * Carry a coverage verdict forward across cache edits: once a page has arrived
 * full, that company's window stays incomplete.
 *
 * Run-lifecycle events edit the cached list in place — a finished run is
 * removed from it — so a truncated page of {@link LIVE_RUNS_PAGE_LIMIT} shrinks
 * below the cap without anyone refetching. Recomputing from that shorter array
 * would announce a complete window while the runs the page originally hid are
 * still invisible, and tasks those runs belong to would read as idle.
 *
 * Losing a run tells us nothing about the ones we never saw, so a verdict only
 * travels one way. It is kept per company rather than as one current verdict:
 * a busy company must not silence the next one, and coming back to that company
 * must not silently trust the shortened page React Query still has cached for
 * it. Both directions matter because the provider outlives every switch.
 *
 * Returns `previous` unchanged when the verdict is unchanged, so the value can
 * be compared by identity.
 */
export function trackLiveRunCoverage(
  previous: LiveRunCoverageByCompany,
  companyId: string | null,
  liveRuns: readonly LiveRunForIssue[] | null | undefined,
): LiveRunCoverageByCompany {
  const carried = previous.get(companyId) ?? true;
  const complete = carried && isLiveRunCoverageComplete(liveRuns);
  if (complete === previous.get(companyId)) return previous;
  const next = new Map(previous);
  next.set(companyId, complete);
  return next;
}

/** Read one company's verdict. Unknown companies are treated as whole. */
export function isCompanyLiveRunCoverageComplete(
  coverage: LiveRunCoverageByCompany,
  companyId: string | null,
): boolean {
  return coverage.get(companyId) ?? true;
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
