import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@paperclipai/shared";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function includes(values: readonly string[], value: unknown): value is string {
  return typeof value === "string" && values.includes(value);
}

export function activityToastDetails(action: unknown, value: unknown): Record<string, unknown> {
  const details = record(value) ?? {};
  const result: Record<string, unknown> = {};
  if (details.source === "comment") result.source = "comment";
  if (details.reopened === true) {
    result.reopened = true;
    if (includes(ISSUE_STATUSES, details.reopenedFrom)) result.reopenedFrom = details.reopenedFrom;
  }
  if (action === "issue.comment_added") {
    if (typeof details.commentId === "string") result.commentId = details.commentId.slice(0, 64);
    if (typeof details.bodySnippet === "string") result.bodySnippet = Array.from(details.bodySnippet).slice(0, 240).join("");
  }
  if (action !== "issue.updated" && action !== "issue.comment_added") return result;
  const changes = record(details.changes);
  if (action === "issue.comment_added" && !changes) return result;
  const changed = (key: string) => changes ? Object.hasOwn(changes, key) : Object.hasOwn(details, key);
  const next = (key: string) => changes ? record(changes[key])?.to : details[key];
  if (changed("status") && includes(ISSUE_STATUSES, next("status"))) {
    result.status = next("status");
    const from = record(changes?.status)?.from;
    if (includes(ISSUE_STATUSES, from)) result.statusFrom = from;
  }
  if (changed("priority") && includes(ISSUE_PRIORITIES, next("priority"))) result.priority = next("priority");
  if (changed("assigneeAgentId") || changed("assigneeUserId")) {
    const assigned = ["assigneeAgentId", "assigneeUserId"].some(key => typeof next(key) === "string");
    result.assignment = assigned ? "reassigned" : "unassigned";
  }
  if (changed("title")) result.titleChanged = true;
  if (changed("description")) result.descriptionChanged = true;
  return result;
}
