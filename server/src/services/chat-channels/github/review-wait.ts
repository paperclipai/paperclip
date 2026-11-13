import { createHash } from "node:crypto";
import { HttpError } from "../../../errors.js";
import { chatRunSourceMessageId, chatRunSourceMessageIds } from "../run-origin.js";
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
      eq(chatActions.providerActionId, publicationActionId(binding.issueId, review.id)),
    ))),
    eq(chatActions.kind, "github_review_publication"),
    eq(chatActions.status, "processed"),
  )).limit(1);
  return !!publication;
}

type WaitRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "responsibleUserId" | "activeIdentityContextId" | "nativeIssueId" | "issueId" | "contextSnapshot">;

/** The columns of one inherited review. The single read and the batch read
 * select the same columns. */
const inheritedReviewFields = {
  id: chatGitHubReviews.id, endpointId: chatGitHubReviews.endpointId,
  state: chatGitHubReviews.state, repository: chatGitHubReviews.repository,
  repositoryId: chatGitHubReviews.repositoryId, headSha: chatGitHubReviews.headSha,
  reviewedCommit: sql<unknown>`${chatGitHubReviews.assessment}->'reviewedCommit'`, reviewRunId: chatGitHubReviews.runId,
  connectionEnabled: toolConnections.enabled, connectionStatus: toolConnections.status,
  reviewAgentId: heartbeatRuns.agentId, reviewCompanyId: heartbeatRuns.companyId,
  resourceRepository: chatEndpointResources.providerResourceId,
  resourceRepositoryId: sql<string | null>`${chatEndpointResources.metadata}->>'providerRepositoryId'`,
  pullNumber: chatGitHubReviews.pullNumber, thread: chatConversations.externalThreadId,
};

const inheritedReviewQueries = new WeakMap<Db, ReturnType<typeof prepareInheritedReviewQuery>>();

function prepareInheritedReviewQuery(db: Db) {
  return db.select(inheritedReviewFields).from(chatMessageLinks)
    .innerJoin(chatConversations, and(eq(chatConversations.id, chatMessageLinks.conversationId),
      eq(chatConversations.companyId, sql.placeholder("companyId")), eq(chatConversations.issueId, sql.placeholder("issueId"))))
    .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatConversations.endpointId),
      eq(chatEndpoints.companyId, sql.placeholder("companyId")), eq(chatEndpoints.provider, "github"),
      eq(chatEndpoints.assignedAgentId, sql.placeholder("agentId"))))
    .leftJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId),
      eq(toolConnections.companyId, sql.placeholder("companyId"))))
    .innerJoin(chatEndpointResources, and(eq(chatEndpointResources.id, chatConversations.resourceId),
      eq(chatEndpointResources.companyId, sql.placeholder("companyId")), eq(chatEndpointResources.endpointId, chatEndpoints.id)))
    .innerJoin(chatGitHubReviews, and(eq(chatGitHubReviews.endpointId, chatEndpoints.id),
      eq(chatGitHubReviews.companyId, sql.placeholder("companyId")), eq(chatGitHubReviews.issueId, sql.placeholder("issueId"))))
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, chatGitHubReviews.runId))
    .where(and(eq(chatMessageLinks.companyId, sql.placeholder("companyId")), eq(chatMessageLinks.commentId, sql.placeholder("commentId")),
      eq(chatMessageLinks.direction, "inbound")))
    .orderBy(desc(chatGitHubReviews.createdAt), desc(chatGitHubReviews.id)).limit(1)
    .prepare("inherited_github_review_wait");
}

type InheritedReviewRow = Awaited<ReturnType<ReturnType<typeof prepareInheritedReviewQuery>["execute"]>>[number];

function inheritedReviewQuery(db: Db) {
  let query = inheritedReviewQueries.get(db);
  if (!query) {
    query = prepareInheritedReviewQuery(db);
    inheritedReviewQueries.set(db, query);
  }
  return query;
}

type InheritedReviewKey = { commentId: string; issueId: string; agentId: string };

function inheritedReviewKey(key: InheritedReviewKey) {
  return `${key.commentId}:${key.issueId}:${key.agentId}`;
}

/** The latest review for each (source comment, task, agent) key of one
 * company. For each key this is the row of the single prepared read: the same
 * joins and filters, and DISTINCT ON keeps the first row in the same order. */
async function readInheritedReviewsForKeys(db: Db, companyId: string, keys: InheritedReviewKey[]) {
  const unique = (values: string[]) => [...new Set(values)];
  const rows = await db.selectDistinctOn([chatMessageLinks.commentId, chatConversations.issueId, chatEndpoints.assignedAgentId], {
    ...inheritedReviewFields,
    keyCommentId: chatMessageLinks.commentId, keyIssueId: chatConversations.issueId, keyAgentId: chatEndpoints.assignedAgentId,
  }).from(chatMessageLinks)
    .innerJoin(chatConversations, and(eq(chatConversations.id, chatMessageLinks.conversationId),
      eq(chatConversations.companyId, companyId),
      sql`${chatConversations.issueId} = any(${sql.param(unique(keys.map(key => key.issueId)))}::uuid[])`))
    .innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatConversations.endpointId),
      eq(chatEndpoints.companyId, companyId), eq(chatEndpoints.provider, "github"),
      sql`${chatEndpoints.assignedAgentId} = any(${sql.param(unique(keys.map(key => key.agentId)))}::uuid[])`))
    .leftJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId),
      eq(toolConnections.companyId, companyId)))
    .innerJoin(chatEndpointResources, and(eq(chatEndpointResources.id, chatConversations.resourceId),
      eq(chatEndpointResources.companyId, companyId), eq(chatEndpointResources.endpointId, chatEndpoints.id)))
    .innerJoin(chatGitHubReviews, and(eq(chatGitHubReviews.endpointId, chatEndpoints.id),
      eq(chatGitHubReviews.companyId, companyId), eq(chatGitHubReviews.issueId, chatConversations.issueId)))
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, chatGitHubReviews.runId))
    .where(and(eq(chatMessageLinks.companyId, companyId),
      sql`${chatMessageLinks.commentId} = any(${sql.param(unique(keys.map(key => key.commentId)))}::uuid[])`,
      eq(chatMessageLinks.direction, "inbound")))
    .orderBy(chatMessageLinks.commentId, chatConversations.issueId, chatEndpoints.assignedAgentId,
      desc(chatGitHubReviews.createdAt), desc(chatGitHubReviews.id));
  // The array filters can also match a mix of two keys. Only exact keys are read.
  const byKey = new Map<string, InheritedReviewRow>();
  for (const { keyCommentId, keyIssueId, keyAgentId, ...review } of rows) {
    if (keyCommentId && keyIssueId && keyAgentId) {
      byKey.set(inheritedReviewKey({ commentId: keyCommentId, issueId: keyIssueId, agentId: keyAgentId }), review);
    }
  }
  return byKey;
}

function publicationActionId(issueId: string, reviewId: string) {
  return `github_publication:${issueId}:assessment:${createHash("sha256").update(JSON.stringify(reviewId)).digest("hex")}`;
}

/** The accepted GitHub source comment of the run. A changed requester lineage
 * revokes the inherited wait. */
async function inheritedSourceComment(db: Db, run: WaitRun): Promise<{ kind: "revoked" } | { commentId: string } | null> {
  if (!run.activeIdentityContextId || !run.nativeIssueId) return null;
  let commentId: string | null;
  try {
    commentId = await chatRunSourceMessageId(db, run, { provider: "github" });
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return { kind: "revoked" };
    throw error;
  }
  return commentId ? { commentId } : null;
}

/** `inheritedSourceComment` for the runs of one pass. The lineage of every
 * run is checked with the statements of one batch, not with separate reads
 * for each run. */
async function inheritedSourceComments(db: Db, runs: WaitRun[]) {
  const candidates = runs.filter(run => run.activeIdentityContextId && run.nativeIssueId);
  const checked = await chatRunSourceMessageIds(db, candidates, { provider: "github" });
  const sources = new Map(candidates.map((run, index) => [run, checked[index]!]));
  return runs.map((run): Awaited<ReturnType<typeof inheritedSourceComment>> => {
    const source = sources.get(run);
    if (!source) return null;
    if ("forbidden" in source) return { kind: "revoked" };
    return source.messageId ? { commentId: source.messageId } : null;
  });
}

function inheritedReviewRevoked(run: WaitRun, review: InheritedReviewRow) {
  return !review.connectionEnabled || review.connectionStatus !== "active" || review.state !== "completed" ||
    review.reviewCompanyId !== run.companyId || review.reviewAgentId !== run.agentId ||
    review.reviewedCommit !== review.headSha ||
    review.resourceRepository.toLowerCase() !== review.repository.toLowerCase() ||
    review.resourceRepositoryId !== review.repositoryId ||
    review.thread.toLowerCase() !== `github:${review.repository}:${review.pullNumber}`.toLowerCase();
}

function publishedInheritedWait(run: WaitRun, commentId: string, review: InheritedReviewRow) {
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

export type InheritedGitHubReviewWait = { kind: "revoked" } | ReturnType<typeof publishedInheritedWait> | null;

/** Passive review waits inherit the same accepted requester lineage as GitHub
 * tools. This is not a grant to publish, run a monitor, or reuse attachments. */
export async function readInheritedGitHubReviewWait(db: Db, run: WaitRun): Promise<InheritedGitHubReviewWait> {
  const source = await inheritedSourceComment(db, run);
  if (!source || !("commentId" in source)) return source;
  const { commentId } = source;
  const [review] = await inheritedReviewQuery(db).execute({
    companyId: run.companyId, issueId: run.nativeIssueId, agentId: run.agentId, commentId,
  });
  // A newer unreviewed head cannot inherit the prior head's publication.
  if (!review) return null;
  if (inheritedReviewRevoked(run, review)) return { kind: "revoked" };
  const [publication] = await db.select({ id: chatActions.id }).from(chatActions).where(and(
    eq(chatActions.companyId, run.companyId), eq(chatActions.endpointId, review.endpointId),
    eq(chatActions.kind, "github_review_publication"), eq(chatActions.status, "processed"),
    eq(chatActions.providerActionId, publicationActionId(run.nativeIssueId!, review.id)),
  )).limit(1);
  if (!publication) return { kind: "revoked" };
  return publishedInheritedWait(run, commentId, review);
}

/** `readInheritedGitHubReviewWait` for the runs of one read-only pass, such
 * as the waits of an issue page. Each run gets the same result as a separate
 * call. The source lineage is still checked for each run, with the same
 * decision. The lineage reads of all the runs share their statements, and the
 * reviews and the publications of all the runs of one company are read with
 * one statement each, so the number of statements does not follow the number
 * of runs. */
export async function readInheritedGitHubReviewWaits(db: Db, runs: WaitRun[]): Promise<InheritedGitHubReviewWait[]> {
  const sources = await inheritedSourceComments(db, runs);
  const results: InheritedGitHubReviewWait[] = sources.map(source => source && !("commentId" in source) ? source : null);
  const byCompany = new Map<string, Array<{ index: number; run: WaitRun; commentId: string }>>();
  runs.forEach((run, index) => {
    const source = sources[index];
    if (!source || !("commentId" in source)) return;
    const entries = byCompany.get(run.companyId) ?? [];
    entries.push({ index, run, commentId: source.commentId });
    byCompany.set(run.companyId, entries);
  });
  for (const [companyId, entries] of byCompany) {
    const keyOf = ({ run, commentId }: { run: WaitRun; commentId: string }) =>
      ({ commentId, issueId: run.nativeIssueId!, agentId: run.agentId });
    const reviews = await readInheritedReviewsForKeys(db, companyId, entries.map(keyOf));
    const reviewed: Array<{ index: number; run: WaitRun; commentId: string; review: InheritedReviewRow; actionId: string }> = [];
    for (const entry of entries) {
      const review = reviews.get(inheritedReviewKey(keyOf(entry)));
      // A newer unreviewed head cannot inherit the prior head's publication.
      if (!review) continue;
      if (inheritedReviewRevoked(entry.run, review)) {
        results[entry.index] = { kind: "revoked" };
        continue;
      }
      reviewed.push({ ...entry, review, actionId: publicationActionId(entry.run.nativeIssueId!, review.id) });
    }
    if (!reviewed.length) continue;
    const publications = await db.select({ endpointId: chatActions.endpointId, providerActionId: chatActions.providerActionId })
      .from(chatActions).where(and(
        eq(chatActions.companyId, companyId),
        sql`${chatActions.endpointId} = any(${sql.param([...new Set(reviewed.map(entry => entry.review.endpointId))])}::uuid[])`,
        eq(chatActions.kind, "github_review_publication"), eq(chatActions.status, "processed"),
        sql`${chatActions.providerActionId} = any(${sql.param([...new Set(reviewed.map(entry => entry.actionId))])}::text[])`,
      ));
    const processed = new Set(publications.map(publication => `${publication.endpointId}:${publication.providerActionId}`));
    for (const { index, run, commentId, review, actionId } of reviewed) {
      results[index] = processed.has(`${review.endpointId}:${actionId}`)
        ? publishedInheritedWait(run, commentId, review) : { kind: "revoked" };
    }
  }
  return results;
}
