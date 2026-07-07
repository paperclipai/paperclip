import type { Issue } from "@paperclipai/shared";

/**
 * Helpers for the dashboard "Needs Your Attention" prioritization view (FUS-762).
 *
 * The insight: of all open tasks, only the ones that are `in_review` AND assigned
 * to the current *user* are actually the human's decision queue. Everything else is
 * agents working, agents reviewing each other, or blocked — noise for a board member
 * trying to find what needs their call. These pure helpers isolate that queue and
 * roll up the top-level initiatives so the board can skim goals without scrolling.
 *
 * All functions are pure and operate on the already-fetched issues list, so no extra
 * API round-trips are needed.
 */

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Lower rank = more urgent. Unknown priorities sort as medium. */
export function priorityRank(priority: string): number {
  return PRIORITY_RANK[priority] ?? PRIORITY_RANK.medium!;
}

const CLOSED_STATUSES = new Set(["done", "cancelled"]);

/** Open = not done and not cancelled (matches the dashboard summary definition). */
export function isOpenStatus(status: string): boolean {
  return !CLOSED_STATUSES.has(status);
}

function createdAtMs(issue: Issue): number {
  const t = new Date(issue.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * #1 — The daily driver. Tasks where status is `in_review` and the assignee is the
 * current user, sorted by priority then issue age. Paperclip does not currently
 * expose a review-entered timestamp, so createdAt is the stable age proxy; updatedAt
 * can move when someone edits the issue and bury an older decision.
 */
export function getNeedsYouIssues(
  issues: Issue[],
  currentUserId: string | null | undefined,
): Issue[] {
  if (!currentUserId) return [];
  return issues
    .filter(
      (issue) =>
        issue.status === "in_review" && issue.assigneeUserId === currentUserId,
    )
    .sort(
      (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        createdAtMs(a) - createdAtMs(b),
    );
}

export interface InitiativeRollup {
  issue: Issue;
  /** Non-cancelled descendants (any depth). */
  totalChildren: number;
  /** Open (not done/cancelled) descendants. */
  openChildren: number;
  /** Done descendants. */
  doneChildren: number;
  /** done / total, 0-100, rounded. */
  progressPercent: number;
}

/**
 * #2 — Initiatives roll-up. Top-level issues (no `parentId`, not cancelled) that have
 * at least one child, with open-child counts and a done/total progress percentage.
 * Descendants are counted recursively so deep initiative trees roll up fully. Sorted
 * by open-child count (most active first), then priority.
 */
export function getInitiativesRollup(issues: Issue[]): InitiativeRollup[] {
  const childrenByParent = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.parentId) continue;
    const siblings = childrenByParent.get(issue.parentId);
    if (siblings) siblings.push(issue);
    else childrenByParent.set(issue.parentId, [issue]);
  }

  const collectDescendants = (rootId: string): Issue[] => {
    const out: Issue[] = [];
    const seen = new Set<string>([rootId]);
    const stack = [...(childrenByParent.get(rootId) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push(node);
      const kids = childrenByParent.get(node.id);
      if (kids) stack.push(...kids);
    }
    return out;
  };

  const rollups: InitiativeRollup[] = [];
  for (const issue of issues) {
    if (issue.parentId) continue;
    if (issue.status === "cancelled") continue;
    const counted = collectDescendants(issue.id).filter(
      (d) => d.status !== "cancelled",
    );
    if (counted.length === 0) continue; // a root with no children is a task, not an initiative
    const doneChildren = counted.filter((d) => d.status === "done").length;
    const openChildren = counted.filter((d) => isOpenStatus(d.status)).length;
    rollups.push({
      issue,
      totalChildren: counted.length,
      openChildren,
      doneChildren,
      progressPercent: Math.round((doneChildren / counted.length) * 100),
    });
  }

  rollups.sort(
    (a, b) =>
      b.openChildren - a.openChildren ||
      priorityRank(a.issue.priority) - priorityRank(b.issue.priority),
  );
  return rollups;
}

export interface ParkedSummary {
  /** `blocked` issues. */
  blocked: Issue[];
  /** `in_review` issues assigned to an agent (agents reviewing each other). */
  agentReview: Issue[];
  /** blocked + agentReview, deduped, for the expanded list. */
  issues: Issue[];
  total: number;
}

/**
 * #3 — "Parked" group. `blocked` tasks plus `in_review` tasks assigned to an agent
 * (not a user). These are real work but not the human's decision queue, so they live
 * behind a collapsed count to stop adding noise.
 */
export function getParkedSummary(issues: Issue[]): ParkedSummary {
  const blocked = issues.filter((issue) => issue.status === "blocked");
  const agentReview = issues.filter(
    (issue) =>
      issue.status === "in_review" &&
      !!issue.assigneeAgentId &&
      !issue.assigneeUserId,
  );
  const seen = new Set<string>();
  const merged: Issue[] = [];
  for (const issue of [...blocked, ...agentReview]) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    merged.push(issue);
  }
  return {
    blocked,
    agentReview,
    issues: merged,
    total: merged.length,
  };
}
