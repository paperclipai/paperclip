import type { IssueRelationIssueSummary } from "@paperclipai/shared";

export type WaitingBlockerStatus = "done" | "running" | "queued";

export interface WaitingBlockerStep {
  blocker: IssueRelationIssueSummary;
  status: WaitingBlockerStatus;
}

export function classifyWaitingBlocker(
  blocker: IssueRelationIssueSummary,
  liveIssueIds: ReadonlySet<string>,
): WaitingBlockerStatus {
  if (blocker.status === "done" || blocker.status === "cancelled") return "done";
  if (liveIssueIds.has(blocker.id)) return "running";
  return "queued";
}

const WAITING_BLOCKER_RANK: Record<WaitingBlockerStatus, number> = {
  done: 0,
  running: 1,
  queued: 2,
};

/**
 * Orders the explicit blocker queue the same way in every task surface.
 *
 * The blocker payload does not carry an explicit sequence. Status gives the
 * operational order (completed work, current work, queued work), while the
 * identifier is the stable tie-break used by plan-generated task chains.
 */
export function orderWaitingBlockers(
  blockers: IssueRelationIssueSummary[],
  liveIssueIds: ReadonlySet<string>,
): WaitingBlockerStep[] {
  return blockers
    .map((blocker) => ({ blocker, status: classifyWaitingBlocker(blocker, liveIssueIds) }))
    .sort((a, b) => {
      const rank = WAITING_BLOCKER_RANK[a.status] - WAITING_BLOCKER_RANK[b.status];
      if (rank !== 0) return rank;
      const aKey = a.blocker.identifier ?? a.blocker.id;
      const bKey = b.blocker.identifier ?? b.blocker.id;
      return aKey.localeCompare(bKey, undefined, { numeric: true });
    });
}

export function isAssignedBacklogBlocker(blocker: IssueRelationIssueSummary): boolean {
  return blocker.status === "backlog" && Boolean(blocker.assigneeAgentId);
}

export function hasAssignedBacklogBlocker(
  blockers: IssueRelationIssueSummary[] | undefined | null,
): boolean {
  if (!blockers || blockers.length === 0) return false;
  return blockers.some((blocker) => {
    if (isAssignedBacklogBlocker(blocker)) return true;
    if (blocker.terminalBlockers?.some(isAssignedBacklogBlocker)) return true;
    return false;
  });
}
