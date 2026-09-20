import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export const BLOCKED_WITHOUT_WAKE_PATH_ACTION =
  "Inspect the run evidence, then restore a live execution path, retry or reassign the owner, or record an intentional resolution.";

/**
 * Entering `blocked` is only a valid disposition when the issue keeps a
 * first-class wake path: unresolved `blockedBy` blockers, a pending
 * interaction/approval, or an `unblockDescriptor` that names the unblock owner.
 *
 * The `PATCH /api/issues/:id` route enforces that invariant, but automatic
 * recovery transitions write `status: "blocked"` straight through the issue
 * service, which does not. A failed run then lands the issue in `blocked` with
 * `blockedBy`, monitor, interaction, and owner all empty — a silent dead end
 * that neither wakes an agent nor surfaces on the board.
 *
 * This derives the descriptor those automatic transitions must persist. It
 * returns `null` when an existing wake path already covers the transition
 * (unresolved blockers), so callers can spread it conditionally.
 */
export function resolveAutoBlockedUnblockDescriptor(input: {
  blockerIssueIds: readonly string[];
  ownerAgentId?: string | null;
  action?: string | null;
}): IssueUnblockDescriptor | null {
  if (input.blockerIssueIds.length > 0) return null;
  const action = input.action?.trim() || BLOCKED_WITHOUT_WAKE_PATH_ACTION;
  if (input.ownerAgentId) {
    return { owner: { agentId: input.ownerAgentId }, action };
  }
  return { owner: "board", action };
}
