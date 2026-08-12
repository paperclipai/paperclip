import type { IssueRelationIssueSummary } from "@paperclipai/shared";

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
