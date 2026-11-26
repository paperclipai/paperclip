import type { Issue } from "@paperclipai/shared";

export const taskListViews = [
  { value: "inbox", label: "Inbox" },
  { value: "unread", label: "Unread" },
  { value: "blocked", label: "Needs attention" },
  { value: "all", label: "All tasks" },
] as const;

export type TaskListView = typeof taskListViews[number]["value"];
type ViewIssue = Pick<Issue, "createdByUserId" | "assigneeUserId" | "status">;

/** Apply within the current company's accessible tasks; ancestors are added separately. */
export function matchesTaskListView(view: TaskListView, issue: ViewIssue, unread: boolean, userId: string | null): boolean {
  switch (view) {
    case "inbox": return Boolean(userId && (issue.createdByUserId === userId || issue.assigneeUserId === userId));
    case "unread": return unread;
    case "blocked": return issue.status === "blocked" || issue.status === "in_review";
    case "all": return true;
  }
}

export function taskListViewStorageKey(scope: string, userId: string): string {
  return `paperclip:task-list-view:v1:${encodeURIComponent(scope)}:${encodeURIComponent(userId)}`;
}

type ViewStorage = Pick<Storage, "getItem" | "setItem">;
function browserStorage(): ViewStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadTaskListView(key: string, storage: ViewStorage | null = browserStorage()): TaskListView {
  try {
    const value = storage?.getItem(key);
    return taskListViews.find(option => option.value === value)?.value ?? "all";
  } catch {
    return "all";
  }
}

export function saveTaskListView(key: string, view: TaskListView, storage: ViewStorage | null = browserStorage()): void {
  try {
    storage?.setItem(key, view);
  } catch {
    // Storage denial must not prevent changing the current view.
  }
}
