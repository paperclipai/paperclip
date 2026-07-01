/**
 * BUD-717: guard against the source_scoped_recovery_action churn loop.
 *
 * The recovery service can transition an issue to `blocked` even when the
 * source run succeeded, the issue has no first-class blockers, and the
 * issue is not in review. That flip wakes the assignee, who sees no real
 * blockers, PATCHes the issue back to `in_progress`, and the loop repeats
 * on the next heartbeat that observes the source-success state.
 *
 * This module isolates the decision so it can be unit-tested without DB
 * mocks and reasoned about in one place.
 */

export type SuppressionDecisionInput = {
  /**
   * Unresolved `blocks` relations pointing at the issue. Empty means there
   * is no first-class blocker path to recover.
   */
  blockerIds: readonly string[];
  /**
   * Current issue status. The guard only suppresses when the issue is
   * neither in `blocked` (already a blocker path) nor in `in_review`
   * (a reviewer is the consumer — flipping to blocked would change the
   * effective unblock work).
   */
  status: string;
  /**
   * Status of the most recent heartbeat run. The guard is only safe to
   * apply when the source run actually succeeded; if the run is still
   * active or failed in a retryable way, the existing escalation path
   * must keep running.
   */
  latestRunStatus: string | null | undefined;
};

/**
 * Returns true when the `in_progress -> blocked` transition (and the
 * recovery wake that follows it) would not change effective unblock work
 * and is therefore the churn pattern BUD-490 / BUD-710 / BUD-717 observed.
 *
 * Equivalent in effect to the issue's "PR armed for auto-merge" check —
 * the recovery target's blocker graph is empty, so the transition target
 * would not change the next action a human or agent needs to take.
 */
export function shouldSuppressSpuriousBlockedTransition(
  input: SuppressionDecisionInput,
): boolean {
  if (input.blockerIds.length > 0) return false;
  if (input.status === "blocked" || input.status === "in_review") return false;
  if (input.latestRunStatus !== "succeeded") return false;
  return true;
}
