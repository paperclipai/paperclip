import type { IssueThreadInteraction } from "@/lib/issue-thread-interactions";

/**
 * Thread-ordering + visibility rules for issue-thread interaction cards
 * (PAP-416, Phase A of PAP-412).
 *
 * Two problems this fixes:
 *
 *  1. Question receipts keep the request's original slot because a separate
 *     answer-delivery bubble records when those answers entered a successor
 *     run. A resolved confirmation is itself the user's decision receipt, so
 *     it moves to `resolvedAt` and separates the work before and after that
 *     decision.
 *
 *  2. Withdrawn / superseded confirmation cards lingered in the thread, stacking
 *     a dead card above the accepted one. We suppress those from the backbone
 *     entirely — a retracted or superseded confirmation is not a call to action
 *     and reads as noise next to the outcome that replaced it.
 */

// The confirmation-family kinds: cards that are a call to act on a proposal.
// ask_user_questions / suggest_tasks keep their superseded notices (legacy
// parity) — only confirmations get fully hidden when withdrawn/superseded.
const CONFIRMATION_KINDS = new Set([
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
]);

// Terminal outcomes that mean "this confirmation was retracted or replaced": it
// never got an accept/reject decision the reader needs to see. `withdrawn` is an
// agent/board retraction; the two `superseded_by_*` outcomes fire when a later
// comment or a fresh request took its place.
const SUPPRESSED_CONFIRMATION_OUTCOMES = new Set([
  "withdrawn",
  "superseded_by_comment",
  "superseded_by_newer_request",
]);

function interactionOutcome(interaction: IssueThreadInteraction): string | null {
  const result = interaction.result;
  return result && "outcome" in result && typeof result.outcome === "string"
    ? result.outcome
    : null;
}

/**
 * A confirmation card that was withdrawn or superseded — hide it from the thread
 * so it never stacks above the confirmation that replaced it.
 */
export function isSuppressedThreadInteraction(interaction: IssueThreadInteraction): boolean {
  // A secret proposal is also a terminal audit receipt: even when a newer
  // request superseded it, the safe source/target/path metadata and recovery
  // guidance must remain visible in the issue where the proposal happened.
  if (interaction.kind === "request_confirmation" && interaction.payload.secretProposal) {
    return false;
  }
  if (!CONFIRMATION_KINDS.has(interaction.kind)) return false;
  const outcome = interactionOutcome(interaction);
  return outcome != null && SUPPRESSED_CONFIRMATION_OUTCOMES.has(outcome);
}

/**
 * The chronological slot for an interaction card.
 *
 * `fallbackMs` is the caller's existing request anchor (the same-run handoff
 * shift when present, else `createdAt`). Pending confirmations and question
 * receipts keep that slot. Terminal confirmation-family receipts move to the
 * decision time, clamped so clock skew can never place them before the request.
 */
export function interactionThreadAnchorMs(
  interaction: IssueThreadInteraction,
  fallbackMs: number,
): number {
  if (
    interaction.status === "pending" ||
    !CONFIRMATION_KINDS.has(interaction.kind) ||
    !interaction.resolvedAt
  ) {
    return fallbackMs;
  }
  const resolvedAtMs =
    interaction.resolvedAt instanceof Date
      ? interaction.resolvedAt.getTime()
      : new Date(interaction.resolvedAt).getTime();
  return Number.isFinite(resolvedAtMs)
    ? Math.max(fallbackMs, resolvedAtMs)
    : fallbackMs;
}
