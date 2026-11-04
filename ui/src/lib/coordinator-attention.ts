import { attentionReceiptText, type AttentionItem, type AttentionPersonalView, type DecisionHistoryItem, type DecisionHistoryOutcomeFilter, type DecisionHistoryScope } from "@paperclipai/shared";
import { queryKeys } from "./queryKeys";
import { isInlineResolvable } from "./attention";

/**
 * The pending feed for one person and one view (PAP-749 plan §1). The key
 * holds the user, so switching accounts never shows the previous person's
 * cached list. The "For you" key is shared by the page, the sidebar, the mobile
 * navigation and the Tasks filter, so the badge always agrees with the list.
 */
export const coordinatorAttentionQueryKey = (companyId: string, userId: string | null, view: AttentionPersonalView) =>
  [...queryKeys.attention(companyId), userId, view, "coordinator", "pending"] as const;

/**
 * The title a Needs You card leads with, so a list of cards (the Withdraw all
 * stale confirmation) names each one the way the card does (PAP-767). An
 * inline interaction or stalled review card renders its own resolver, and its
 * task link names it; every other card has a heading.
 */
export function coordinatorCardTitle(item: AttentionItem) {
  const task = item.relatedIssue ?? (item.subject.kind === "issue" ? item.subject : null);
  const inline = isInlineResolvable(item)
    && (item.sourceKind === "issue_thread_interaction"
      || (item.sourceKind === "review" && item.subject.kind === "issue" && item.subject.metadata?.reviewAttentionState === "stalled"));
  if (inline && task?.title) return task.title;
  return coordinatorCardAsk(item, task?.title ?? null) ?? item.subject.title ?? item.whyNow;
}

/**
 * Focus (PAP-770): a card's heading says what to do. Some sources are titled
 * with the bare task or agent name ("Today's weather forecast", "Chief of
 * Staff"), which repeats the task link and asks nothing; those get an ask.
 */
function coordinatorCardAsk(item: AttentionItem, taskTitle: string | null): string | null {
  const title = item.subject.title?.trim() || null;
  if (item.sourceKind === "blocker_attention" && title) return `Get “${title}” moving again`;
  if (item.sourceKind === "agent_error_alert") {
    const agent = item.detail?.kind === "agent_error" ? item.detail.agentName ?? title : title;
    return agent ? `${agent} hit an error and needs help` : null;
  }
  if (item.sourceKind === "review" && title && title === taskTitle) return `Review “${title}”`;
  return null;
}

/** The context under a card's heading: what happened and what you can do about it. */
export function coordinatorCardDetail(item: AttentionItem, detailLine: string | null): string | null {
  if (item.sourceKind === "blocker_attention" && item.detail?.kind === "blocker" && !item.detail.blockingIssue) {
    const count = item.detail.blockedTaskCount ?? 0;
    const holding = count > 0 ? `It's holding up ${count} ${count === 1 ? "task" : "tasks"}, and no` : "No";
    return `${holding} one is working on it. Unblock it, reassign it, or nudge its owner.`;
  }
  return detailLine ?? item.whyNow;
}

/** Presentation-only assumption from the prototype, never a retention policy. */
export const COORDINATOR_RECENT_DECISION_MS = 24 * 60 * 60 * 1_000;
export function recentDecisionReceipts(items: DecisionHistoryItem[], now: number) {
  return items.filter((item) => Date.parse(item.resolvedAt) + COORDINATOR_RECENT_DECISION_MS > now);
}

/** One canonical pending feed, projected as distinct tasks on the Tasks surface. */
export function pendingDecisionTaskIds(items: AttentionItem[]) {
  return new Set(items.flatMap((item) => item.relatedIssue ? [item.relatedIssue.id] : item.subject.kind === "issue" ? [item.subject.id] : []));
}

/**
 * The Decision history outcome filter (PAP-749 plan §3). Withdrawn, Expired and
 * Closed with task are separate: a card that closed with its task is not in
 * Expired. "Handled for me" is a different filter (who the card was for), so
 * it is not an outcome here.
 */
export const DECISION_HISTORY_OUTCOME_OPTIONS: ReadonlyArray<{ value: DecisionHistoryOutcomeFilter; label: string }> = [
  { value: "accepted", label: "Approved" },
  { value: "answered", label: "Answered" },
  { value: "rejected", label: "Changes requested" },
  { value: "decided", label: "Decided" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "expired", label: "Expired" },
  { value: "issue_closed", label: "Closed with task" },
  { value: "cancelled", label: "Cancelled" },
];

/**
 * Whose decisions Decision history and Recent Decisions list (PAP-768). Your
 * own is the default: what you answered, withdrew or transferred, what a
 * different person handled for you, and the cards that were for you.
 */
export const DECISION_HISTORY_SCOPE_OPTIONS: ReadonlyArray<{ value: DecisionHistoryScope; label: string }> = [
  { value: "mine", label: "Handled by me or for me" },
  { value: "all", label: "Everyone" },
];
export const DEFAULT_DECISION_HISTORY_SCOPE: DecisionHistoryScope = "mine";

/**
 * A history entry's headline. When a person acted, it names them with the
 * receipt's verb for the same action ("Approved by @scott", "Kept paused by
 * @dotta"; PAP-749 plan §3, PAP-767). A decision adds the option chosen and an
 * item review its verdict counts. Everything else keeps the server's label.
 */
export function decisionHistoryHeadline(item: DecisionHistoryItem, userLabelMap?: ReadonlyMap<string, string> | null) {
  const actorLabel = item.resolvedByUserId ? userLabelMap?.get(item.resolvedByUserId) ?? "someone" : null;
  if (item.action && actorLabel) {
    const line = attentionReceiptText({ outcome: item.action.outcome, actorLabel });
    return item.action.detail ? `${line}: ${item.action.detail}` : line;
  }
  if (item.resultOutcome === "withdrawn" && actorLabel) return `Withdrawn by @${actorLabel}`;
  return item.label;
}

/** The task line of a history entry; an approval with no task names itself instead. */
export function decisionHistoryContext(item: DecisionHistoryItem) {
  if (!item.issueId) return item.sourceKind === "approval" ? `Approval · ${item.title}` : item.title;
  return [item.issueIdentifier, item.issueTitle].filter(Boolean).join(" · ");
}
