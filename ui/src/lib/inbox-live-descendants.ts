import type { Issue, IssueBlockerAttention } from "@paperclipai/shared";

function normalizeLiveDescendantCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function asBlockerAttention(value: unknown): IssueBlockerAttention | null {
  if (!value || typeof value !== "object") return null;
  const attention = value as Partial<IssueBlockerAttention>;
  return typeof attention.state === "string" ? attention as IssueBlockerAttention : null;
}

export function resolveIssueLiveDescendantCount(
  issue: Pick<Issue, "liveDescendantCount">,
  loadedSubtreeLiveCount = 0,
): number {
  return Math.max(
    normalizeLiveDescendantCount(issue.liveDescendantCount),
    normalizeLiveDescendantCount(loadedSubtreeLiveCount),
  );
}

/** Navigation counts include review activity and cannot establish business coverage. */
export function resolveInboxIssueBlockerAttention(
  issue: Pick<Issue, "blockerAttention">,
): IssueBlockerAttention | null {
  return asBlockerAttention(issue.blockerAttention);
}
