import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { ROUTABLE_BLOCKED_ROLLOUT_AT } from "../routable-blocked.js";

/**
 * Recovery paths that create a `blocked` card must attach a board-owned
 * `unblockDescriptor`, otherwise the card is `blocked` with no blocker and no
 * descriptor: invisible to every view and owner queue, with nothing to wake it.
 *
 * But a path must never *displace* a block it did not create. If the issue
 * already carries a valid descriptor — in particular an agent- or user-owned
 * one — overwriting it with a board-owned descriptor severs the existing path to
 * whoever is already responsible: `deliverAgentUnblockNotification` only wakes
 * agent-owned descriptors, so the responsible agent silently stops being woken.
 *
 * Returns the descriptor to write, or `null` to leave the existing one intact.
 */
export function boardDescriptorForBlock(input: {
  existing: IssueUnblockDescriptor | null | undefined;
  action: string;
}): IssueUnblockDescriptor | null {
  const existing = input.existing;
  if (existing && existing.action.trim()) {
    // A real unblock path already exists. Keep its owner and its action.
    return null;
  }
  const action = input.action.trim();
  if (!action) return null;
  return { owner: "board", action } satisfies IssueUnblockDescriptor;
}

/**
 * Board attention only surfaces a `blocked` card whose `blockedTransitionAt` is
 * present and at or after {@link ROUTABLE_BLOCKED_ROLLOUT_AT}; see
 * `isProspectiveBlockedTransition`. `issuesSvc.update` stamps that column only
 * on a real `not blocked -> blocked` transition, so a card that is *already*
 * `blocked` with a null or pre-rollout timestamp keeps it. That is exactly what
 * the pre-KEE-250 recovery paths produced: a card holding a valid descriptor
 * that is still invisible to every view. Recovery repairs the timestamp so the
 * descriptor it just ensured is actually observable.
 *
 * Returns the timestamp to write, or `null` to leave the existing value.
 */
export function repairedBlockedTransitionAt(input: {
  status: string;
  blockedTransitionAt: Date | null | undefined;
  now: Date;
}): Date | null {
  if (input.status !== "blocked") return null;
  if (!input.blockedTransitionAt || input.blockedTransitionAt < ROUTABLE_BLOCKED_ROLLOUT_AT) {
    return input.now;
  }
  return null;
}
