import { createHash } from "node:crypto";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";

export const ROUTABLE_BLOCKED_ROLLOUT_AT = new Date("2026-07-23T18:13:03.000Z");

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

// Stable fingerprint binding an activity entry to the exact unblock descriptor
// the author wrote. Activity details pass through secret and username
// redaction before they are stored, so the proof cannot compare the raw
// action text; the hex digest survives that redaction. MD5 (not SHA) because
// Postgres md5() is built-in with no extension, and this is binding, not
// security. Returns null for malformed input so callers fail closed.
export function unblockDescriptorFingerprint(descriptor: unknown): string | null {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return null;
  const { owner, action } = descriptor as { owner?: unknown; action?: unknown };
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return null;
  const { agentId } = owner as { agentId?: unknown };
  if (typeof agentId !== "string" || typeof action !== "string") return null;
  return createHash("md5").update(`${agentId}\n${action}`, "utf8").digest("hex");
}

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
  actorAgentId?: string | null;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;
  if (input.actorAgentId && input.actorAgentId === owner.agentId) {
    // Self-authored blocked write: the owner already knows, so do not wake
    // it. Still record the acknowledgment so the passive-wait proof can
    // recognize this transition once the authoring run finishes.
    await input.markNotified((input.now ?? (() => new Date()))());
    return true;
  }

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
