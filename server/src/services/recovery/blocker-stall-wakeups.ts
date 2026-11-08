/**
 * Wake the issues waiting on a stalled one (`issue_blocker_stalled`).
 *
 * A parent hears about a child only when the child completes
 * (`issue_children_completed`), and a dependent hears about a blocker only when
 * every blocker is done (`issue_blockers_resolved`). When a child or blocker
 * instead stalls on a recovery action that needs the board (for example a run
 * whose retries are exhausted), nothing told the waiting agent: restart chaos
 * w-20261108T181313-s9701 t05 left a parent silently blocked for 50+ minutes.
 *
 * A stall is the issue's latest recovery action needing the board, on an
 * issue that is not done or cancelled:
 * - open (`active` or `escalated`) and board-owned or escalated; or
 * - board-owned and resolved with outcome `blocked` while the issue is still
 *   `blocked`. Recovery resolves its action this way when it gives the issue
 *   to the board (t05: created and resolved within six seconds), so an open
 *   action alone misses the common case.
 * Each open, agent-assigned waiter (the parent, and every issue the stalled
 * one `blocks`) is woken once per stall. The idempotency key names the
 * recovery action, so a repeated sweep never wakes twice, and a later stall
 * (a new action after a Retry or another failure) wakes again.
 */
import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, issueRecoveryActions, issueRelations, issues, type Db } from "@paperclipai/db";
import { ISSUE_BLOCKER_STALLED_WAKE_REASON, type IssueBlockerStalledWakeContext, type IssueBlockerStallRelation } from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";

const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"];
const MAX_STALLS_PER_PASS = 200;

export type BlockerStallWakeup = (agentId: string, input: {
  source: "automation";
  triggerDetail: "system";
  reason: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

export function issueBlockerStalledWakeKey(input: { waiterIssueId: string; stalledIssueId: string; recoveryActionId: string }) {
  return [ISSUE_BLOCKER_STALLED_WAKE_REASON, input.waiterIssueId, input.stalledIssueId, input.recoveryActionId].join(":");
}

type StallFilter = { companyId?: string | null; issueId?: string | null; issueIds?: readonly string[] };

/** The stalled issues matching `filter` and the recovery action each one waits on. */
async function readStalls(db: Db, filter: StallFilter, limit = MAX_STALLS_PER_PASS) {
  if (filter.issueIds && filter.issueIds.length === 0) return [];
  return db.select({
    actionId: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId,
    kind: issueRecoveryActions.kind, cause: issueRecoveryActions.cause, status: issueRecoveryActions.status,
    ownerType: issueRecoveryActions.ownerType, nextAction: issueRecoveryActions.nextAction,
    issueId: issues.id, identifier: issues.identifier, title: issues.title, issueStatus: issues.status, parentId: issues.parentId,
  }).from(issueRecoveryActions)
    .innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId), eq(issues.companyId, issueRecoveryActions.companyId)))
    .where(and(
      filter.companyId ? eq(issueRecoveryActions.companyId, filter.companyId) : undefined,
      filter.issueId ? eq(issueRecoveryActions.sourceIssueId, filter.issueId) : undefined,
      filter.issueIds ? inArray(issueRecoveryActions.sourceIssueId, [...filter.issueIds]) : undefined,
      notInArray(issues.status, TERMINAL_ISSUE_STATUSES),
      or(
        and(inArray(issueRecoveryActions.status, ["active", "escalated"]),
          or(eq(issueRecoveryActions.ownerType, "board"), eq(issueRecoveryActions.status, "escalated"))),
        and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"),
          eq(issueRecoveryActions.ownerType, "board"), eq(issues.status, "blocked")),
      ),
      // Only the issue's latest action describes its current state.
      sql`not exists (select 1 from ${issueRecoveryActions} newer
        where newer.company_id = ${issueRecoveryActions.companyId}
          and newer.source_issue_id = ${issueRecoveryActions.sourceIssueId}
          and newer.created_at > ${issueRecoveryActions.createdAt})`,
    ))
    .orderBy(issueRecoveryActions.id)
    .limit(limit);
}

type StallRow = Awaited<ReturnType<typeof readStalls>>[number];

function stallContext(stall: StallRow, relation: IssueBlockerStallRelation): IssueBlockerStalledWakeContext {
  return {
    stalledIssueId: stall.issueId,
    stalledIssueIdentifier: stall.identifier,
    stalledIssueTitle: stall.title,
    stalledIssueStatus: stall.issueStatus,
    relation,
    recoveryAction: { id: stall.actionId, kind: stall.kind, cause: stall.cause, status: stall.status,
      ownerType: stall.ownerType, nextAction: stall.nextAction },
  };
}

/**
 * The children and blockers of `issueId` that are stalled on the board, for
 * the waiting issue's own page: the board sees them without opening each one.
 */
export async function listStalledDependencies(db: Db, input: { companyId: string; issueId: string }): Promise<IssueBlockerStalledWakeContext[]> {
  const children = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.parentId, input.issueId), isNull(issues.hiddenAt)));
  const blockers = await db.select({ id: issueRelations.issueId }).from(issueRelations)
    .where(and(eq(issueRelations.companyId, input.companyId), eq(issueRelations.type, "blocks"),
      eq(issueRelations.relatedIssueId, input.issueId)));
  const childIds = new Set(children.map(row => row.id));
  const stalls = await readStalls(db, { companyId: input.companyId, issueIds: [...new Set([...childIds, ...blockers.map(row => row.id)])] }, 50);
  return stalls.map(stall => stallContext(stall, childIds.has(stall.issueId) ? "child" : "blocker"));
}

export async function wakeWaitersOfStalledIssues(db: Db, enqueueWakeup: BlockerStallWakeup,
  opts: { companyId?: string | null; issueId?: string | null } = {}) {
  const result = { stalls: 0, woken: 0, alreadyWoken: 0, deferred: 0, failed: 0 };
  const stalled = await readStalls(db, opts);

  for (const stall of stalled) {
    result.stalls += 1;
    const waiters = await db.select({ id: issues.id, identifier: issues.identifier, assigneeAgentId: issues.assigneeAgentId,
      relation: sql<"child" | "blocker">`case when ${issues.id} = ${stall.parentId ?? null} then 'child' else 'blocker' end` })
      .from(issues)
      .where(and(
        eq(issues.companyId, stall.companyId),
        ne(issues.id, stall.issueId),
        notInArray(issues.status, TERMINAL_ISSUE_STATUSES),
        isNull(issues.hiddenAt),
        sql`${issues.assigneeAgentId} is not null`,
        or(
          stall.parentId ? eq(issues.id, stall.parentId) : sql`false`,
          sql`exists (select 1 from ${issueRelations} r where r.company_id = ${stall.companyId}
            and r.type = 'blocks' and r.issue_id = ${stall.issueId} and r.related_issue_id = ${issues.id})`,
        ),
      ));
    for (const waiter of waiters) {
      const idempotencyKey = issueBlockerStalledWakeKey({ waiterIssueId: waiter.id, stalledIssueId: stall.issueId, recoveryActionId: stall.actionId });
      const [existing] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        // (company_id, payload->>'issueId') is indexed; the key narrows to this stall.
        .where(and(eq(agentWakeupRequests.companyId, stall.companyId),
          sql`${agentWakeupRequests.payload}->>'issueId' = ${waiter.id}`,
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey))).limit(1);
      if (existing) { result.alreadyWoken += 1; continue; }
      const context = stallContext(stall, waiter.relation);
      try {
        const wake = await enqueueWakeup(waiter.assigneeAgentId!, {
          source: "automation", triggerDetail: "system", reason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
          payload: { issueId: waiter.id, ...context }, idempotencyKey,
          requestedByActorType: "system", requestedByActorId: "issue-blocker-stall",
          contextSnapshot: { issueId: waiter.id, taskId: waiter.id, wakeReason: ISSUE_BLOCKER_STALLED_WAKE_REASON,
            source: "issue.blocker_stalled", blockerStall: context },
        });
        // Null is a normal deferral (for example wake-on-demand disabled): no
        // wake row exists yet, so a later sweep tries again.
        if (!wake) { result.deferred += 1; continue; }
        await logActivity(db, {
          companyId: stall.companyId, actorType: "system", actorId: "issue-blocker-stall",
          action: "issue.blocker_stalled_wake", entityType: "issue", entityId: waiter.id,
          agentId: waiter.assigneeAgentId, issueId: waiter.id,
          details: { stalledIssueId: stall.issueId, stalledIssueIdentifier: stall.identifier, relation: waiter.relation,
            recoveryActionId: stall.actionId, recoveryActionKind: stall.kind, recoveryActionStatus: stall.status },
        });
        result.woken += 1;
      } catch {
        // The next sweep retries: no wake row with this key exists yet.
        result.failed += 1;
      }
    }
  }
  return result;
}
