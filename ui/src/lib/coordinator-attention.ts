import type { AttentionItem, AttentionPersonalView, DecisionHistoryItem } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";

/**
 * The pending feed for one person and one view (PAP-749 plan §1). The key
 * holds the user, so switching accounts never shows the previous person's
 * cached list. The "For you" key is shared by the page, the sidebar, the mobile
 * navigation and the Tasks filter, so the badge always agrees with the list.
 */
export const coordinatorAttentionQueryKey = (companyId: string, userId: string | null, view: AttentionPersonalView) =>
  [...queryKeys.attention(companyId), userId, view, "coordinator", "pending"] as const;

/** Presentation-only assumption from the prototype, never a retention policy. */
export const COORDINATOR_RECENT_DECISION_MS = 24 * 60 * 60 * 1_000;
export function recentDecisionReceipts(items: DecisionHistoryItem[], now: number) {
  return items.filter((item) => Date.parse(item.resolvedAt) + COORDINATOR_RECENT_DECISION_MS > now);
}

/** One canonical pending feed, projected as distinct tasks on the Tasks surface. */
export function pendingDecisionTaskIds(items: AttentionItem[]) {
  return new Set(items.flatMap((item) => item.relatedIssue ? [item.relatedIssue.id] : item.subject.kind === "issue" ? [item.subject.id] : []));
}
