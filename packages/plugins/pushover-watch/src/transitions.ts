import type { CachedIssueState } from "./config-schema.js";

export function matchesT1(
  prev: CachedIssueState,
  next: CachedIssueState,
  topAgentIds: string[],
): boolean {
  if (next.status !== "done") return false;
  if (prev.status === "done") return false;
  if (!next.assigneeAgentId) return false;
  return topAgentIds.includes(next.assigneeAgentId);
}

export function matchesT2(
  prev: CachedIssueState,
  next: CachedIssueState,
  boardUserId: string,
): boolean {
  if (next.status !== "in_review") return false;
  if (prev.status === "in_review") return false;
  return next.assigneeUserId === boardUserId;
}

export function matchesT3(
  prev: CachedIssueState,
  next: CachedIssueState,
): boolean {
  if (next.status !== "blocked") return false;
  if (prev.status === "blocked") return false;
  return true;
}
