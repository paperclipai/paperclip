/**
 * In-review evidence gate (narrated-review hardening).
 *
 * Pure predicate: should a transition to `in_review` be blocked because the
 * evidence gate found nothing reviewable?
 *
 * Companion to `done-gate.ts` (narrated-done) covering the earlier hop in the
 * same failure mode: an agent with a real execution run does analysis-only
 * work, posts narrative, and flips the issue to `in_review` with no PR, no
 * branch, and no commits — there is nothing to review. The done-gate's
 * `executionRunId == null` check cannot catch this (the run was real); the
 * discriminator is the evidence verdict computed at the in_review transition.
 *
 * Guarded so it never blocks:
 *  - non-`in_review` transitions,
 *  - no-op `in_review` -> `in_review`,
 *  - human actors (only agent transitions are gated),
 *  - a `pass` verdict (every required evidence shape detected),
 *  - a missing verdict (gate evaluation failed; a broken evaluator must not
 *    freeze the board — parity with the evaluation try/catch in issues.ts).
 *
 * Wired behind the instance flag `enableInReviewEvidenceGate` (default off).
 * The flag check lives at the call-site so this predicate stays pure.
 */

export interface InReviewGateInput {
  /** The issue's current (pre-update) status. */
  fromStatus: string;
  /** The requested next status (undefined when the patch doesn't change status). */
  toStatus: string | undefined;
  /** True when the transition is driven by an agent (not a human). */
  isAgentActor: boolean;
  /**
   * The evidence verdict computed for THIS transition (not the stored
   * lastEvidenceVerdict), or null when evaluation failed.
   */
  verdict: { verdict: string } | null;
}

export function shouldBlockUnreviewableInReview(input: InReviewGateInput): boolean {
  if (input.toStatus !== "in_review") return false;
  if (input.fromStatus === "in_review") return false;
  if (!input.isAgentActor) return false;
  if (input.verdict == null) return false;
  return input.verdict.verdict !== "pass";
}
