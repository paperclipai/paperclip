import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, chatActions, chatConversations, chatEndpointResources, chatEndpoints,
  chatGitHubReviews, chatMessageLinks, companies, heartbeatRuns, issueComments, issues,
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
    assessment: { reviewedCommit: headSha, score: 5, complete: true, summary: "Reviewed", findings: [] } });
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
        selection.execute = async () => { queries.push(selection.toSQL()); return execute(); };
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  }});
}

export async function revokeReviewWaitConnection(db: Db, fixture: Awaited<ReturnType<typeof seedGitHubReviewWait>>) {
  await db.update(toolConnections).set({ enabled: false }).where(and(
    eq(toolConnections.id, fixture.connectionId), eq(toolConnections.companyId, fixture.companyId)));
}
