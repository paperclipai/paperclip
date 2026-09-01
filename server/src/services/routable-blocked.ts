import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

type RoutableBlockedIssue = {
  id: string;
  status: string;
  assigneeAgentId?: string | null;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

/**
 * HIV-2811: an unblock descriptor whose owner is the issue's own assignee is an
 * address that resolves back to the sender. Waking on it asks the agent that
 * just blocked to perform the thing it has already reported it cannot do, so
 * the wake produces the same block, which produces the next wake.
 *
 * Measured 2026-09-01: LUN-1317 ran 40 times in under three hours, 38 of them
 * recorded `livenessState: blocked`; HIV-2719 ran 25 times in 30 minutes and,
 * being the only routine permitted to promote a finding to assigned work, held
 * 30 queued findings shut while it cycled. Both descriptors named the blocked
 * agent itself.
 *
 * Suppressing the wake does not strand the issue. It stays `blocked` and
 * board-visible, and every event-carrying wake still reaches it — a comment, a
 * resolved blocker, an interaction answer, an operator invoke. Only the
 * self-referential automation wake stops.
 *
 * Not the same as an agent naming itself when it is NOT the assignee: that is a
 * real cross-agent address and is delivered normally.
 */
export function isSelfAddressedUnblockDescriptor(issue: RoutableBlockedIssue): boolean {
  const owner = issue.unblockDescriptor?.owner;
  if (!owner || owner === "board" || !("agentId" in owner)) return false;
  return Boolean(issue.assigneeAgentId) && owner.agentId === issue.assigneeAgentId;
}

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string };
    contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;
  if (isSelfAddressedUnblockDescriptor(issue)) return false;

  await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${issue.blockedTransitionAt.toISOString()}`,
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}
