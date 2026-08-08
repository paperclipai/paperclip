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

export function isProspectiveBlockedTransition(issue: RoutableBlockedIssue): issue is ProspectiveBlockedIssue {
  return issue.status === "blocked" &&
    Boolean(issue.blockedTransitionAt && issue.blockedTransitionAt >= ROUTABLE_BLOCKED_ROLLOUT_AT);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

export function buildAgentUnblockWakeIntent(issue: RoutableBlockedIssue) {
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor) return null;
  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return null;
  const transitionAt = issue.blockedTransitionAt.toISOString();
  const intentFingerprint = createHash("sha256")
    .update(stableStringify({ descriptor: issue.unblockDescriptor, transitionAt }))
    .digest("hex");
  return {
    ownerAgentId: owner.agentId,
    idempotencyKey: `issue-unblock:v2:${issue.id}:${transitionAt}:${intentFingerprint}`,
    intentFingerprint,
    payload: {
      issueId: issue.id,
      action: issue.unblockDescriptor.action,
      intentFingerprint,
    },
  };
}

export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: {
    source: "automation";
    triggerDetail: "system";
    reason: "issue_unblock_requested";
    idempotencyKey: string;
    payload: { issueId: string; action: string; intentFingerprint: string };
    contextSnapshot: {
      wakeReason: "issue_unblock_requested";
      issueId: string;
      taskId: string;
      intentFingerprint: string;
    };
  }) => Promise<unknown>;
  markNotified: (notifiedAt: Date) => Promise<unknown>;
  now?: () => Date;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const intent = buildAgentUnblockWakeIntent(issue);
  if (!intent) return false;

  const accepted = await input.wakeup(intent.ownerAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: intent.idempotencyKey,
    payload: intent.payload,
    contextSnapshot: {
      wakeReason: "issue_unblock_requested",
      issueId: issue.id,
      taskId: issue.id,
      intentFingerprint: intent.intentFingerprint,
    },
  });
  if (!accepted) return false;
  await input.markNotified((input.now ?? (() => new Date()))());
  return true;
}
