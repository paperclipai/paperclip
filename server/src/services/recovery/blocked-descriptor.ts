import type { IssueUnblockDescriptor } from "@paperclipai/shared";

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
