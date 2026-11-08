import { and, eq } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";
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

export type AgentUnblockWakeOptions = {
  source: "automation";
  triggerDetail: "system";
  reason: "issue_unblock_requested";
  idempotencyKey: string;
  payload: { issueId: string; action: string };
  contextSnapshot: { wakeReason: "issue_unblock_requested"; issueId: string; taskId: string };
  unblockRequestGuard: { blockedTransitionAt: string; ownerAgentId: string; action: string };
};

/**
 * Request the owner wake for one blocked request. The wake admission checks
 * the guard under the issue lock and saves `blockedOwnerNotifiedAt` in the same
 * transaction as the wake, so this function never writes the stamp itself.
 */
export async function deliverAgentUnblockNotification(input: {
  issue: RoutableBlockedIssue;
  wakeup: (agentId: string, options: AgentUnblockWakeOptions) => Promise<unknown>;
}) {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || !issue.unblockDescriptor || issue.blockedOwnerNotifiedAt) {
    return false;
  }

  const owner = issue.unblockDescriptor.owner;
  if (owner === "board" || !("agentId" in owner)) return false;

  const blockedTransitionAt = issue.blockedTransitionAt.toISOString();
  const action = issue.unblockDescriptor.action;
  await input.wakeup(owner.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_unblock_requested",
    idempotencyKey: `issue-unblock:${issue.id}:${blockedTransitionAt}`,
    payload: { issueId: issue.id, action },
    contextSnapshot: { wakeReason: "issue_unblock_requested", issueId: issue.id, taskId: issue.id },
    unblockRequestGuard: { blockedTransitionAt, ownerAgentId: owner.agentId, action },
  });
  return true;
}

/**
 * Deliver the owner wake for the request that is current now, not for the
 * caller's snapshot. No transaction or lock is held while the wake runs.
 * Returns the saved notification time of the same blocked episode, if any.
 */
export async function deliverBlockedOwnerNotification(db: Db, input: {
  issue: RoutableBlockedIssue & { companyId: string };
  wakeup: Parameters<typeof deliverAgentUnblockNotification>[0]["wakeup"];
}): Promise<Date | null> {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || issue.blockedOwnerNotifiedAt) return null;
  const readCurrent = () => db.select({
    id: issues.id,
    status: issues.status,
    unblockDescriptor: issues.unblockDescriptor,
    blockedTransitionAt: issues.blockedTransitionAt,
    blockedOwnerNotifiedAt: issues.blockedOwnerNotifiedAt,
  }).from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)))
    .then((rows) => rows[0] ?? null);
  const current = await readCurrent();
  if (!current || !(await deliverAgentUnblockNotification({ issue: current, wakeup: input.wakeup }))) return null;
  const after = await readCurrent();
  return after?.status === "blocked" &&
    after.blockedTransitionAt?.getTime() === current.blockedTransitionAt?.getTime()
    ? after.blockedOwnerNotifiedAt ?? null
    : null;
}
