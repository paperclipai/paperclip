/** Ordered columns and token references shared by the proposed header and rows. */
export const taskListColumns = [
  { id: "task", label: "Task", width: "var(--task-list-column-task)" },
  { id: "taskId", label: "Task ID", width: "var(--task-list-column-task-id)" },
  { id: "createdBy", label: "Created by", width: "var(--task-list-column-created-by)" },
  { id: "assignee", label: "Assignee", width: "var(--task-list-column-assignee)" },
  { id: "project", label: "Project", width: "var(--task-list-column-project)" },
  { id: "parentTask", label: "Parent Task", width: "var(--task-list-column-parent)" },
  { id: "tags", label: "Tags", width: "var(--task-list-column-tags)" },
  { id: "worktree", label: "Worktree", width: "var(--task-list-column-worktree)" },
  { id: "lastUpdated", label: "Last updated", width: "var(--task-list-column-updated)" },
] as const;

export type TaskListColumnId = (typeof taskListColumns)[number]["id"];
export type TaskListSort = { column: TaskListColumnId; direction: "ascending" | "descending" };
export type TaskListSortValue = string | number | null | undefined;
export const allTaskListColumns: readonly TaskListColumnId[] = taskListColumns.map(column => column.id);
export const defaultTaskListColumns: readonly TaskListColumnId[] = ["task", "taskId", "lastUpdated"];
export const defaultTaskListSort: TaskListSort = { column: "taskId", direction: "ascending" };

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
export function sortTaskListItems<T>(items: readonly T[], sort: TaskListSort, value: (item: T, column: TaskListColumnId) => TaskListSortValue): T[] {
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
