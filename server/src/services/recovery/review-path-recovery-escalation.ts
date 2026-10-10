import { and, desc, eq, getTableColumns, or, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isWaitingConversation } from "../agent-conversations.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { externalConversationStateSql } from "../slack-conversation-state.js";
import {
  executeIssuePostCommitActions,
  issueService,
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  type IssuePostCommitAction,
} from "../issues.js";
import {
  buildIssueReviewPathLostIdempotencyKey,
  decideIssueReviewPathRecovery,
  ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
  reviewPathConsumedRefFromRun,
} from "./review-path-recovery.js";
import { buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";

/** A spent repair wake must leave an operator action, never another automatic wake. */
export async function escalateExhaustedIssueReviewPathRecovery(
  db: Db,
  input: { run: typeof heartbeatRuns.$inferSelect; issueId: string },
) {
  const { run, issueId } = input;
  const publications: ActivityPublication[] = [];
  const postCommitActions: IssuePostCommitAction[] = [];
  const action = await db.transaction(async (tx) => {
    // Services must use the transaction connection for implicit settings reads
    // too; borrowing the outer pool deadlocks when its only connection is held.
    const issuesSvc = issueService(tx as unknown as Db);
    // Share the issue fence with ownership, monitor, and interaction updates.
    // Re-read the disposition under the lock rather than blocking a repaired task.
    const issue = await tx.select({ ...getTableColumns(issues), externalConversationState: externalConversationStateSql() }).from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)))
      .for("update").then((rows) => rows[0] ?? null);
    if (!issue || issue.status !== "in_review" || issue.assigneeAgentId !== run.agentId
      || issue.assigneeUserId || isWaitingConversation(issue)
      || issue.externalConversationState === "waiting") return null;

    const attention = (await issuesSvc.listReviewAttention(run.companyId, [issue], tx)).get(issueId);
    if (!attention || decideIssueReviewPathRecovery({
      issueId,
      sourceRunId: run.id,
      assigneeAgentId: issue.assigneeAgentId,
      contextSnapshot: run.contextSnapshot,
      reviewAttention: attention,
      existingWake: false,
    }).kind !== "exhausted") return null;

    const latestRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, run.companyId), or(
        eq(heartbeatRuns.issueId, issueId),
        eq(heartbeatRuns.nativeIssueId, issueId),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${issueId}`,
      )))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1)
      .then((rows) => rows[0] ?? null);
    if (latestRun?.id !== run.id || !TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return null;

    const consumedPathRef = reviewPathConsumedRefFromRun({
      runId: run.id, issueId, contextSnapshot: run.contextSnapshot,
    });
    const nextAction = "Inspect the run, then restore a scheduled check or review path, retry the original assignee, or record an intentional resolution.";
    const recoveryAction = await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
      companyId: run.companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      ownerType: "board",
      previousOwnerAgentId: run.agentId,
      returnOwnerAgentId: run.agentId,
      cause: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
      fingerprint: buildIssueReviewPathLostIdempotencyKey({ issueId, consumedPathRef }),
      evidence: {
        correctiveRunId: run.id,
        consumedPathRef,
        previousStatus: "in_review",
        recoveryAttempt: 1,
        maxRecoveryAttempts: 1,
      },
      nextAction,
      wakePolicy: { type: "board_escalation", preservesSourceAssignee: true },
      attemptCount: 1,
      maxAttempts: 1,
      lastAttemptAt: run.finishedAt ?? new Date(),
    });
    await issuesSvc.update(issueId, {
      status: "blocked", companyGuard: run.companyId,
    }, tx, publications, postCommitActions);
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: {
        title: "No follow-up scheduled",
        tone: "danger",
        body: "The automatic review-path repair finished without saving a scheduled check, reviewer, approval, or other maintained path. Paperclip has blocked this task for a board decision; no further automatic follow-up is scheduled.",
        nextAction,
      },
      recoveryCause: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
      recoveryActionId: recoveryAction.id,
      recoveryOwner: null,
      sourceRun: { id: run.id, agentId: run.agentId, status: run.status },
    });
    const comment = await issuesSvc.addComment(issueId, notice.body, {}, {
      authorType: "system", presentation: notice.presentation, metadata: notice.metadata,
    }, tx);
    await logActivity(tx as unknown as Db, {
      companyId: run.companyId,
      actorType: "system",
      actorId: "heartbeat",
      agentId: run.agentId,
      runId: run.id,
      action: "issue.review_path_recovery_exhausted",
      entityType: "issue",
      entityId: issueId,
      details: { recoveryActionId: recoveryAction.id, commentId: comment.id, consumedPathRef, recoveryAttempt: 1, maxRecoveryAttempts: 1 },
    }, publications);
    return recoveryAction;
  });
  for (const publication of publications) publishActivity(publication);
  await executeIssuePostCommitActions(db, postCommitActions);
  return action;
}
