import { createHash, randomUUID } from "node:crypto";
import { and, eq, fillPlaceholders } from "drizzle-orm";
import { agents, chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints,
  chatGitHubConfigurations, chatGitHubReviews, chatMessageLinks, companies, heartbeatRuns, issueComments, issues,
  runIdentityContexts, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";

export async function seedGitHubReviewWait(db: Db) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
  const reviewRunId = randomUUID(), reviewId = randomUUID(), endpointId = randomUUID(), resourceId = randomUUID();
  const conversationId = randomUUID(), commentId = randomUUID(), activeIdentityContextId = randomUUID();
  const applicationId = randomUUID(), connectionId = randomUUID(), publicationId = randomUUID();
  const headSha = "1".repeat(40), repository = "synthetic/repository", repositoryId = "42", pullNumber = 7;
  await db.insert(companies).values({ id: companyId, name: "Synthetic review", issuePrefix: companyId });
  await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "process" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Review", assigneeAgentId: agentId });
  await db.insert(heartbeatRuns).values([
    { id: runId, companyId, agentId, nativeIssueId: issueId, responsibleUserId: "operator", activeIdentityContextId },
    { id: reviewRunId, companyId, agentId, nativeIssueId: issueId, status: "succeeded" },
  ]);
  await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorUserId: "operator", body: "Review" });
  await db.insert(runIdentityContexts).values({ id: activeIdentityContextId, companyId, runId, revision: 1,
    responsibleUserId: "operator", messageId: commentId, cause: "test", correlationId: "test", status: "accepted" });
  await db.insert(toolApplications).values({ id: applicationId, companyId, name: "GitHub", type: "chat" });
  await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "GitHub",
    uid: connectionId, transport: "chat_sdk", connectionPurpose: "channel", enabled: true, status: "active" });
  await db.insert(chatEndpoints).values({ id: endpointId, companyId, connectionId, provider: "github",
    publicId: endpointId, assignedAgentId: agentId });
  await db.insert(chatEndpointResources).values({ id: resourceId, companyId, endpointId, type: "repository",
    providerResourceId: repository, label: repository, metadata: { providerRepositoryId: repositoryId } });
  await db.insert(chatConversations).values({ id: conversationId, companyId, endpointId, resourceId, issueId,
    externalConversationId: repository, externalThreadId: `github:${repository}:${pullNumber}`, externalLabel: "Review" });
  await db.insert(chatMessageLinks).values({ companyId, endpointId, conversationId, commentId,
    providerMessageId: commentId, direction: "inbound" });
  await db.insert(chatGitHubReviews).values({ id: reviewId, companyId, endpointId, issueId, runId: reviewRunId,
    repositoryId, repository, pullNumber, headSha, deliveryId: reviewId, configurationRevision: 1,
    state: "completed", policySnapshot: defaultGitHubReviewPolicy(),
    event: { event: "mention", deliveryId: reviewId, repositoryId, repository, pullNumber, title: "Review", body: "",
      baseSha: "0".repeat(40), headSha, baseBranch: "main", author: { id: "1", login: "author", isBot: false },
      sender: { id: "1", login: "author" }, draft: false, labels: [] },
    assessment: { reviewedCommit: headSha, score: 5, complete: true, summary: "Reviewed", rationale: "Reviewed",
      coverage: { reviewedPaths: [], omittedPaths: [], limitations: [] }, findings: [] } });
  await db.insert(chatActions).values({ id: publicationId, companyId, endpointId, kind: "github_review_publication",
    providerActionId: `github_publication:${issueId}:assessment:${createHash("sha256").update(JSON.stringify(reviewId)).digest("hex")}`,
    status: "processed" });
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  return { run: run!, companyId, agentId, issueId, runId, reviewRunId, reviewId, endpointId, resourceId,
    conversationId, commentId, activeIdentityContextId, connectionId, publicationId, headSha };
}

export function setGitHubReviewAssessment(db: Db, reviewId: string, assessment: unknown) {
  return db.$client.unsafe("UPDATE chat_github_reviews SET assessment = $1::jsonb WHERE id = $2::uuid",
    [JSON.stringify(assessment), reviewId]);
}

export type CapturedReviewWaitQuery = { sql: string; params: unknown[] };
export function captureReviewWaitQueries(db: Db, queries: CapturedReviewWaitQuery[]): Db {
  return new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields), from = builder.from.bind(builder);
      builder.from = ((...args: Parameters<typeof from>) => {
        const selection = from(...args), execute = selection.execute.bind(selection);
        const prepare = selection.prepare.bind(selection);
        selection.prepare = ((...args: Parameters<typeof prepare>) => {
          const prepared = prepare(...args), executePrepared = prepared.execute.bind(prepared);
          prepared.execute = async (values = {}) => {
            const query = prepared.getQuery();
            queries.push({ sql: query.sql, params: fillPlaceholders(query.params, values) });
            return executePrepared(values);
          };
          return prepared;
        }) as typeof selection.prepare;
        selection.execute = async () => { queries.push(selection.toSQL()); return execute(); };
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  }});
}

/** Extend the review-wait fixture to a check action whose review has no run
 * yet, so the check state must find the wake run from the inbound comment. */
export async function seedGitHubReviewCheck(db: Db) {
  const f = await seedGitHubReviewWait(db);
  const githubDeliveryId = randomUUID(), chatDeliveryId = randomUUID(), wakeRunId = randomUUID();
  const event = { deliveryId: githubDeliveryId, repository: "synthetic/repository", repositoryId: "42",
    pullNumber: 7, headSha: f.headSha };
  await db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, f.endpointId));
  await db.update(chatEndpointResources).set({ enabled: true, availability: "available" })
    .where(eq(chatEndpointResources.id, f.resourceId));
  await db.insert(chatGitHubConfigurations).values({ endpointId: f.endpointId, companyId: f.companyId,
    configuration: { toolsEnabled: true } as never, updatedByUserId: "operator" });
  await db.insert(chatDeliveries).values({ id: chatDeliveryId, companyId: f.companyId, endpointId: f.endpointId,
    conversationId: f.conversationId, providerEventId: githubDeliveryId, deduplicationKey: githubDeliveryId,
    eventKind: "message", state: "processed", normalizedEvent: { githubAutomatic: { context: event } } });
  await db.update(chatMessageLinks).set({ deliveryId: chatDeliveryId })
    .where(and(eq(chatMessageLinks.companyId, f.companyId), eq(chatMessageLinks.commentId, f.commentId)));
  await db.insert(heartbeatRuns).values({ id: wakeRunId, companyId: f.companyId, agentId: f.agentId,
    nativeIssueId: f.issueId, status: "running", contextSnapshot: { wakeCommentId: f.commentId } });
  await db.update(chatGitHubReviews).set({ runId: null, assessment: null, state: "queued" })
    .where(eq(chatGitHubReviews.id, f.reviewId));
  const [action] = await db.insert(chatActions).values({ companyId: f.companyId, endpointId: f.endpointId,
    kind: "github_review_check", providerActionId: `github_review_check:${githubDeliveryId}`,
    payload: { event, admitted: true, runtimeGeneration: 0 } }).returning();
  return { ...f, action: action!, event, githubDeliveryId, chatDeliveryId, wakeRunId };
}

export async function revokeReviewWaitConnection(db: Db, fixture: Awaited<ReturnType<typeof seedGitHubReviewWait>>) {
  await db.update(toolConnections).set({ enabled: false }).where(and(
    eq(toolConnections.id, fixture.connectionId), eq(toolConnections.companyId, fixture.companyId)));
}
