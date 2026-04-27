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

function isActionableStatus(status: IssueStatus): boolean {
  return status !== "done" && status !== "cancelled" && status !== "blocked";
}

function isTerminalStatus(status: IssueStatus): boolean {
  return status === "done" || status === "cancelled";
}
