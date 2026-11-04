import type { Issue } from "@paperclipai/shared";
import { issuePriorityOrder, issueStatusOrder } from "./issue-filters";
import { workflowSort } from "./workflow-sort";

/** URL sort fields are shared by all task interfaces, including hidden columns. */
export const ISSUE_SORT_FIELDS = ["status", "priority", "title", "created", "updated", "workflow", "taskId", "createdBy", "assignee", "project", "parentTask", "tags", "worktree"] as const;

export type IssueSortField = typeof ISSUE_SORT_FIELDS[number];
export type IssueSort = { sortField: IssueSortField; sortDir: "asc" | "desc" };

export function readIssueSortParams(params: URLSearchParams): IssueSort | undefined {
  const field = params.get("sortField");
  if (!ISSUE_SORT_FIELDS.includes(field as IssueSortField)) return undefined;
  return { sortField: field as IssueSortField, sortDir: params.get("sortDir") === "asc" ? "asc" : "desc" };
}

export type IssueSortContext = {
  createdBy?: string | null;
  assignee?: string | null;
  project?: string | null;
  parentTask?: string | null;
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compare the same raw values in every interface. Missing values stay last. */
export function sortIssues(issues: readonly Issue[], sort: IssueSort, context: (issue: Issue) => IssueSortContext = () => ({})): Issue[] {
  if (sort.sortField === "workflow") {
    const ordered = workflowSort([...issues]);
    return sort.sortDir === "desc" ? ordered.reverse() : ordered;
  }
  const value = (issue: Issue): string | number | null | undefined => {
    switch (sort.sortField) {
      case "status": return issueStatusOrder.indexOf(issue.displayStatus ?? issue.status);
      case "priority": return issuePriorityOrder.indexOf(issue.priority);
      case "title": return issue.title;
      case "created": return new Date(issue.createdAt).getTime();
      case "updated": return new Date(issue.updatedAt).getTime();
      case "taskId": return issue.identifier;
      case "createdBy": return context(issue).createdBy;
      case "assignee": return context(issue).assignee;
      case "project": return context(issue).project ?? issue.project?.name;
      case "parentTask": return context(issue).parentTask;
      case "tags": return issue.labels?.map(label => label.name).sort().join(", ");
      case "worktree": return issue.currentExecutionWorkspace?.branchName;
    }
  };
  return [...issues].sort((a, b) => {
    const left = value(a), right = value(b);
    const missing = (value: string | number | null | undefined) => value == null || value === "" || (typeof value === "number" && !Number.isFinite(value));
    const leftMissing = missing(left), rightMissing = missing(right);
    if (leftMissing || rightMissing) return Number(leftMissing) - Number(rightMissing);
    const result = typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left), String(right));
    return sort.sortDir === "asc" ? result : -result;
  });
}
