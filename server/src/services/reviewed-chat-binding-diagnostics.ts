export const REVIEWED_CHAT_BINDING_NOT_AUTHORIZED = "reviewed_chat_execution_binding_not_authorized";

/**
 * The first reviewed-chat attestation check that denied a run. Closed labels
 * only: the run result and its failure report never carry IDs or message text.
 */
const reasons = [
  "binding_missing", "issue_status", "assignee_mismatch", "owner_mismatch",
  "run_not_running", "native_issue_mismatch", "agent_not_invokable",
  "context_mismatch", "question_response_missing",
  "binding_denied", "destination_denied", "principal_denied",
] as const;

export type ReviewedChatBindingDenialReason = typeof reasons[number];

export function isReviewedChatBindingDenialReason(value: unknown): value is ReviewedChatBindingDenialReason {
  return reasons.some((reason) => reason === value);
}

/** Keeps the established run error text while carrying the denied check. */
export class ReviewedChatBindingDeniedError extends Error {
  readonly code = REVIEWED_CHAT_BINDING_NOT_AUTHORIZED;

  constructor(readonly denialReason: ReviewedChatBindingDenialReason | null) {
    super(REVIEWED_CHAT_BINDING_NOT_AUTHORIZED);
  }
}

export function reviewedChatBindingDenialResultJson(error: unknown) {
  return error instanceof ReviewedChatBindingDeniedError && error.denialReason
    ? { reviewedChatBinding: { denialReason: error.denialReason } }
    : {};
}

export function readReviewedChatBindingDenialReason(value: unknown): ReviewedChatBindingDenialReason | null {
  if (!value || typeof value !== "object") return null;
  try {
    const reason = (value as Record<string, unknown>).denialReason;
    return isReviewedChatBindingDenialReason(reason) ? reason : null;
  } catch {
    return null;
  }
}
