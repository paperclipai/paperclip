import type { Issue, IssueBlockerAttention } from "@paperclipai/shared";

type InboxLiveDescendantIssue = Pick<Issue, "status" | "blockerAttention" | "liveDescendantCount">;

interface InboxLiveDescendantOptions {
  isLive: boolean;
  loadedSubtreeLiveCount?: number;
}

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

export function resolveInboxIssueBlockerAttention(
  issue: InboxLiveDescendantIssue,
  options: InboxLiveDescendantOptions,
): IssueBlockerAttention | null {
  const blockerAttention = asBlockerAttention(issue.blockerAttention);
  if (issue.status !== "blocked" || options.isLive) return blockerAttention;
  if (blockerAttention?.state === "needs_attention" || blockerAttention?.state === "stalled") {
    return blockerAttention;
  }
  if (blockerAttention?.state === "covered") return blockerAttention;

  const liveDescendantCount = resolveIssueLiveDescendantCount(issue, options.loadedSubtreeLiveCount);
  if (liveDescendantCount <= 0) return blockerAttention;

  return {
    state: "covered",
    reason: "active_child",
    unresolvedBlockerCount: blockerAttention?.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: liveDescendantCount,
    stalledBlockerCount: blockerAttention?.stalledBlockerCount ?? 0,
    attentionBlockerCount: blockerAttention?.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: blockerAttention?.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: blockerAttention?.sampleStalledBlockerIdentifier ?? null,
  };
}
