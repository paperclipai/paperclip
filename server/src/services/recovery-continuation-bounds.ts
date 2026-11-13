/**
 * How long a recorded recovery continuation may wait for delivery. One module
 * owns both numbers so delivery and the assigned-work invariant agree. Wake
 * admission never replaces a recorded continuation (it alone carries the
 * isolation decision); a wake coalesced into it re-drives delivery.
 */

/** Delivery pacing holds a continuation back at most this long: past it the
 * delivery worker admits it even when the agent's queue is full or another
 * recovery run of the agent is queued. */
export const RECOVERY_CONTINUATION_MAX_HOLD_MS = 5 * 60_000;

/** A continuation still pending past this bound (the hold bound plus 2 minutes
 * of 15-second delivery passes) is stuck: the invariant no longer counts it as
 * pending, so the sweep sends a repair wake. Admission coalesces that wake
 * into the record and notifies delivery, which re-drives the recorded
 * continuation itself (same record, isolation and fresh session). */
export const PENDING_CONTINUATION_BOUND_MS = RECOVERY_CONTINUATION_MAX_HOLD_MS + 2 * 60_000;
