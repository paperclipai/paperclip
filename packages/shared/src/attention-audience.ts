import type { AttentionAudienceReason } from "./types/attention.js";

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
  // Task 1d-lite: the company's default decision owner is the only escalation
  // owner so far. Task 1d adds project and budget owners with their own reasons.
  escalation_owner: "You are the default decision owner",
  none: null,
};

export function attentionAudienceReasonText(reason: AttentionAudienceReason): string | null {
  return ATTENTION_AUDIENCE_REASON_TEXT[reason];
}
