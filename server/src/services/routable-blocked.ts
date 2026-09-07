import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

export type BlockedOwnerNotificationDeliveryResult =
  | { delivered: true; reason: "user_notification_delivered"; receiptId: string }
  | { delivered: false; reason: "not_applicable" | "owner_unresolved" | "agent_owner_requires_wakeup" | "delivery_failed" };

type RoutableBlockedIssue = {
  id: string;
  companyId?: string;
  status: string;
  unblockDescriptor?: IssueUnblockDescriptor | null;
  blockedTransitionAt?: Date | null;
  blockedOwnerNotifiedAt?: Date | null;
};

type ProspectiveBlockedIssue = RoutableBlockedIssue & {
  status: "blocked";
  blockedTransitionAt: Date;
};

export function blockedOwnerNotificationIdempotencyKey(input: {
  issueId: string;
  blockedTransitionAt: Date;
}) {
  return `blocked-owner-notification:${input.issueId}:${input.blockedTransitionAt.toISOString()}`;
}

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

export function blockedOwnerDeliveryMatchesIssue(input: {
  issue: RoutableBlockedIssue;
  delivery: { userId: string; action: string; idempotencyKey: string };
}) {
  if (!isProspectiveBlockedTransition(input.issue) || !input.issue.unblockDescriptor) {
    return false;
  }
  const owner = input.issue.unblockDescriptor.owner;
  if (owner === "board" || typeof owner !== "object" || !("userId" in owner)) {
    return false;
  }
  if (owner.userId !== input.delivery.userId) return false;
  if (input.issue.unblockDescriptor.action !== input.delivery.action) return false;
  return blockedOwnerNotificationIdempotencyKey({
    issueId: input.issue.id,
    blockedTransitionAt: input.issue.blockedTransitionAt,
  }) === input.delivery.idempotencyKey;
}

export async function deliverBlockedOwnerNotification(input: {
  issue: RoutableBlockedIssue & {
    responsibleUserId?: string | null;
  };
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  deliverToUser?: (delivery: {
    userId: string;
    action: string;
    idempotencyKey: string;
  }) => Promise<{ receiptId: string }>;
  now?: () => Date;
}): Promise<BlockedOwnerNotificationDeliveryResult> {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return { delivered: false, reason: "not_applicable" };
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board") {
    return { delivered: false, reason: "owner_unresolved" };
  }

  if (typeof owner === "object" && owner !== null && "userId" in owner) {
    if (!input.deliverToUser) {
      return { delivered: false, reason: "delivery_failed" };
    }
    const idempotencyKey = blockedOwnerNotificationIdempotencyKey({
      issueId: issue.id,
      blockedTransitionAt: issue.blockedTransitionAt,
    });
    try {
      const { receiptId } = await input.deliverToUser({
        userId: owner.userId,
        action: issue.unblockDescriptor.action,
        idempotencyKey,
      });
      await input.markNotified((input.now ?? (() => new Date()))());
      return { delivered: true, reason: "user_notification_delivered", receiptId };
    } catch {
      return { delivered: false, reason: "delivery_failed" };
    }
  }

  return { delivered: false, reason: "agent_owner_requires_wakeup" };
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
