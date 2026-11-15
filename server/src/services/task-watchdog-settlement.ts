import { TASK_WATCHDOG_ORIGIN_KIND } from "./task-watchdog-scope.js";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  heartbeatRuns,
  issues,
  issueWatchdogs,
} from "@paperclipai/db";
import { persistActivity } from "./activity-log.js";
import type { Db } from "@paperclipai/db";
import type { TaskWatchdogClassifierResult } from "./task-watchdogs.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
type Reader = Pick<Db, "select" | "execute">;
type Watchdog = typeof issueWatchdogs.$inferSelect;
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";
export async function watchdogSettlementReceipt(
  db: Reader,
  companyId: string,
  reviewId: string,
  statusVersion?: number,
) {
  const [row] = await db
    .select()
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, reviewId),
        eq(activityLog.actorType, "system"),
        eq(activityLog.actorId, "task-watchdog-settlement"),
        eq(activityLog.action, "issue.task_watchdog_auto_settled"),
        ...(statusVersion === undefined
          ? []
          : [
              sql`${activityLog.details}->>'reviewStatusVersion' = ${String(statusVersion)}`,
            ]),
      ),
    )
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(1);
  return row ?? null;
}
export async function settleObsoleteWatchdogReview(
  db: Db,
  {
    watchdog,
    classification,
    reclassify,
    now = new Date(),
  }: {
    watchdog: Watchdog;
    classification: TaskWatchdogClassifierResult;
    reclassify: (
      watchdog: Watchdog,
      reader: Reader,
    ) => Promise<TaskWatchdogClassifierResult>;
    now?: Date;
  },
) {
  const reviewId = watchdog.watchdogIssueId;
  if (
    !reviewId ||
    classification.includedIssueIds.length > 100 ||
    !["live", "not_applicable", "already_reviewed", "stopped"].includes(
      classification.state,
    )
  )
    return { settled: false };
  return db.transaction(async (tx) => {
    const ids = [
      ...new Set([
        watchdog.issueId,
        reviewId,
        ...classification.includedIssueIds,
      ]),
    ].sort();
    const locked = await tx
      .select()
      .from(issues)
      .where(
        and(eq(issues.companyId, watchdog.companyId), inArray(issues.id, ids)),
      )
      .orderBy(issues.id)
      .for("update");
    const [current] = await tx
      .select()
      .from(issueWatchdogs)
      .where(
        and(
          eq(issueWatchdogs.companyId, watchdog.companyId),
          eq(issueWatchdogs.id, watchdog.id),
        ),
      )
      .for("update");
    const source = locked.find((i) => i.id === watchdog.issueId),
      review = locked.find((i) => i.id === watchdog.watchdogIssueId);
    if (
      !current ||
      current.status !== "active" ||
      current.watchdogIssueId !== review?.id ||
      !source ||
      !review ||
      review.originKind !== TASK_WATCHDOG_ORIGIN_KIND ||
      review.originId !== source.id ||
      review.assigneeAgentId !== current.watchdogAgentId ||
      !["blocked", "todo", "in_progress", "done"].includes(review.status) ||
      review.assigneeUserId ||
      review.executionState ||
      review.executionRunId ||
      review.checkoutRunId ||
      current.watchdogAgentId !== review.assigneeAgentId
    )
      return { settled: false };
    const previousSettlement =
      review.status === "done"
        ? await watchdogSettlementReceipt(
            tx,
            watchdog.companyId,
            review.id,
            review.statusVersion,
          )
        : null;
    if (review.status === "done" && !previousSettlement)
      return { settled: false };
    const fresh = await reclassify(current, tx);
    const business = fresh.includedIssueIds ?? [];
    if (
      business.some((id) => !ids.includes(id)) ||
      !["live", "not_applicable", "already_reviewed", "stopped"].includes(
        fresh.state,
      )
    )
      return { settled: false };
    const terminal =
      business.length > 0 &&
      business.every((id) =>
        ["done", "cancelled"].includes(
          locked.find((i) => i.id === id)?.status ?? "",
        ),
      );
    if (!terminal) {
      if (fresh.state !== "live") return { settled: false };
      const [started] =
        await tx.execute(sql`select 1 from heartbeat_runs r join issues i on i.execution_run_id=r.id and i.company_id=r.company_id
    where r.company_id=${watchdog.companyId} and i.id in (${sql.join(
      business.map((id) => sql`${id}::uuid`),
      sql`,`,
    )}) and r.status='running' and r.started_at is not null and r.result_json->'cancellation' is null
      and ((r.runtime_mode='legacy' and r.process_pid>0 and coalesce(r.session_id_after,r.session_id_before) is not null)
        or (r.runtime_mode='native' and r.native_session_id is not null and r.execution_stage='executing')) limit 1`);
      if (!started) return { settled: false };
    }
    const allIds = [...new Set([...business, review.id])];
    const [guard] = await tx.execute(sql`select 1 where
   exists(select 1 from heartbeat_runs where company_id=${watchdog.companyId} and (issue_id=${review.id} or context_snapshot->>'issueId'=${review.id}) and status in ('running','queued','scheduled_retry'))
   or exists(select 1 from issue_thread_interactions where company_id=${watchdog.companyId} and issue_id in (${sql.join(
     allIds.map((id) => sql`${id}::uuid`),
     sql`,`,
   )}) and status='pending')
   or exists(select 1 from issue_approvals ia join approvals a on a.id=ia.approval_id and a.company_id=ia.company_id where ia.company_id=${watchdog.companyId} and ia.issue_id in (${sql.join(
     allIds.map((id) => sql`${id}::uuid`),
     sql`,`,
   )}) and a.status in ('pending','revision_requested'))`);
    if (
      guard ||
      (await getConversationOwnershipBlocker(
        tx as unknown as Db,
        watchdog.companyId,
        review.id,
      ))
    )
      return { settled: false };
    const [paused] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, watchdog.companyId),
          inArray(
            agents.id,
            locked.flatMap((i) =>
              i.assigneeAgentId ? [i.assigneeAgentId] : [],
            ),
          ),
          inArray(agents.status, ["paused", "terminated", "pending_approval"]),
        ),
      )
      .limit(1);
    if (paused) return { settled: false };
    if (previousSettlement)
      return {
        settled: true,
        alreadySettled: true,
        reviewId: review.id,
        receiptId: previousSettlement.id,
      };
    await notifyIssueRecovery(tx, { companyId: watchdog.companyId });
    await notifyStatusCardIssueChange(tx, watchdog.companyId);
    const [updated] = await tx
      .update(issues)
      .set({
        status: "done",
        completedAt: now,
        unblockDescriptor: null,
        statusVersion: sql`${issues.statusVersion}+1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, review.id),
          eq(issues.status, review.status),
          eq(issues.originFingerprint, review.originFingerprint),
        ),
      )
      .returning();
    if (!updated) return { settled: false };
    await tx
      .update(issueWatchdogs)
      .set({
        lastReviewedFingerprint: null,
        lastReviewedStopSnapshot: null,
        lastCompletedAt: now,
        updatedAt: now,
      })
      .where(eq(issueWatchdogs.id, current.id));
    const receipt = await persistActivity(tx as unknown as Db, {
      companyId: watchdog.companyId,
      actorType: "system",
      actorId: "task-watchdog-settlement",
      action: "issue.task_watchdog_auto_settled",
      entityType: "issue",
      entityId: review.id,
      details: {
        watchdogId: current.id,
        watchedIssueId: source.id,
        originFingerprint: review.originFingerprint,
        reviewStatusVersion: updated.statusVersion,
        reason: terminal
          ? "business_subtree_terminal"
          : "business_provider_resumed",
        businessAcceptance: false,
        rearmOnNextStop: true,
      },
    });
    return {
      settled: true,
      reviewId: review.id,
      reviewStatusVersion: updated.statusVersion,
      receiptId: receipt.activity.id,
    };
  });
}

export async function readTerminalWatchdogSettlement(
  db: Reader,
  watchdog: Watchdog,
  classification: TaskWatchdogClassifierResult,
  businessIssues: Array<{ id: string; status: string }>,
) {
  if (
    !watchdog.watchdogIssueId ||
    classification.state !== "stopped" ||
    !classification.includedIssueIds.length ||
    classification.includedIssueIds.length > 100 ||
    classification.includedIssueIds.some(
      (id) =>
        !["done", "cancelled"].includes(
          businessIssues.find((issue) => issue.id === id)?.status ?? "",
        ),
    )
  )
    return null;
  const [review] = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, watchdog.companyId),
        eq(issues.id, watchdog.watchdogIssueId),
        eq(issues.originKind, TASK_WATCHDOG_ORIGIN_KIND),
        eq(issues.originId, watchdog.issueId),
        eq(issues.status, "done"),
      ),
    )
    .limit(1);
  if (!review || review.assigneeAgentId !== watchdog.watchdogAgentId || review.assigneeUserId ||
      review.executionRunId || review.checkoutRunId || review.executionState) return null;
  const [pending] = await db.execute(sql`select 1 where
    exists(select 1 from issue_thread_interactions where company_id=${watchdog.companyId} and issue_id=${review.id} and status='pending')
    or exists(select 1 from issue_approvals ia join approvals a on a.id=ia.approval_id and a.company_id=ia.company_id
      where ia.company_id=${watchdog.companyId} and ia.issue_id=${review.id} and a.status in ('pending','revision_requested'))
    or exists(select 1 from heartbeat_runs where company_id=${watchdog.companyId}
      and (issue_id=${review.id} or context_snapshot->>'issueId'=${review.id}) and status in ('running','queued','scheduled_retry'))
    or exists(select 1 from agent_wakeup_requests where company_id=${watchdog.companyId}
      and (payload->>'issueId'=${review.id} or payload->'_paperclipWakeContext'->>'issueId'=${review.id})
      and status in ('queued','deferred_issue_execution'))`);
  if (pending) return null;
  const receipt = await watchdogSettlementReceipt(
    db,
    watchdog.companyId,
    review.id,
    review.statusVersion,
  );
  return receipt ? { review, receipt } : null;
}
