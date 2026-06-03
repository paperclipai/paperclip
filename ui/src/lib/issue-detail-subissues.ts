import type { Issue, IssueStatus } from "@paperclipai/shared";
import { workflowSort } from "./workflow-sort";

export type SubIssueProgressTargetKind = "next" | "blocked";

export type SubIssueProgressTarget = {
  issue: Issue;
  kind: SubIssueProgressTargetKind;
};

export type SubIssueProgressSummary = {
  totalCount: number;
  doneCount: number;
  inProgressCount: number;
  blockedCount: number;
  countsByStatus: Partial<Record<IssueStatus, number>>;
  target: SubIssueProgressTarget | null;
};

export type IssueSiblingNavigation = {
  previous: Issue | null;
  next: Issue | null;
  currentIndex: number;
  totalCount: number;
};

export function shouldRenderRichSubIssuesSection(childIssuesLoading: boolean, childIssueCount: number): boolean {
  return childIssuesLoading || childIssueCount > 0;
}

const MIN_CHILD_ISSUES_FOR_PROGRESS_SUMMARY = 2;

export function shouldRenderSubIssueProgressSummary(enabled: boolean | undefined, childIssueCount: number): boolean {
  return enabled === true && childIssueCount >= MIN_CHILD_ISSUES_FOR_PROGRESS_SUMMARY;
}

export function buildSubIssueProgressSummary(issues: Issue[]): SubIssueProgressSummary {
  const countsByStatus: Partial<Record<IssueStatus, number>> = {};
  const progressIssues = issues.filter((issue) => issue.status !== "cancelled");
  for (const issue of progressIssues) {
    countsByStatus[issue.status] = (countsByStatus[issue.status] ?? 0) + 1;
  }

  const orderedIssues = workflowSort(progressIssues);
  const nextIssue = orderedIssues.find((issue) => isActionableStatus(issue.status)) ?? null;
  const remainingIssues = orderedIssues.filter((issue) => !isTerminalStatus(issue.status));
  const blockedIssue =
    nextIssue === null && remainingIssues.length > 0 && remainingIssues.every((issue) => issue.status === "blocked")
      ? remainingIssues[0]
      : null;

  return {
    totalCount: progressIssues.length,
    doneCount: countsByStatus.done ?? 0,
    inProgressCount: countsByStatus.in_progress ?? 0,
    blockedCount: countsByStatus.blocked ?? 0,
    countsByStatus,
    target: nextIssue
      ? { issue: nextIssue, kind: "next" }
      : blockedIssue
        ? { issue: blockedIssue, kind: "blocked" }
        : null,
  };
}

export function buildIssueSiblingNavigation(
  currentIssue: Issue,
  siblingIssues: Issue[],
  childIssues: Issue[] = [],
): IssueSiblingNavigation | null {
  if (currentIssue.hiddenAt) return null;

  const byId = new Map<string, Issue>();
  if (currentIssue.parentId) {
    for (const issue of siblingIssues) {
      if (issue.parentId !== currentIssue.parentId || issue.hiddenAt) continue;
      byId.set(
        issue.id,
        issue.id === currentIssue.id
          ? { ...issue, ...currentIssue, blockedBy: currentIssue.blockedBy ?? issue.blockedBy }
          : issue,
      );
    }
    if (!byId.has(currentIssue.id)) byId.set(currentIssue.id, currentIssue);
  }

  const ordered = workflowSort(Array.from(byId.values()));
  const currentIndex = ordered.findIndex((issue) => issue.id === currentIssue.id);
  const directChildren = workflowSort(
    childIssues.filter((issue) => issue.parentId === currentIssue.id && !issue.hiddenAt),
  );
  const firstChild = directChildren[0] ?? null;

  if (currentIndex < 0) {
    return firstChild
      ? {
          previous: null,
          next: firstChild,
          currentIndex: 0,
          totalCount: directChildren.length + 1,
        }
      : null;
  }

  const previous = currentIndex > 0 ? ordered[currentIndex - 1] : null;
  const next = currentIndex < ordered.length - 1 ? ordered[currentIndex + 1] : firstChild;
  if (!previous && !next) return null;

  return {
    previous,
    next,
    currentIndex,
    totalCount: ordered.length,
  };
}

function isActionableStatus(status: IssueStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "blocked";
}

function isTerminalStatus(status: IssueStatus): boolean {
  return status === "done" || status === "cancelled";
}
