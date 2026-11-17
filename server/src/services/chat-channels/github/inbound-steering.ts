import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  agentWakeupRequests, chatActions, chatEndpoints, chatGitHubReviews, heartbeatRuns,
  issueAttachments, issueComments, issues, runIdentityContexts, type Db,
} from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { logActivity } from "../../activity-log.js";
import { notifyChatRunMilestones } from "../../chat-run-milestone-notifications.js";
import { assertDurableChatWakeupReceipt, createDurableChatWakeupRequest, type DurableChatWakeupRequest } from "../../durable-chat-wakeup.js";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInRunContext } from "../../issue-queued-comment-queue.js";
import { acceptSteeredIdentity, rejectSteeredIdentity, reserveSteeredIdentity, storedSteeringAcknowledgement } from "../../run-identity.js";
import { deliverSteeredMessage, steeringDeliveryIsUncertain } from "../../queued-comment-steering.js";
import { boundRunIssueId } from "../../run-task-binding.js";
import { isLowTrustQuarantined } from "../../source-trust.js";
import { NativeSessionSteeringError } from "../../native-runtime/native-session-executor.js";
import type { createInboundWakeAuthority } from "../inbound/wakeup-authorization.js";
import { resolveGitHubReviewInstructions } from "./review-instructions.js";
import { notifyGitHubReviewChecks } from "./review-check-work.js";

type Authorize = ReturnType<typeof createInboundWakeAuthority>["authorizeInboundWorkStart"];
type Action = typeof chatActions.$inferSelect;
type SteeringReceipt = { runId: string; identityId: string; commentUpdatedAt: string; commentDigest: string };
const commentDigest = (body: string) => createHash("sha256").update(body).digest("hex");

async function hasSteeringReceipt(db: Pick<Db, "select">, issue: { companyId: string; id: string }) {
  const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
    sql`${agentWakeupRequests.payload} ? 'githubSteering'`,
  )).limit(1);
  return Boolean(wake);
}

export async function githubInboundWakeAdmission(db: Db,
  issue: Pick<typeof issues.$inferSelect, "companyId" | "id" | "executionRunId">) {
  const legacyRun = async (executor: Db) => !issue.executionRunId ? false : Boolean(await executor
    .select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, issue.executionRunId), eq(heartbeatRuns.companyId, issue.companyId),
      eq(heartbeatRuns.runtimeMode, "legacy"),
    )).for("no key update").then(rows => rows[0]));
  const allowRunCoalescing = await legacyRun(db) && !(await hasSteeringReceipt(db, issue));
  return {
    options: { allowRunCoalescing },
    authorize: async (tx: Db, current: Pick<typeof issues.$inferSelect, "executionRunId">) => {
      if (allowRunCoalescing && (current.executionRunId !== issue.executionRunId ||
          !(await legacyRun(tx)) || await hasSteeringReceipt(tx, issue))) {
        throw new Error("github_inbound_admission_changed");
      }
    },
  };
}

function steeringReceipt(payload: Record<string, unknown> | null): SteeringReceipt | null {
  const value = payload?.githubSteering as Partial<SteeringReceipt> | undefined;
  return value && typeof value.runId === "string" && isUuidLike(value.runId) &&
    typeof value.identityId === "string" && isUuidLike(value.identityId) && typeof value.commentUpdatedAt === "string" &&
    typeof value.commentDigest === "string" && /^[a-f0-9]{64}$/.test(value.commentDigest)
    ? value as SteeringReceipt : null;
}

async function consumeSteeredWake(db: Db, action: Action, request: DurableChatWakeupRequest,
  marker: SteeringReceipt, turnId: string): Promise<boolean> {
  return db.transaction(async tx => {
    const [task] = await tx.select({ id: issues.id, executionRunId: issues.executionRunId,
      continuationIdentityContextId: issues.continuationIdentityContextId }).from(issues).where(and(eq(issues.id, request.issueId),
      eq(issues.companyId, request.companyId))).for("update");
    if (!task) return false;
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, request.id),
      eq(agentWakeupRequests.companyId, request.companyId))).for("update");
    if (!wake) return false;
    assertDurableChatWakeupReceipt(request, wake);
    if (wake.status === "coalesced" && wake.runId === marker.runId) return true;
    const currentMarker = steeringReceipt(wake.payload);
    if (wake.status !== "deferred_issue_execution" || wake.runId ||
        !queuedCommentIdsFromWakePayload(wake.payload).includes(request.commentId) ||
        !currentMarker || currentMarker.runId !== marker.runId || currentMarker.identityId !== marker.identityId ||
        currentMarker.commentUpdatedAt !== marker.commentUpdatedAt || currentMarker.commentDigest !== marker.commentDigest) return false;
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, marker.runId),
      eq(heartbeatRuns.companyId, request.companyId), eq(heartbeatRuns.agentId, request.agentId))).for("no key update");
    const [identity] = await tx.select().from(runIdentityContexts).where(and(eq(runIdentityContexts.id, marker.identityId),
      eq(runIdentityContexts.companyId, request.companyId), eq(runIdentityContexts.runId, marker.runId),
      eq(runIdentityContexts.messageId, request.commentId), eq(runIdentityContexts.cause, "steering"),
      inArray(runIdentityContexts.status, ["pending", "accepted"])));
    if (!run || !identity || boundRunIssueId(run) !== request.issueId ||
        run.contextSnapshot?.chatConversationId !== action.conversationId) return false;
    await acceptSteeredIdentity(tx, identity);
    if ((task.executionRunId && task.executionRunId !== run.id) ||
        (task.continuationIdentityContextId !== run.activeIdentityContextId && task.continuationIdentityContextId !== identity.id)) await tx.update(issues)
      .set({ continuationIdentityContextId: task.continuationIdentityContextId }).where(eq(issues.id, task.id));
    const [comment] = await tx.select({ updatedAt: issueComments.updatedAt, body: issueComments.body }).from(issueComments)
      .where(and(eq(issueComments.id, request.commentId), eq(issueComments.companyId, request.companyId)));
    if (!comment || comment.updatedAt.toISOString() !== marker.commentUpdatedAt || commentDigest(comment.body) !== marker.commentDigest) return false;
    const [active] = await tx.select({ id: heartbeatRuns.activeIdentityContextId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const ids = [...new Set([...(Array.isArray(run.contextSnapshot?.wakeCommentIds)
      ? run.contextSnapshot.wakeCommentIds as string[] : []), request.commentId])];
    const comments = await tx.select({ id: issueComments.id, createdAt: issueComments.createdAt }).from(issueComments).where(and(
      eq(issueComments.companyId, request.companyId), eq(issueComments.issueId, request.issueId), inArray(issueComments.id, ids),
    ));
    const order = new Map(ids.map((id, index) => [id, index]));
    comments.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || order.get(left.id)! - order.get(right.id)!);
    const context = withQueuedCommentIdsInRunContext(run.contextSnapshot, comments.map(comment => comment.id), [request.id]);
    if (active.id !== identity.id) for (const key of ["wakeCommentId", "commentId"]) {
      if (run.contextSnapshot && key in run.contextSnapshot) context[key] = run.contextSnapshot[key];
      else delete context[key];
    }
    const now = new Date(), result = run.resultJson ?? {};
    await tx.update(heartbeatRuns).set({
      contextSnapshot: context,
      resultJson: { ...result, queuedSteeringAcknowledgements: {
        ...(result.queuedSteeringAcknowledgements as Record<string, unknown> | undefined),
        [request.commentId]: { status: "acknowledged", queueId: request.id, turnId, acknowledgedAt: now.toISOString() },
      } }, updatedAt: now,
    }).where(eq(heartbeatRuns.id, run.id));
    await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: run.id, finishedAt: now, updatedAt: now })
      .where(eq(agentWakeupRequests.id, wake.id));
    await notifyGitHubReviewChecks(tx, { companyId: request.companyId, endpointId: action.endpointId, issueId: request.issueId });
    await tx.update(chatGitHubReviews).set({ runId: run.id,
      state: run.status === "running" ? "running" : run.status === "succeeded" ? "incomplete" : "error", updatedAt: now }).where(and(
      eq(chatGitHubReviews.companyId, request.companyId), eq(chatGitHubReviews.endpointId, action.endpointId),
      eq(chatGitHubReviews.deliveryId, action.deliveryId!), eq(chatGitHubReviews.state, "queued"),
    ));
    await notifyChatRunMilestones(tx, { companyId: request.companyId, issueId: request.issueId });
    await logActivity(tx as unknown as Db, { companyId: request.companyId, actorType: "system", actorId: "github-inbound",
      action: "issue.queued_comment_steered", entityType: "issue", entityId: request.issueId,
      details: { commentId: request.commentId, targetRunId: run.id, turnId, automatic: true } });
    return true;
  });
}

export async function recoverGitHubSteeredWake(db: Db, action: Action, request?: DurableChatWakeupRequest): Promise<boolean> {
  const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, action.id),
    eq(agentWakeupRequests.companyId, action.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId)));
  const marker = wake && steeringReceipt(wake.payload);
  if (!marker) return false;
  const [endpoint] = await db.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(
    eq(chatEndpoints.companyId, action.companyId), eq(chatEndpoints.id, action.endpointId), eq(chatEndpoints.provider, "github"),
  ));
  if (!endpoint) return false;
  const source = request ?? createDurableChatWakeupRequest({
    id: action.id, companyId: action.companyId, agentId: String(action.payload.agentId), issueId: String(action.payload.issueId),
    commentId: String(action.payload.commentId), requestedByActorType: action.payload.requestedByActorType as "user" | "system",
    requestedByActorId: String(action.payload.requestedByActorId), requestedAt: action.createdAt, authorize: async () => {},
  });
  assertDurableChatWakeupReceipt(source, wake!);
  const [identity] = await db.select().from(runIdentityContexts).where(and(eq(runIdentityContexts.id, marker.identityId),
    eq(runIdentityContexts.companyId, source.companyId), eq(runIdentityContexts.runId, marker.runId),
    eq(runIdentityContexts.messageId, source.commentId), eq(runIdentityContexts.cause, "steering"),
    inArray(runIdentityContexts.status, ["pending", "accepted"])));
  if (!identity) return false;
  const acknowledgement = await storedSteeringAcknowledgement(db, identity);
  if (acknowledgement) return consumeSteeredWake(db, action, source, marker, acknowledgement.turnId);
  const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, marker.runId), eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.agentId, source.agentId)));
  if (!run || !["running", "queued"].includes(run.status)) await rejectSteeredIdentity(db, identity);
  return false;
}

export async function steerGitHubInboundWake(
  db: Db, action: Action, request: DurableChatWakeupRequest, authorize: Authorize,
): Promise<void> {
  const [endpoint] = await db.select({ id: chatEndpoints.id }).from(chatEndpoints).where(and(
    eq(chatEndpoints.companyId, action.companyId), eq(chatEndpoints.id, action.endpointId), eq(chatEndpoints.provider, "github"),
  ));
  if (!endpoint || await recoverGitHubSteeredWake(db, action, request)) return;
  const candidate = await db.transaction(async tx => {
    const [wake] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.id));
    if (!wake || wake.status !== "deferred_issue_execution" || wake.runId || wake.payload?.githubSteering) return null;
    assertDurableChatWakeupReceipt(request, wake);
    const context = wake.payload?._paperclipWakeContext as Record<string, unknown> | undefined;
    if (context?.forceFreshSession || wake.payload?.executionWait || !queuedCommentIdsFromWakePayload(wake.payload).includes(request.commentId)) return null;
    if (Array.isArray(context?.externalAttachmentOmissions) && context.externalAttachmentOmissions.some(entry =>
      entry?.commentId === request.commentId && entry.reasons && typeof entry.reasons === "object" &&
      Object.values(entry.reasons).some(count => typeof count === "number" && count > 0))) return null;
    const current = await authorize(tx, action);
    if (!current.issue.executionRunId) return null;
    const [run] = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
      responsibleUserId: heartbeatRuns.responsibleUserId, activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
      nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
      contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
        'chatConversationId', ${heartbeatRuns.contextSnapshot}->'chatConversationId', 'wakeCommentId', ${heartbeatRuns.contextSnapshot}->'wakeCommentId')`,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, current.issue.executionRunId),
      eq(heartbeatRuns.companyId, request.companyId), eq(heartbeatRuns.agentId, request.agentId)));
    if (!run || run.status !== "running" || run.runtimeMode !== "native" || !run.activeIdentityContextId ||
        boundRunIssueId(run) !== request.issueId || run.contextSnapshot.chatConversationId !== current.conversation.id) return null;
    const [comment] = await tx.select().from(issueComments).where(and(eq(issueComments.id, request.commentId),
      eq(issueComments.companyId, request.companyId), eq(issueComments.issueId, request.issueId), isNull(issueComments.deletedAt)));
    const [origin] = await tx.select({ sourceTrust: issueComments.sourceTrust }).from(issueComments).where(and(
      eq(issueComments.id, String(run.contextSnapshot.wakeCommentId)), eq(issueComments.companyId, request.companyId), eq(issueComments.issueId, request.issueId),
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
  let deliveryAttempted = false;
  try {
    const marker = await db.transaction(async tx => {
      const current = await authorize(tx, action);
      if (current.issue.executionRunId !== candidate.run.id) return null;
      const [wake] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.id)).for("update");
      if (!wake || wake.status !== "deferred_issue_execution" || wake.runId || wake.payload?.githubSteering) return null;
      assertDurableChatWakeupReceipt(request, wake);
      if (!queuedCommentIdsFromWakePayload(wake.payload).includes(request.commentId)) return null;
      const [comment] = await tx.select({ updatedAt: issueComments.updatedAt }).from(issueComments).where(eq(issueComments.id, request.commentId));
      const [run] = await tx.select({ status: heartbeatRuns.status, responsibleUserId: heartbeatRuns.responsibleUserId })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, candidate.run.id));
      if (comment?.updatedAt.getTime() !== candidate.comment.updatedAt.getTime() ||
          run?.status !== "running" || run.responsibleUserId !== candidate.comment.authorUserId) return null;
      const marker: SteeringReceipt = { runId: candidate.run.id, identityId: identity.id,
        commentUpdatedAt: candidate.comment.updatedAt.toISOString(), commentDigest: commentDigest(candidate.comment.body) };
      await tx.update(agentWakeupRequests).set({ payload: { ...wake.payload, githubSteering: marker }, updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wake.id));
      return marker;
    });
    if (!marker) { await rejectSteeredIdentity(db, identity); return; }
    deliveryAttempted = true;
    const acknowledgement = await deliverSteeredMessage(db, { companyId: request.companyId, runId: candidate.run.id,
      messageId: request.commentId, message: candidate.message, identity,
      onAcknowledged: async () => { await recoverGitHubSteeredWake(db, action, request); } });
    await consumeSteeredWake(db, action, request, marker, acknowledgement.turnId);
  } catch (error) {
    if (!steeringDeliveryIsUncertain(error, deliveryAttempted)) await rejectSteeredIdentity(db, identity);
    if (error instanceof NativeSessionSteeringError) return;
    throw error;
  }
}
