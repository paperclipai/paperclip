import { t } from "@/i18n";
import { readIssueSortParams, type IssueSort, type IssueSortField } from "./issue-sort";

/** Ordered columns and token references shared by the proposed header and rows. */
export const taskListColumns = [
  { id: "task", get "label"() { return t("display:meta_7bb0ddf9221c"); }, width: "var(--task-list-column-task)" },
  { id: "taskId", get "label"() { return t("display:meta_0491c6d47e2d"); }, width: "var(--task-list-column-task-id)" },
  { id: "createdBy", get "label"() { return t("display:meta_5d73cc30510c"); }, width: "var(--task-list-column-created-by)" },
  { id: "assignee", get "label"() { return t("display:meta_049e3ce5476a"); }, width: "var(--task-list-column-assignee)" },
  { id: "project", get "label"() { return t("display:meta_f6f4da8d93e8"); }, width: "var(--task-list-column-project)" },
  { id: "parentTask", get "label"() { return t("display:meta_915a5dd07c55"); }, width: "var(--task-list-column-parent)" },
  { id: "tags", get "label"() { return t("display:meta_848eed0fbd54"); }, width: "var(--task-list-column-tags)" },
  { id: "worktree", get "label"() { return t("display:meta_fad0554cb2ea"); }, width: "var(--task-list-column-worktree)" },
  { id: "lastUpdated", get "label"() { return t("display:meta_583c9e23574a"); }, width: "var(--task-list-column-updated)" },
] as const;

export type TaskListColumnId = (typeof taskListColumns)[number]["id"];
export type TaskListSort<Column extends string = TaskListColumnId> = { column: Column; direction: "ascending" | "descending" };
export type TaskListOrder = TaskListSort<TaskListColumnId | "created" | "status" | "priority" | "workflow">;
export type TaskListSortValue = string | number | null | undefined;
export const allTaskListColumns: readonly TaskListColumnId[] = taskListColumns.map(column => column.id);
export const defaultTaskListColumns: readonly TaskListColumnId[] = ["task", "taskId", "lastUpdated"];
export const defaultTaskListSort: TaskListSort = { column: "lastUpdated", direction: "descending" };

/** Task occupies two adjacent physical tracks: status/disclosure, then title. */
export function taskListColumnStart(columns: readonly TaskListColumnId[], id: TaskListColumnId): number {
  const index = columns.indexOf(id);
  return index + 1 + (columns.includes("task") ? (columns.indexOf("task") < index ? 1 : 0) : 1);
}

export function reorderTaskListColumns(columns: readonly TaskListColumnId[], from: TaskListColumnId, to: TaskListColumnId): readonly TaskListColumnId[] {
  const start = columns.indexOf(from);
  const end = columns.indexOf(to);
  if (start < 0 || end < 0 || start === end) return columns;
  const next = [...columns];
  next.splice(end, 0, next.splice(start, 1)[0]);
  return next;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Sort raw values before building the tree, so only sibling order changes.
 * Empty values stay last in either direction; equal values retain input order.
 * Callers supply timestamps, task titles, names and sorted tag names,
 * never formatted relative dates or rendered React nodes.
 */
export function sortTaskListItems<T, Column extends TaskListOrder["column"]>(items: readonly T[], sort: TaskListSort<Column>, value: (item: T, column: Column) => TaskListSortValue): T[] {
  return [...items].sort((a, b) => {
    const left = value(a, sort.column);
    const right = value(b, sort.column);
    const leftMissing = left == null || left === "" || (typeof left === "number" && !Number.isFinite(left));
    const rightMissing = right == null || right === "" || (typeof right === "number" && !Number.isFinite(right));
    if (leftMissing || rightMissing) return Number(leftMissing) - Number(rightMissing);
    const result = typeof left === "number" && typeof right === "number"
      ? left - right
      : collator.compare(String(left), String(right));
    return sort.direction === "ascending" ? result : -result;
  });
}

const issueSortFieldByColumn = {
  task: "title", lastUpdated: "updated", taskId: "taskId", createdBy: "createdBy",
  assignee: "assignee", project: "project", parentTask: "parentTask", tags: "tags",
  worktree: "worktree", created: "created", status: "status", priority: "priority", workflow: "workflow",
} as const satisfies Record<TaskListOrder["column"], IssueSortField>;

export function isTaskListColumnSort(sort: TaskListOrder): sort is TaskListSort {
  return allTaskListColumns.some(column => column === sort.column);
}

export function taskListOrderToIssueSort(sort: TaskListOrder): IssueSort {
  return { sortField: issueSortFieldByColumn[sort.column], sortDir: sort.direction === "ascending" ? "asc" : "desc" };
}

/** Read shared links even when the selected field has no visible table column. */
export function readTaskListSortParams(params: URLSearchParams): TaskListOrder | undefined {
  const sort = readIssueSortParams(params);
  if (!sort) return undefined;
  const column = (Object.keys(issueSortFieldByColumn) as TaskListOrder["column"][])
    .find(column => issueSortFieldByColumn[column] === sort.sortField);
  if (!column) return undefined;
  return {
    column,
    direction: sort.sortDir === "asc" ? "ascending" : "descending",
  };
}
