import type { AttentionAudienceReason, AttentionReceiptOutcome, AttentionStaleReason } from "./types/attention.js";

/**
 * The "Why me?" line for each audience reason (PAP-749 plan §1, Rule 4). The UI
 * renders this from `AttentionItem.audience.reason`; `none` has no line because
 * the card is not addressed to anyone. Exhaustive on purpose, so a new reason
 * cannot ship without its copy.
 */
export const ATTENTION_AUDIENCE_REASON_TEXT: Record<AttentionAudienceReason, string | null> = {
  addressee: "Sent to you",
  conversation: "You started this chat",
  reviewer: "You are the reviewer",
  assignee: "Assigned to you",
  instigator: "You created the original task",
  requester: "You requested this",
  // Escalation owners (Rule 2 step 5): the project's decision owner comes
  // before the company's default decision owner; the budget owner gets budget
  // hard stops.
  escalation_owner: "You are the default decision owner",
  project_owner: "You own this project's decisions",
  budget_owner: "You own budget escalation",
  none: null,
};

export function attentionAudienceReasonText(reason: AttentionAudienceReason): string | null {
  return ATTENTION_AUDIENCE_REASON_TEXT[reason];
}

/**
 * The Stale chip text for each stale reason (PAP-749 plan §2, Rule 10, and the
 * 7-day Unassigned rule). Exhaustive on purpose, like the "Why me?" copy.
 */
export const ATTENTION_STALE_REASON_TEXT: Record<AttentionStaleReason, string> = {
  issue_closed: "Task closed",
  aged: "Waiting 30+ days",
  decision_expiring: "Expires soon",
  unowned: "No owner for 7+ days",
};

export function attentionStaleReasonText(reason: AttentionStaleReason): string {
  return ATTENTION_STALE_REASON_TEXT[reason];
}

/**
 * The verb of each action (PAP-749 plan §6, Rule 12). Receipts and Decision
 * history rows both read it, so one action has one verb everywhere (PAP-767).
 * The verbs follow the card's buttons: Approve, Request changes (Reject or
 * Revise… on a confirmation), Keep paused, Raise limit. Exhaustive, like the
 * copy above.
 */
export const ATTENTION_RECEIPT_OUTCOME_TEXT: Record<AttentionReceiptOutcome, string> = {
  answered: "Answered",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
  revision_requested: "Revision requested",
  decided: "Decided",
  withdrawn: "Withdrawn",
  skipped: "Skipped",
  transferred: "Transferred",
  kept_paused: "Kept paused",
  limit_raised: "Limit raised",
};

/**
 * "Answered by @scott", "Withdrawn by @scott", "Transferred to @riley by
 * @scott". Labels are display names without the `@`.
 */
export function attentionReceiptText(input: {
  outcome: AttentionReceiptOutcome;
  actorLabel: string;
  transferredToLabel?: string | null;
}): string {
  const verb = ATTENTION_RECEIPT_OUTCOME_TEXT[input.outcome];
  if (input.outcome === "transferred" && input.transferredToLabel) {
    return `${verb} to @${input.transferredToLabel} by @${input.actorLabel}`;
  }
  return `${verb} by @${input.actorLabel}`;
}
