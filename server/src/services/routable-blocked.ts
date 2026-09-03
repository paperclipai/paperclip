import { createHash } from "node:crypto";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

/**
 * Stable discriminator for "which descriptor was this owner told about".
 *
 * What actually suppresses a repeat delivery is the persisted
 * `blocked_owner_notified_at` stamp, not this key: no unique index and no
 * caller-side pre-check covers the `issue-unblock:` prefix, so nothing in the
 * wakeup path collapses two rows that share one key. The key is an identifier
 * — but it still has to stay collision-free per delivery, so that wiring
 * dedupe onto it later cannot silently start dropping notifications.
 */
export function unblockDescriptorFingerprint(descriptor: IssueUnblockDescriptor): string {
  const owner = descriptor.owner;
  const ownerKey = owner === "board"
    ? "board"
    : "agentId" in owner
      ? `agent:${owner.agentId}`
      : `user:${owner.userId}`;
  // JSON.stringify keeps the two fields unambiguously delimited, so an action
  // text containing the separator cannot forge another owner's key.
  return createHash("sha256")
    .update(JSON.stringify([ownerKey, descriptor.action]))
    .digest("hex")
    .slice(0, 12);
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
  /**
   * The delivery stamp this one supersedes, when the caller is re-pointing a
   * descriptor on an issue that is already blocked.
   *
   * `blockedTransitionAt` does not move on a re-point, so owner/action alone
   * cannot separate deliveries within one blocked span: re-pointing A -> B -> A
   * rebuilds the exact key A's first delivery used. The superseded stamp is the
   * generation counter that keeps the third key distinct from the first.
   */
  supersedesNotifiedAt?: Date | null;
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
    idempotencyKey: [
      "issue-unblock",
      issue.id,
      issue.blockedTransitionAt.toISOString(),
      unblockDescriptorFingerprint(issue.unblockDescriptor),
      input.supersedesNotifiedAt ? `after:${input.supersedesNotifiedAt.toISOString()}` : "first",
    ].join(":"),
    payload: { issueId: issue.id, action: issue.unblockDescriptor.action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
  });
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}
