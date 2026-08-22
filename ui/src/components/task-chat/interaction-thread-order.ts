import type { IssueThreadInteraction } from "@/lib/issue-thread-interactions";

/**
 * Thread-ordering + visibility rules for issue-thread interaction cards
 * (PAP-416, Phase A of PAP-412).
 *
 * Two problems this fixes:
 *
 *  1. Cards were pinned to `createdAt`, but the user answers them later and the
 *     agent's follow-up lands later still — so a card you just resolved could
 *     sit ABOVE a message written before you answered, reading backwards. We
 *     settle a RESOLVED card at its resolution time (`resolvedAt`) so it never
 *     floats above an earlier message. Pending cards stay where they were asked.
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

function toMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The chronological slot for an interaction card.
 *
 * `fallbackMs` is the caller's existing anchor (the same-run handoff shift when
 * present, else `createdAt`). A resolved card re-anchors to its resolution time
 * so it lands next to the answer, never above an earlier message; we take the
 * later of the two so clock skew can't drag it back above its own request. A
 * still-pending card keeps the request-time slot.
 */
export function interactionThreadAnchorMs(
  interaction: IssueThreadInteraction,
  fallbackMs: number,
): number {
  if (interaction.status === "pending") return fallbackMs;
  const resolvedMs = toMs(interaction.resolvedAt);
  return resolvedMs > 0 ? Math.max(resolvedMs, fallbackMs) : fallbackMs;
}
