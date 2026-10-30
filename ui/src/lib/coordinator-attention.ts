import type { AttentionItem, DecisionHistoryItem } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

export const coordinatorAttentionQueryKey = (companyId: string) => [...queryKeys.attention(companyId), "coordinator", "pending"] as const;

/** Presentation-only assumption from the prototype, never a retention policy. */
export const COORDINATOR_RECENT_DECISION_MS = 24 * 60 * 60 * 1_000;
export function recentDecisionReceipts(items: DecisionHistoryItem[], now: number) {
  return items.filter((item) => Date.parse(item.resolvedAt) + COORDINATOR_RECENT_DECISION_MS > now);
}

/** One canonical pending feed, projected as distinct tasks on the Tasks surface. */
export function pendingDecisionTaskIds(items: AttentionItem[]) {
  return new Set(items.flatMap((item) => item.relatedIssue ? [item.relatedIssue.id] : item.subject.kind === "issue" ? [item.subject.id] : []));
}
