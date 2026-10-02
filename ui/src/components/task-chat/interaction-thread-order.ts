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
 *  2. Withdrawn confirmations are suppressed. Superseded confirmations remain
 *     compact, read-only receipts so readers can follow what replaced them.
 */

// The confirmation-family kinds: cards that are a call to act on a proposal.
// Only withdrawn confirmations are hidden; replacements retain their receipts.
const CONFIRMATION_KINDS = new Set([
  "request_confirmation",
  "request_checkbox_confirmation",
  "request_item_verdicts",
]);

// Explicit retractions stay suppressed. A replacement is useful audit history.
const SUPPRESSED_CONFIRMATION_OUTCOMES = new Set([
  "withdrawn",
]);

function interactionOutcome(interaction: IssueThreadInteraction): string | null {
  const result = interaction.result;
  return result && "outcome" in result && typeof result.outcome === "string"
    ? result.outcome
    : null;
}

/**
 * Hide explicit withdrawals; keep replaced confirmations as terminal receipts.
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
