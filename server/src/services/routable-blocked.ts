import type { IssueUnblockDescriptor, IssueUnblockOwner } from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

export function resolveRequestedUnblockDescriptor(
  updateFields: { unblockDescriptor?: IssueUnblockDescriptor | null | undefined },
  body: { unblockDescriptor?: IssueUnblockDescriptor | null | undefined },
): IssueUnblockDescriptor | null {
  const descriptor = updateFields.unblockDescriptor ?? body.unblockDescriptor ?? null;
  return descriptor && typeof descriptor === "object" ? descriptor : null;
}

export function agentUnblockOwnerDeniedReason(input: {
  actorType: string;
  actorAgentId?: string | null;
  issueAssigneeAgentId?: string | null;
  owner: IssueUnblockOwner;
  parentAssigneeAgentId?: string | null;
  parentBlockedByChild?: boolean;
}): string | null {
  if (input.actorType !== "agent") return null;
  if (input.owner === "board" || "userId" in input.owner) {
    return "Agents may only name themselves as an unblock owner";
  }
  if ("agentId" in input.owner) {
    if (input.actorAgentId === input.owner.agentId) return null;
    const mayNameParentAssignee = Boolean(
      input.issueAssigneeAgentId &&
      input.actorAgentId === input.issueAssigneeAgentId &&
      input.parentAssigneeAgentId &&
      input.owner.agentId === input.parentAssigneeAgentId &&
      input.parentBlockedByChild,
    );
    if (mayNameParentAssignee) return null;
    return "Agents may only name themselves as an unblock owner";
  }
  return null;
}

type RoutableBlockedIssue = {
  id: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

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
