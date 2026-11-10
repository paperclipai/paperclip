import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatConversations, chatDeliveries, chatMessageLinks, createDb, heartbeatRuns,
  issueComments, issues, statusDecisions, type Db } from "@paperclipai/db";
import { seedBoundChatAuthorization } from "./helpers/bound-chat-authorization.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { listExternalReviewWaits } from "../services/native-runtime/external-review-wait.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

// The bound-run message read of chat authorization. The inherited GitHub review
// read also starts from chat_message_links, but it does not join deliveries.
const boundRunLinkStatement = /from "chat_message_links" inner join "chat_deliveries"/i;

describePostgres("issue list review-wait authorization", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let f: Awaited<ReturnType<typeof seedBoundChatAuthorization>>;
  let statements: string[] | null = null;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("review-wait-authorization-");
    db = createDb(temporary.connectionString);
    const client = db.$client as unknown as { unsafe: (query: string, ...rest: unknown[]) => unknown };
    const unsafe = client.unsafe.bind(client);
    client.unsafe = (query: string, ...rest: unknown[]) => {
      statements?.push(query);
      return unsafe(query, ...rest);
    };
    f = await seedBoundChatAuthorization(db);
    // A second waiting conversation, on the other in-review issue, from the
    // same linked person.
    const otherConversationId = randomUUID(), otherCommentId = randomUUID(), deliveryId = randomUUID();
    await db.insert(chatConversations).values({ id: otherConversationId, companyId: f.companyId,
      endpointId: f.endpointId, resourceId: f.resourceId, issueId: f.otherIssueId,
      externalConversationId: "channel-1", externalThreadId: "thread-2", externalLabel: "Other thread", state: "active" });
    await db.insert(issueComments).values({ id: otherCommentId, companyId: f.companyId, issueId: f.otherIssueId,
      authorType: "user", authorUserId: f.userId, body: "Another request" });
    await db.insert(chatDeliveries).values({ id: deliveryId, companyId: f.companyId, endpointId: f.endpointId,
      conversationId: otherConversationId, principalId: f.principalId, providerEventId: deliveryId,
      deduplicationKey: deliveryId, eventKind: "message", normalizedEvent: {}, state: "processed", processedAt: new Date() });
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId,
      conversationId: otherConversationId, deliveryId, commentId: otherCommentId,
      providerMessageId: otherCommentId, direction: "inbound" });
    // Each issue waits on the reply that its succeeded native run asked for.
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: f.runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "native",
        nativeIssueId: f.issueId, contextSnapshot: f.context },
      { id: otherRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded", runtimeMode: "native",
        nativeIssueId: f.otherIssueId, contextSnapshot: { ...f.context, wakeCommentIds: [otherCommentId] } },
    ]);
    for (const [issueId, runId] of [[f.issueId, f.runId], [f.otherIssueId, otherRunId]] as const) {
      const decisionId = randomUUID();
      // The decision's assessment chain is not part of this read.
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.insert(statusDecisions).values({ id: decisionId, companyId: f.companyId, issueId, runId,
          assessmentId: randomUUID(), decisionVersion: 1, policyVersion: "test", fromStatus: "in_progress",
          toStatus: "in_review", reasonCode: "external_chat_response_waiting", decisionJson: {},
          decisionDigest: decisionId, applicationState: "applied", appliedAt: new Date() });
      });
      await db.update(issues).set({ lastStatusDecisionId: decisionId }).where(eq(issues.id, issueId));
    }
  }, 60_000);

  afterAll(async () => {
    try { await db?.$client.end({ timeout: 1 }); }
    finally { await temporary?.cleanup(); }
  });

  async function boundRunLinkReads<T>(read: () => Promise<T>) {
    statements = [];
    try {
      const result = await read();
      return { result, reads: statements.filter((statement) => boundRunLinkStatement.test(statement)).length };
    } finally {
      statements = null;
    }
  }

  it("authorizes every wait of a page with one message read", async () => {
    const { result, reads } = await boundRunLinkReads(() =>
      listExternalReviewWaits(db, f.companyId, [f.issueId, f.otherIssueId]));
    expect(result.map((wait) => wait.issueId).sort()).toEqual([f.issueId, f.otherIssueId].sort());
    expect(reads).toBe(1);
  });

  it("reads the waits of an issue-list request once, for both attention maps", async () => {
    const { result, reads } = await boundRunLinkReads(() =>
      issueService(db).list(f.companyId, { includeBlockedInboxAttention: true }));
    expect(result.map((row) => row.id).sort()).toEqual([f.issueId, f.otherIssueId].sort());
    expect(reads).toBe(1);
  });
});
