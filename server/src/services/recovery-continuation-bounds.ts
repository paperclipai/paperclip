/**
 * How long a recorded recovery continuation may wait for delivery. One module
 * owns both numbers so delivery, wake admission and the assigned-work
 * invariant agree on when a pending continuation stops being the task's path.
 */

/** Delivery pacing holds a continuation back at most this long: past it the
 * delivery worker admits it even when the agent's queue is full or another
 * recovery run of the agent is queued. */
export const RECOVERY_CONTINUATION_MAX_HOLD_MS = 5 * 60_000;

/** A continuation still pending past this bound (the hold bound plus 2 minutes
 * of 15-second delivery passes) is not going to be delivered: the invariant no
 * longer counts it as pending, and wake admission no longer coalesces a repair
 * wake into it, so that wake becomes the task's one successor. Delivery
 * re-drives first, so within the bound there is exactly one owner. */
export const PENDING_CONTINUATION_BOUND_MS = RECOVERY_CONTINUATION_MAX_HOLD_MS + 2 * 60_000;
