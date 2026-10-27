import { createHash } from "node:crypto";
import { HttpError } from "../../../errors.js";
import { chatRunSourceMessageId } from "../run-origin.js";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { chatActions, chatConversations, chatEndpointResources, chatEndpoints, chatGitHubReviews, chatMessageLinks, heartbeatRuns, toolConnections, type Db } from "@paperclipai/db";

export async function hasPublishedGitHubReview(db: Db, binding: {
  companyId: string;
  issueId: string;
  runId: string;
}): Promise<boolean> {
  const reviews = await db.select({ id: chatGitHubReviews.id, endpointId: chatGitHubReviews.endpointId })
    .from(chatGitHubReviews)
    .where(and(
      eq(chatGitHubReviews.companyId, binding.companyId),
      eq(chatGitHubReviews.issueId, binding.issueId),
      eq(chatGitHubReviews.runId, binding.runId),
      eq(chatGitHubReviews.state, "completed"),
    ));
  if (!reviews.length) return false;
  const [publication] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
    eq(chatActions.companyId, binding.companyId),
    or(...reviews.map(review => and(
      eq(chatActions.endpointId, review.endpointId),
      eq(chatActions.providerActionId, `github_publication:${binding.issueId}:assessment:${createHash("sha256").update(JSON.stringify(review.id)).digest("hex")}`),
    ))),
    eq(chatActions.kind, "github_review_publication"),
    eq(chatActions.status, "processed"),
  )).limit(1);
  return !!publication;
}

type WaitRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "responsibleUserId" | "activeIdentityContextId" | "nativeIssueId" | "issueId" | "contextSnapshot">;

/** Passive review waits inherit the same accepted requester lineage as GitHub
 * tools. This is not a grant to publish, run a monitor, or reuse attachments. */
export async function readInheritedGitHubReviewWait(db: Db, run: WaitRun) {
  if (!run.activeIdentityContextId || !run.nativeIssueId) return null;
  let commentId: string | null;
  try {
    commentId = await chatRunSourceMessageId(db, run, { provider: "github" });
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return { kind: "revoked" as const };
    throw error;
  }
  if (!commentId) return null;
  const [review] = await db.select({
    id: chatGitHubReviews.id, endpointId: chatGitHubReviews.endpointId,
    state: chatGitHubReviews.state, repository: chatGitHubReviews.repository,
    repositoryId: chatGitHubReviews.repositoryId, headSha: chatGitHubReviews.headSha,
    assessment: chatGitHubReviews.assessment, reviewRunId: chatGitHubReviews.runId,
    connectionEnabled: toolConnections.enabled, connectionStatus: toolConnections.status,
    reviewAgentId: heartbeatRuns.agentId, reviewCompanyId: heartbeatRuns.companyId,
    resourceRepository: chatEndpointResources.providerResourceId,
    resourceRepositoryId: sql<string | null>`${chatEndpointResources.metadata}->>'providerRepositoryId'`,
    pullNumber: chatGitHubReviews.pullNumber, thread: chatConversations.externalThreadId,
  }).from(chatMessageLinks)
    .innerJoin(chatConversations, and(eq(chatConversations.id, chatMessageLinks.conversationId),
      eq(chatConversations.companyId, run.companyId), eq(chatConversations.issueId, run.nativeIssueId)))
    .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatConversations.endpointId),
      eq(chatEndpoints.companyId, run.companyId), eq(chatEndpoints.provider, "github"),
      eq(chatEndpoints.assignedAgentId, run.agentId)))
    .leftJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId),
      eq(toolConnections.companyId, run.companyId)))
    .innerJoin(chatEndpointResources, and(eq(chatEndpointResources.id, chatConversations.resourceId),
      eq(chatEndpointResources.companyId, run.companyId), eq(chatEndpointResources.endpointId, chatEndpoints.id)))
    .innerJoin(chatGitHubReviews, and(eq(chatGitHubReviews.endpointId, chatEndpoints.id),
      eq(chatGitHubReviews.companyId, run.companyId), eq(chatGitHubReviews.issueId, run.nativeIssueId)))
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, chatGitHubReviews.runId))
    .where(and(eq(chatMessageLinks.companyId, run.companyId), eq(chatMessageLinks.commentId, commentId),
      eq(chatMessageLinks.direction, "inbound")))
    .orderBy(desc(chatGitHubReviews.createdAt), desc(chatGitHubReviews.id)).limit(1);
  // A newer unreviewed head cannot inherit the prior head's publication.
  if (!review) return null;
  if (!review.connectionEnabled || review.connectionStatus !== "active" || review.state !== "completed" ||
      review.reviewCompanyId !== run.companyId || review.reviewAgentId !== run.agentId ||
      review.assessment?.reviewedCommit !== review.headSha ||
      review.resourceRepository.toLowerCase() !== review.repository.toLowerCase() ||
      review.resourceRepositoryId !== review.repositoryId ||
      review.thread.toLowerCase() !== `github:${review.repository}:${review.pullNumber}`.toLowerCase()) return { kind: "revoked" as const };
  const [publication] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
    eq(chatActions.companyId, run.companyId), eq(chatActions.endpointId, review.endpointId),
    eq(chatActions.kind, "github_review_publication"), eq(chatActions.status, "processed"),
    eq(chatActions.providerActionId, `github_publication:${run.nativeIssueId}:assessment:${createHash("sha256").update(JSON.stringify(review.id)).digest("hex")}`),
  )).limit(1);
  if (!publication) return { kind: "revoked" as const };
  // The caller must still verify live task ownership, destination and principal
  // policy. This normalized source is used only by the passive-wait boundary.
  return { kind: "published" as const, endpointId: review.endpointId, reviewId: review.id, reviewRunId: review.reviewRunId,
    headSha: review.headSha, context: {
    source: "chat:github", paperclipHarnessCheckedOut: true,
    wakeCommentId: commentId, wakeCommentIds: [commentId],
    paperclipWake: { checkedOutByHarness: true, externalChatProvider: "github",
      issue: { id: run.nativeIssueId }, commentIds: [commentId] },
  } };
}
