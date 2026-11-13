import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { issueService } from "../issues.js";
import { enqueueWake } from "../native-runtime/status-decision-committer.js";

export const NATIVE_REVIEW_MAX_ATTEMPTS = 3;
export const NATIVE_REVIEW_IDLE_GRACE_MS = 10 * 60 * 1000;
const ACTIVE_RUN_STATUSES = ["queued", "running"];
const PENDING_WAKE_STATUSES = ["queued", "claimed", "deferred_issue_execution"];
const ESCALATED_ACTION = "issue.native_review_escalated";

export type PendingNativeReviewDecision =
  | { kind: "active" }
  | { kind: "wait"; until: number }
  | { kind: "rewake"; attempt: number }
  | { kind: "escalate"; attempts: number };

/** Decides the next step for a completion review that is still pending while
 * its reviewer agent has no live review run. */
export function decidePendingNativeReview(input: {
  interactionCreatedAt: Date;
  reviewRuns: Array<{ status: string; finishedAt: Date | null; createdAt: Date }>;
  hasPendingWake: boolean;
  now: Date;
  graceMs?: number;
  maxAttempts?: number;
}): PendingNativeReviewDecision {
  const graceMs = input.graceMs ?? NATIVE_REVIEW_IDLE_GRACE_MS;
  const maxAttempts = input.maxAttempts ?? NATIVE_REVIEW_MAX_ATTEMPTS;
  if (input.hasPendingWake || input.reviewRuns.some(run => ACTIVE_RUN_STATUSES.includes(run.status))) return { kind: "active" };
  const lastSeen = Math.max(input.interactionCreatedAt.getTime(),
    ...input.reviewRuns.map(run => (run.finishedAt ?? run.createdAt).getTime()));
  const until = lastSeen + graceMs;
  if (input.now.getTime() < until) return { kind: "wait", until };
  if (input.reviewRuns.length >= maxAttempts) return { kind: "escalate", attempts: input.reviewRuns.length };
  return { kind: "rewake", attempt: input.reviewRuns.length + 1 };
}

export function pendingNativeReviewEscalationBody(input: { reviewerName: string | null; attempts: number }) {
  const reviewer = input.reviewerName ?? "The reviewer agent";
  return [
    "**Review needs a decision**",
    "",
    `${reviewer} was asked ${input.attempts} time${input.attempts === 1 ? "" : "s"} to review this task, but the review is still open.`
      + " Paperclip will not wake the reviewer again automatically.",
    "",
    "Resolve the review on this task with **Approve completion** or **Continue work**, or fix the reviewer agent and ask it again.",
  ].join("\n");
}

/** Re-wakes the reviewer of a pending completion review that no run is handling,
 * and leaves one visible notice on the task when the attempts are spent. */
export async function reconcilePendingNativeReviews(db: Db, scope: {
  companyId: string;
  issueId: string;
  onDeferredDeadline?: (at: number) => void;
}, now = new Date()) {
  const result = { rewoken: 0, escalated: 0 };
  const [issue] = await db.select({ id: issues.id, status: issues.status }).from(issues)
    .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId)));
  if (!issue || issue.status !== "in_review") return result;
  const pending = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, scope.companyId),
    eq(issueThreadInteractions.issueId, scope.issueId),
    eq(issueThreadInteractions.status, "pending"),
    eq(issueThreadInteractions.kind, "request_confirmation"),
    isNotNull(issueThreadInteractions.addresseeAgentId),
    sql`${issueThreadInteractions.payload}->'target'->>'key' = 'native_completion_review'`,
  ));
  for (const interaction of pending) {
    const reviewerId = interaction.addresseeAgentId!;
    const decisionId = (interaction.payload as { target?: { revisionId?: unknown } } | null)?.target?.revisionId;
    if (typeof decisionId !== "string") continue;
    const reviewRuns = await db.select({ status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, scope.companyId),
        eq(heartbeatRuns.agentId, reviewerId),
        sql`${heartbeatRuns.contextSnapshot}->>'nativeReviewInteractionId' = ${interaction.id}`,
      ));
    const [pendingWake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, scope.companyId),
      eq(agentWakeupRequests.agentId, reviewerId),
      inArray(agentWakeupRequests.status, PENDING_WAKE_STATUSES),
      sql`${agentWakeupRequests.payload}->>'nativeReviewInteractionId' = ${interaction.id}`,
    )).limit(1);
    const decision = decidePendingNativeReview({ interactionCreatedAt: interaction.createdAt, reviewRuns, hasPendingWake: Boolean(pendingWake), now });
    if (decision.kind === "active") continue;
    if (decision.kind === "wait") {
      scope.onDeferredDeadline?.(decision.until);
      continue;
    }
    const publications: ActivityPublication[] = [];
    if (decision.kind === "rewake") {
      const reviewContext = { nativeReviewInteractionId: interaction.id, nativeReviewDecisionId: decisionId };
      await db.transaction(async tx => {
        await enqueueWake({
          tx: tx as unknown as Db,
          companyId: scope.companyId,
          issueId: scope.issueId,
          agentId: reviewerId,
          reason: "native_completion_review",
          idempotencyKey: `native-review:${interaction.id}:rewake:${decision.attempt}`,
          payload: reviewContext,
          contextSnapshot: { ...reviewContext, forceFreshSession: true },
        });
        await logActivity(tx as unknown as Db, {
          companyId: scope.companyId, actorType: "system", actorId: "heartbeat", agentId: reviewerId,
          action: "issue.native_review_rewoken", entityType: "issue", entityId: scope.issueId,
          details: { interactionId: interaction.id, attempt: decision.attempt, maxAttempts: NATIVE_REVIEW_MAX_ATTEMPTS },
        }, publications);
      });
      result.rewoken += 1;
    } else {
      const escalated = await db.transaction(async tx => {
        const [already] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
          eq(activityLog.companyId, scope.companyId),
          eq(activityLog.entityId, scope.issueId),
          eq(activityLog.action, ESCALATED_ACTION),
          sql`${activityLog.details}->>'interactionId' = ${interaction.id}`,
        )).limit(1);
        if (already) return false;
        const [reviewer] = await tx.execute(sql`select name from agents where id = ${reviewerId} and company_id = ${scope.companyId}`);
        const comment = await issueService(tx as unknown as Db).addComment(scope.issueId,
          pendingNativeReviewEscalationBody({ reviewerName: typeof reviewer?.name === "string" ? reviewer.name : null, attempts: decision.attempts }),
          {}, { authorType: "system" }, tx as unknown as Db);
        await logActivity(tx as unknown as Db, {
          companyId: scope.companyId, actorType: "system", actorId: "heartbeat", agentId: reviewerId,
          action: ESCALATED_ACTION, entityType: "issue", entityId: scope.issueId,
          details: { interactionId: interaction.id, attempts: decision.attempts, commentId: comment.id },
        }, publications);
        return true;
      });
      if (escalated) result.escalated += 1;
    }
    for (const publication of publications) publishActivity(publication);
  }
  return result;
}
