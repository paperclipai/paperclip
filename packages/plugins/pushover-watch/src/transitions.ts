import type { CachedIssueState } from "./config-schema.js";

export function matchesT1(
  prev: CachedIssueState | null,
  next: CachedIssueState,
  topAgentIds: string[],
): boolean {
  if (next.status !== "done") return false;
  if (prev?.status === "done") return false;
  if (!next.assigneeAgentId) return false;
  return topAgentIds.includes(next.assigneeAgentId);
}

export function matchesT2(
  prev: CachedIssueState | null,
  next: CachedIssueState,
  boardUserId: string,
): boolean {
  if (next.status !== "in_review") return false;
  if (prev?.status === "in_review") return false;
  return next.assigneeUserId === boardUserId;
}

export function matchesT3(
  prev: CachedIssueState | null,
  next: CachedIssueState,
): boolean {
  if (next.status !== "blocked") return false;
  if (prev?.status === "blocked") return false;
  return true;
}

export type T6Status = "done" | "in_review" | "blocked";

export function matchesT6(
  prev: CachedIssueState | null,
  next: CachedIssueState,
  secretaryAgentIds: string[],
): T6Status | null {
  if (secretaryAgentIds.length === 0) return null;
  if (prev?.status === next.status) return null;
  if (next.status !== "done" && next.status !== "in_review" && next.status !== "blocked") {
    return null;
  }
  const wasSecretary =
    !!prev?.assigneeAgentId && secretaryAgentIds.includes(prev.assigneeAgentId);
  const isSecretary =
    !!next.assigneeAgentId && secretaryAgentIds.includes(next.assigneeAgentId);
  if (!wasSecretary && !isSecretary) return null;
  return next.status;
}
