import { and, eq, isNull, sql } from "drizzle-orm";
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

export async function deliverBlockedOwnerNotification(db: Db, input: {
  issue: RoutableBlockedIssue & { companyId: string };
  wakeup: Parameters<typeof deliverAgentUnblockNotification>[0]["wakeup"];
  now?: () => Date;
}): Promise<Date | null> {
  const { issue } = input;
  if (!isProspectiveBlockedTransition(issue) || issue.blockedOwnerNotifiedAt) return null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue-unblock:${issue.id}`}, 0))`);
    const [current] = await tx.select({
      id: issues.id,
      status: issues.status,
      unblockDescriptor: issues.unblockDescriptor,
      blockedTransitionAt: issues.blockedTransitionAt,
      blockedOwnerNotifiedAt: issues.blockedOwnerNotifiedAt,
    }).from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)));
    if (!current?.blockedTransitionAt || !current.unblockDescriptor) return null;
    const { blockedTransitionAt, unblockDescriptor } = current;
    let notifiedAt: Date | null = null;
    await deliverAgentUnblockNotification({
      issue: current,
      wakeup: input.wakeup,
      now: input.now,
      markNotified: async (at) => {
        const marked = await tx.update(issues).set({ blockedOwnerNotifiedAt: at }).where(and(
          eq(issues.id, issue.id),
          eq(issues.companyId, issue.companyId),
          eq(issues.status, "blocked"),
          eq(issues.blockedTransitionAt, blockedTransitionAt),
          isNull(issues.blockedOwnerNotifiedAt),
          sql`${issues.unblockDescriptor} = ${JSON.stringify(unblockDescriptor)}::jsonb`,
        )).returning({ id: issues.id });
        if (marked.length > 0) notifiedAt = at;
      },
    });
    return notifiedAt;
  });
}
