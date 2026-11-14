import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, issueComments, issues, type Db } from "@paperclipai/db";
import { notifyDeferredExecutionEligibility, notifyDeferredExecutionWork, notifyDeferredWakesForIssue } from "./deferred-execution-notifications.js";
import { withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";
import { deliveredQueuedCommentIds } from "./queued-comment-delivery.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

/**
 * Work-intent outbox (durable ownership plan, section E; invariant 4).
 *
 * An accepted work intent (assignment, comment, Retry, recovery) ends in one
 * of a closed set of terminal outcomes. Every other refusal is temporary: the
 * intent is saved as `deferred_issue_execution` with an `executionWait` that
 * names the refusal and the hold-release event that clears it. Each such event
 * calls `promoteDeferredWorkIntents`, and the ownership reconciler calls it as
 * a backstop for a missed event. Promotion re-runs normal admission; it never
 * bypasses a gate, and the existing compare-and-swap promotion plus the
 * per-comment consumption check keep delivery exactly once.
 */

/** The only terminal outcomes of an accepted work intent. */
export const WORK_INTENT_TERMINAL_OUTCOMES = ["delivered", "consumed", "task_cancelled", "hard_stop"] as const;
export type WorkIntentTerminalOutcome = (typeof WORK_INTENT_TERMINAL_OUTCOMES)[number];

/** Hold-release events. Each promotes the intents its hold deferred. */
export const WORK_INTENT_HOLD_TRIGGERS = [
  "accounting_settled", "lock_released", "pause_lifted", "tree_hold_released", "scheduling_resumed", "reconciler_backstop",
] as const;
export type WorkIntentHoldTrigger = (typeof WORK_INTENT_HOLD_TRIGGERS)[number];

/** Temporary refusals of an accepted intent, and the event that clears each.
 * A refusal not listed here is either a terminal outcome (a reached hard
 * stop, a cancelled or reassigned task) or a signal that was never accepted
 * work (a disabled timer, no actionable work). */
export const TEMPORARY_REFUSAL_TRIGGERS: Readonly<Record<string, WorkIntentHoldTrigger>> = {
  "budget.blocked": "pause_lifted",
  "company.inactive": "pause_lifted",
  "agent.not_invokable": "pause_lifted",
  "issue_tree_hold_active": "tree_hold_released",
  "heartbeat.scheduling_suppressed": "scheduling_resumed",
  /** A user message whose wake was lost (the reconciler saved it). */
  wake_lost: "reconciler_backstop",
};

export function temporaryRefusalTrigger(reason: string): WorkIntentHoldTrigger | null {
  return TEMPORARY_REFUSAL_TRIGGERS[reason] ?? null;
}

/** The `executionWait` saved on a deferred intent. */
export function deferredWorkIntentWait(reason: string, message: string, details: Record<string, unknown> = {}) {
  return { ...details, reason, trigger: temporaryRefusalTrigger(reason), message };
}

/** Saved intents back off 30 s after each refusal (deferred-receipt-work.ts).
 * A hold-release event makes the intents it may clear due at once. */
const DEFERRED_RETRY_BACKOFF = sql`interval '30 seconds'`;

/**
 * The one promotion path for deferred work intents. Call it inside a
 * transaction, normally the one that releases a hold (accounting settled, a lock released, a
 * pause lifted). It wakes queued-run dispatch, the saved-receipt worker and
 * stranded-work recovery for the company, and hints each saved intent of the
 * issue by id. All notifications publish on commit.
 */
export async function promoteDeferredWorkIntents(tx: object, input: {
  companyId: string; trigger: WorkIntentHoldTrigger; issueId?: string | null;
}) {
  // Register the work signals before the write they announce.
  await notifyRunDispatch(tx, { companyId: input.companyId });
  await notifyDeferredExecutionEligibility(tx, { companyId: input.companyId });
  await notifyIssueRecovery(tx, { companyId: input.companyId });
  if (input.issueId) await notifyDeferredWakesForIssue(tx, { companyId: input.companyId, issueId: input.issueId });
  const db = tx as Pick<Db, "update">;
  await db.update(agentWakeupRequests).set({
    updatedAt: sql`least(${agentWakeupRequests.updatedAt}, now() - ${DEFERRED_RETRY_BACKOFF})`,
  }).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->'executionWait' is not null`,
    sql`${agentWakeupRequests.updatedAt} > now() - ${DEFERRED_RETRY_BACKOFF}`,
    input.issueId ? sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}` : undefined,
  ));
}

const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";

/** SQL: the latest recorded `done` transition of the task was not made by a
 * person. A task a person closed (or with no recorded close) is never
 * reopened for an earlier message. */
export function taskClosedByAgentSql(companyId: unknown, issueId: unknown) {
  return sql`coalesce((select closed.actor_type from activity_log closed
    where closed.company_id = ${companyId} and closed.entity_type = 'issue' and closed.entity_id = ${issueId}::text
      and closed.action = 'issue.updated'
      and (closed.details->>'toStatus' = 'done' or closed.details->>'status' = 'done')
    order by closed.created_at desc limit 1), 'user') <> 'user'`;
}

/**
 * Record the missing outbox entry for user messages whose wake was lost or
 * ended without delivering them: one deferred receipt of the user that
 * carries the undelivered comments. Only the task's assigned agent, and only
 * live user comments that no completed run received, are saved. Statuses the
 * caller allows (for example `done`, which the release drain reopens for a
 * user's message) gate it. Normal admission and the release drain deliver
 * the receipt once. Returns the receipt id, or null when nothing is owed.
 *
 * `explicitResumeCommentIds` also admits those comments of another agent: each
 * was posted with `resume: true`, which reopens finished work as a person's
 * comment does. When only such comments remain, the receipt names the latest
 * one's author as requester and keeps the explicit resume intent, so the
 * release drain's existing agent-resume rule reopens the task. The assignee's
 * own comments never qualify.
 */
export async function saveUndeliveredUserComments(db: Db, input: {
  companyId: string; issueId: string; agentId: string; commentIds: string[];
  allowedStatuses: readonly string[]; requestedByActorId?: string | null;
  source?: string | null; triggerDetail?: string | null;
  /** Names why the receipt waits and what promotes it. */
  executionWait?: Record<string, unknown>;
  reopenAgentClosedDone?: boolean;
  explicitResumeCommentIds?: readonly string[];
}): Promise<string | null> {
  if (input.commentIds.length === 0) return null;
  let publication: ActivityPublication | undefined;
  const savedId = await db.transaction(async tx => {
    const [issue] = await tx.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId,
      conversationAgentId: issues.conversationAgentId }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    // A reassigned or cancelled task ends the intent; a conversation keeps
    // its own inbound authorization path.
    if (!issue || issue.assigneeAgentId !== input.agentId || issue.conversationAgentId ||
        !input.allowedStatuses.includes(issue.status)) return null;
    if (issue.status === "done") {
      const [closed] = await tx.execute<{ byAgent: boolean }>(sql`select ${taskClosedByAgentSql(input.companyId, input.issueId)} as "byAgent"`);
      if (closed?.byAgent !== true) return null;
    }
    const resumeIds = input.explicitResumeCommentIds?.filter(id => input.commentIds.includes(id)) ?? [];
    // A direct human comment: no agent author and no creating run.
    const human = and(isNotNull(issueComments.authorUserId), isNull(issueComments.authorAgentId), isNull(issueComments.createdByRunId));
    const live = await tx.select({ id: issueComments.id, authorUserId: issueComments.authorUserId,
      authorAgentId: issueComments.authorAgentId }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      inArray(issueComments.id, input.commentIds), isNull(issueComments.deletedAt),
      resumeIds.length ? or(human, and(inArray(issueComments.id, resumeIds), isNotNull(issueComments.authorAgentId),
        ne(issueComments.authorAgentId, input.agentId))) : human));
    const delivered = await deliveredQueuedCommentIds(tx as unknown as Db, { companyId: input.companyId,
      issueId: input.issueId, agentId: input.agentId, commentIds: live.map(row => row.id) });
    const remaining = input.commentIds.filter(id => live.some(row => row.id === id) && !delivered.has(id));
    if (remaining.length === 0) return null;
    const latest = remaining.at(-1)!;
    const resumingAgentId = live.find(row => row.id === latest)?.authorAgentId ?? null;
    const agentResume = resumingAgentId !== null && remaining.every(id => live.find(row => row.id === id)?.authorAgentId);
    const resumeIntent = agentResume ? { resumeIntent: true, followUpRequested: true } : {};
    await notifyDeferredExecutionWork(tx, { companyId: input.companyId });
    await notifyDeferredWakesForIssue(tx, { companyId: input.companyId, issueId: input.issueId });
    const [saved] = await tx.insert(agentWakeupRequests).values({
      companyId: input.companyId, agentId: input.agentId, source: input.source ?? "automation",
      triggerDetail: input.triggerDetail ?? "system", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: agentResume ? "agent" : "user",
      requestedByActorId: agentResume ? resumingAgentId : input.requestedByActorId
        ?? [...remaining].reverse().map(id => live.find(row => row.id === id)?.authorUserId).find(Boolean) ?? null,
      payload: withQueuedCommentIdsInWakePayload({ issueId: input.issueId, mutation: "comment", commentId: latest,
        ...resumeIntent,
        ...(input.executionWait ? { executionWait: input.executionWait } : {}),
        [DEFERRED_WAKE_CONTEXT_KEY]: { issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_commented",
          source: "issue.comment", wakeCommentIds: remaining, wakeCommentId: latest, ...resumeIntent } }, remaining),
    }).returning({ id: agentWakeupRequests.id });
    if (saved && issue.status === "done" && input.reopenAgentClosedDone) {
      const { issueService } = await import("./issues.js");
      const updated = await issueService(tx as unknown as Db).updateForCompany(input.issueId, input.companyId,
        { status: "todo", executionState: null }, tx);
      if (!updated) throw new Error("undelivered_comment_task_changed");
      publication = (await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system",
        actorId: "ownership-reconciler", agentId: input.agentId, action: "issue.updated", entityType: "issue",
        entityId: input.issueId,
        details: { status: "todo", reopened: true, reopenedFrom: "done", source: "undelivered_comment_backstop" } })).publication;
    }
    return saved?.id ?? null;
  });
  if (publication) publishActivity(publication);
  return savedId;
}
