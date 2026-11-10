/**
 * CRE-4176: a routine-execution issue only ever reaches `blocked` through one
 * of two paths. A human PATCH goes through routes/issues.ts, which rejects
 * `status: "blocked"` unless the body also carries an unresolved blocker, a
 * pending interaction/approval, or an `unblockDescriptor` ("Entering blocked
 * requires unresolved blockers, a pending interaction/approval, or
 * unblockDescriptor"). An internal service call — recovery's
 * HUMAN_GATED_RECOVERY_CAUSES settle, wake-queue reconciliation, native
 * continuation recovery — bypasses that check entirely and can leave `blocked`
 * with none of the three. Recovery's own comment on that shape calls it
 * exactly what it is: "a hold with no blocker and no unblock descriptor —
 * clearable by nothing."
 *
 * CRE-4157 made any open routine-execution issue count as permanently
 * outstanding for the routine's concurrency guard, which is correct for a
 * genuine hold and wrong for this one: nothing is ever going to clear a hold
 * with no blocker, no descriptor, and no human-facing reason attached, so the
 * routine it belongs to goes dark forever. This module is the discriminator
 * between "a human (or a product-recognized wait) is genuinely holding this"
 * and "platform orchestration parked it and nothing is coming back."
 */
export const ROUTINE_CORPSE_REAP_MIN_CONSECUTIVE_TICKS = 3;

export interface ReapableBlockedIssueCandidate {
  status: string;
  unblockDescriptor: unknown;
}

/**
 * The first half of the discriminator: does this blocked issue carry ANY of
 * the three pieces of evidence the product itself requires before a human
 * PATCH may enter `blocked`? If so, it is explicable — a human (or a flow the
 * product recognizes) is holding it on purpose, and CRE-4157's suppression is
 * correct. Unresolved blockers, pending interactions, and pending approvals
 * are checked separately (they need a DB read); this only covers the one
 * piece of evidence already present on the issue row.
 */
export function isUnexplainedBlockedIssue(issue: ReapableBlockedIssueCandidate): boolean {
  if (issue.status !== "blocked") return false;
  return !issue.unblockDescriptor;
}

/**
 * The second half: has this exact issue been the only thing the routine's
 * last `minConsecutiveTicks` dispatch attempts could point to? Expressed in
 * ticks of the routine's own cadence rather than wall-clock time, so it needs
 * no cron parsing and self-calibrates to however often the routine actually
 * fires — a routine that fires hourly reaps a stale corpse in hours, one that
 * fires weekly takes weeks, with the same threshold either way.
 *
 * `recentLinkedIssueIds` must be ordered most-recent-first and must exclude
 * the run being dispatched right now (its `linkedIssueId` is not set yet).
 * Fewer than `minConsecutiveTicks` prior runs is not stale by construction —
 * a routine that has not fired enough times yet gets the benefit of the
 * doubt rather than being read as satisfying a `.every()` over an empty or
 * short slice.
 */
export function isStaleAcrossConsecutiveTicks(
  recentLinkedIssueIds: readonly (string | null)[],
  candidateIssueId: string,
  minConsecutiveTicks: number = ROUTINE_CORPSE_REAP_MIN_CONSECUTIVE_TICKS,
): boolean {
  if (recentLinkedIssueIds.length < minConsecutiveTicks) return false;
  return recentLinkedIssueIds
    .slice(0, minConsecutiveTicks)
    .every((linkedIssueId) => linkedIssueId === candidateIssueId);
}

export const ROUTINE_EXECUTION_CORPSE_REAP_COMMENT_TITLE = "Stale firing cancelled";

export function buildRoutineExecutionCorpseReapComment(input: {
  minConsecutiveTicks: number;
}): string {
  return (
    "Paperclip cancelled this execution issue automatically. It has been `blocked` with no unresolved " +
    "blocker, no pending interaction or approval, no `unblockDescriptor`, and no live run still watching " +
    `it, across the routine's last ${input.minConsecutiveTicks} firings. That shape only happens when ` +
    "platform recovery parks a firing nobody will ever return to (CRE-4176) — left in place, the routine's " +
    "own concurrency guard (CRE-4157) would treat it as permanently outstanding and the routine would never " +
    "fire again. A fresh execution issue will be dispatched on the next trigger. If this firing's underlying " +
    "work still matters, it is preserved here, cancelled, for inspection — nothing was replayed."
  );
}
