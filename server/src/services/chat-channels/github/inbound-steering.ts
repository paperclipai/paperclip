import { and, eq, isNull, sql } from "drizzle-orm";
import {
  agentWakeupRequests, chatActions, chatEndpoints, chatGitHubReviews, heartbeatRuns,
  issueAttachments, issueComments, issues, type Db,
} from "@paperclipai/db";
import { logActivity } from "../../activity-log.js";
import { notifyChatRunMilestones } from "../../chat-run-milestone-notifications.js";
import { assertDurableChatWakeupReceipt, type DurableChatWakeupRequest } from "../../durable-chat-wakeup.js";
import { queuedCommentIdsFromWakePayload } from "../../issue-queued-comment-queue.js";
import {
  acceptSteeredIdentity, reconcileSteeredIdentity, rejectSteeredIdentity,
  reserveSteeredIdentity, storedSteeringAcknowledgement,
} from "../../run-identity.js";
import { boundRunIssueId } from "../../run-task-binding.js";
import { isLowTrustQuarantined } from "../../source-trust.js";
import { NativeSessionSteeringError, steerNativeSession } from "../../native-runtime/native-session-executor.js";
import type { createInboundWakeAuthority } from "../inbound/wakeup-authorization.js";
import { resolveGitHubReviewInstructions } from "./review-instructions.js";
import { notifyGitHubReviewChecks } from "./review-check-work.js";

type Authorize = ReturnType<typeof createInboundWakeAuthority>["authorizeInboundWorkStart"];
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Action = typeof chatActions.$inferSelect;

export async function steerGitHubInboundWake(
  db: Db, action: Action, request: DurableChatWakeupRequest, authorize: Authorize,
): Promise<void> {
  const [endpoint] = await db.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(
    eq(chatEndpoints.companyId, action.companyId), eq(chatEndpoints.id, action.endpointId), eq(chatEndpoints.provider, "github"),
  ));
  if (!endpoint) return;
  const candidate = await db.transaction(async tx => {
    const [wake] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.id));
    if (!wake || wake.status !== "deferred_issue_execution" || wake.runId) return null;
    assertDurableChatWakeupReceipt(request, wake);
    const context = wake.payload?._paperclipWakeContext as Record<string, unknown> | undefined;
    if (context?.forceFreshSession || wake.payload?.executionWait ||
        !queuedCommentIdsFromWakePayload(wake.payload).includes(request.commentId)) return null;
    const current = await authorize(tx, action);
    if (!current.issue.executionRunId) return null;
    const [run] = await tx.select({
      id: heartbeatRuns.id, status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
      companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, responsibleUserId: heartbeatRuns.responsibleUserId,
      activeIdentityContextId: heartbeatRuns.activeIdentityContextId, nativeIssueId: heartbeatRuns.nativeIssueId,
      issueId: heartbeatRuns.issueId, contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object(
        'issueId', ${heartbeatRuns.contextSnapshot}->'issueId', 'chatConversationId', ${heartbeatRuns.contextSnapshot}->'chatConversationId',
        'wakeCommentId', ${heartbeatRuns.contextSnapshot}->'wakeCommentId')`,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, current.issue.executionRunId),
      eq(heartbeatRuns.companyId, request.companyId), eq(heartbeatRuns.agentId, request.agentId)));
    if (!run || run.status !== "running" || run.runtimeMode !== "native" || !run.activeIdentityContextId ||
        boundRunIssueId(run) !== request.issueId || run.contextSnapshot.chatConversationId !== current.conversation.id) return null;
    const [comment] = await tx.select().from(issueComments).where(and(eq(issueComments.id, request.commentId),
      eq(issueComments.companyId, request.companyId), eq(issueComments.issueId, request.issueId), isNull(issueComments.deletedAt)));
    const [origin] = await tx.select({ sourceTrust: issueComments.sourceTrust }).from(issueComments).where(and(
      eq(issueComments.id, String(run.contextSnapshot.wakeCommentId)), eq(issueComments.companyId, request.companyId),
      eq(issueComments.issueId, request.issueId),
    ));
    const [attachment] = await tx.select({ id: issueAttachments.id }).from(issueAttachments)
      .where(and(eq(issueAttachments.companyId, request.companyId), eq(issueAttachments.issueCommentId, request.commentId))).limit(1);
    if (!comment || comment.authorUserId !== run.responsibleUserId || !origin || attachment ||
        isLowTrustQuarantined(comment.sourceTrust) !== isLowTrustQuarantined(origin.sourceTrust)) return null;
    const instructions = await resolveGitHubReviewInstructions({ db: tx as unknown as Db,
      companyId: request.companyId, agentId: request.agentId, issueId: request.issueId, commentIds: [request.commentId] });
    return { run, comment, message: [...instructions.map(entry => entry.instructions),
      `GitHub update (comment ${comment.id}):\n${comment.body}`].join("\n\n") };
  });
  if (!candidate) return;
  const identity = await reserveSteeredIdentity(db, { companyId: request.companyId, runId: candidate.run.id,
    issueId: request.issueId, messageId: request.commentId });
  if (!identity) return;

  async function consume(tx: Transaction, turnId: string) {
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, request.id),
      eq(agentWakeupRequests.companyId, request.companyId))).for("update");
    if (!wake || wake.status !== "deferred_issue_execution" || wake.runId) return;
    assertDurableChatWakeupReceipt(request, wake);
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, candidate!.run.id),
      eq(heartbeatRuns.companyId, request.companyId), eq(heartbeatRuns.agentId, request.agentId))).for("no key update");
    if (!run || boundRunIssueId(run) !== request.issueId) return;
    await acceptSteeredIdentity(tx, identity!);
    const now = new Date();
    const result = run.resultJson ?? {};
    await tx.update(heartbeatRuns).set({
      contextSnapshot: { ...run.contextSnapshot, wakeCommentId: request.commentId,
        wakeCommentIds: [...new Set([...(Array.isArray(run.contextSnapshot?.wakeCommentIds)
          ? run.contextSnapshot.wakeCommentIds as string[] : []), request.commentId])] },
      resultJson: { ...result, queuedSteeringAcknowledgements: {
        ...(result.queuedSteeringAcknowledgements as Record<string, unknown> | undefined),
        [request.commentId]: { status: "acknowledged", queueId: request.id, turnId, acknowledgedAt: now.toISOString() },
      } }, updatedAt: now,
    }).where(eq(heartbeatRuns.id, run.id));
    await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: run.id, finishedAt: now, updatedAt: now })
      .where(eq(agentWakeupRequests.id, wake.id));
    await notifyGitHubReviewChecks(tx, { companyId: request.companyId, endpointId: action.endpointId, issueId: request.issueId });
    await tx.update(chatGitHubReviews).set({ runId: run.id, state: "running", updatedAt: now }).where(and(
      eq(chatGitHubReviews.companyId, request.companyId), eq(chatGitHubReviews.endpointId, action.endpointId),
      eq(chatGitHubReviews.deliveryId, action.deliveryId!), eq(chatGitHubReviews.state, "queued"),
    ));
    await notifyChatRunMilestones(tx, { companyId: request.companyId, issueId: request.issueId });
    await logActivity(tx as unknown as Db, { companyId: request.companyId, actorType: "system", actorId: "github-inbound",
      action: "issue.queued_comment_steered", entityType: "issue", entityId: request.issueId,
      details: { commentId: request.commentId, targetRunId: run.id, turnId, automatic: true } });
  }

  const reconcile = async () => {
    await reconcileSteeredIdentity(db, identity);
    const acknowledgement = await storedSteeringAcknowledgement(db, identity);
    if (!acknowledgement) return;
    await db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, request.issueId),
        eq(issues.companyId, request.companyId))).for("update");
      await consume(tx, acknowledgement.turnId);
    });
  };
  let deliveryAttempted = false;
  try {
    const acknowledged = await db.transaction(async tx => {
      const current = await authorize(tx, action);
      if (current.issue.executionRunId !== candidate.run.id) return;
      const [wake] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.id)).for("update");
      if (!wake || wake.status !== "deferred_issue_execution" || wake.runId) return;
      assertDurableChatWakeupReceipt(request, wake);
      if (!queuedCommentIdsFromWakePayload(wake.payload).includes(request.commentId)) return;
      const [comment] = await tx.select({ updatedAt: issueComments.updatedAt }).from(issueComments)
        .where(eq(issueComments.id, request.commentId));
      if (comment?.updatedAt.getTime() !== candidate.comment.updatedAt.getTime()) return;
      deliveryAttempted = true;
      const acknowledgement = await storedSteeringAcknowledgement(tx, identity) ?? await steerNativeSession({
        runId: candidate.run.id, correlationId: request.commentId, message: candidate.message, onAcknowledged: reconcile,
      });
      await consume(tx, acknowledgement.turnId);
      return true;
    });
    if (!acknowledged) await rejectSteeredIdentity(db, identity);
  } catch (error) {
    if (!deliveryAttempted || (error instanceof NativeSessionSteeringError && error.code !== "steering_timeout")) {
      await rejectSteeredIdentity(db, identity);
    }
    if (error instanceof NativeSessionSteeringError) return;
    throw error;
  }
}
