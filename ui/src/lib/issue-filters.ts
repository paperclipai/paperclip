import type { Issue } from "@paperclipai/shared";

export type IssueFilterState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  labels: string[];
  projects: string[];
  showRoutineExecutions: boolean;
};

export const defaultIssueFilterState: IssueFilterState = {
  statuses: [],
  priorities: [],
  assignees: [],
  labels: [],
  projects: [],
  showRoutineExecutions: false,
};

export const issueStatusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
export const issuePriorityOrder = ["critical", "high", "medium", "low"];

export const issueQuickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

export function issueFilterLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function issueFilterArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export function toggleIssueFilterValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((existing) => existing !== value) : [...values, value];
}

export function applyIssueFilters(
  issues: Issue[],
  state: IssueFilterState,
  currentUserId?: string | null,
  enableRoutineVisibilityFilter = false,
): Issue[] {
  let result = issues;
  if (enableRoutineVisibilityFilter && !state.showRoutineExecutions) {
    result = result.filter((issue) => issue.originKind !== "routine_execution");
  }
  if (state.statuses.length > 0) result = result.filter((issue) => state.statuses.includes(issue.status));
  if (state.priorities.length > 0) result = result.filter((issue) => state.priorities.includes(issue.priority));
  if (state.assignees.length > 0) {
    result = result.filter((issue) => {
      for (const assignee of state.assignees) {
        if (assignee === "__unassigned" && !issue.assigneeAgentId && !issue.assigneeUserId) return true;
        if (assignee === "__me" && currentUserId && issue.assigneeUserId === currentUserId) return true;
        if (issue.assigneeAgentId === assignee) return true;
      }
      return false;
    });
  }
  if (state.labels.length > 0) {
    result = result.filter((issue) => (issue.labelIds ?? []).some((id) => state.labels.includes(id)));
  }
  if (state.projects.length > 0) {
    result = result.filter((issue) => issue.projectId != null && state.projects.includes(issue.projectId));
  }
  return result;
}

export function countActiveIssueFilters(
  state: IssueFilterState,
  enableRoutineVisibilityFilter = false,
): number {
  let count = 0;
  if (state.statuses.length > 0) count += 1;
  if (state.priorities.length > 0) count += 1;
  if (state.assignees.length > 0) count += 1;
  if (state.labels.length > 0) count += 1;
  if (state.projects.length > 0) count += 1;
  if (enableRoutineVisibilityFilter && state.showRoutineExecutions) count += 1;
  return count;
}
