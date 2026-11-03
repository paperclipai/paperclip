import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, chatActions, chatConversations, chatEndpointResources, chatEndpoints, chatGitHubReviews,
  companies, createDb, heartbeatRuns, runIdentityContexts, toolConnections, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { captureReviewWaitQueries, seedGitHubReviewWait, setGitHubReviewAssessment,
  type CapturedReviewWaitQuery } from "./helpers/github-review-wait.js";
import { readInheritedGitHubReviewWait } from "../services/chat-channels/github/review-wait.js";

describe("inherited GitHub review wait projection", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    if (process.env.PAPERCLIP_TEST_DATABASE_URL) {
      db = createDb(process.env.PAPERCLIP_TEST_DATABASE_URL);
    } else {
      temporary = await startEmbeddedPostgresTestDatabase("github-review-wait-");
      db = createDb(temporary.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  it("reads the typed commit without transferring the assessment document", async () => {
    const f = await seedGitHubReviewWait(db);
    const assessment = { reviewedCommit: f.headSha, summary: "Large summary ".repeat(600), findings: [{ body: "retained" }] };
    await setGitHubReviewAssessment(db, f.reviewId, assessment);
    const queries: CapturedReviewWaitQuery[] = [];
    expect(await readInheritedGitHubReviewWait(captureReviewWaitQueries(db, queries), f.run)).toMatchObject({
      kind: "published", reviewId: f.reviewId, headSha: f.headSha, context: { wakeCommentId: f.commentId },
    });
    const query = queries.find(query => query.sql.includes('join "chat_github_reviews"'))!;
    const rows = await db.$client.unsafe(query.sql, query.params as never[]).raw();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reduce((bytes, value) => bytes + (value?.byteLength ?? 0), 0)).toBeLessThan(1_000);
    const [stored] = await db.select({ assessment: chatGitHubReviews.assessment }).from(chatGitHubReviews)
      .where(eq(chatGitHubReviews.id, f.reviewId));
    expect(stored!.assessment).toEqual(assessment);
  });

  it("preserves strict equality for malformed, missing, and valid JSON values", async () => {
    const f = await seedGitHubReviewWait(db);
    for (const assessment of [null, false, 123, f.headSha, [], [f.headSha], {}, { reviewedCommit: null },
      { reviewedCommit: 1 }, { reviewedCommit: true }, { reviewedCommit: [f.headSha] },
      { reviewedCommit: { value: f.headSha } }, { reviewedCommit: ` ${f.headSha}` },
      { reviewedCommit: "2".repeat(40) }, { reviewedCommit: f.headSha }]) {
      await setGitHubReviewAssessment(db, f.reviewId, assessment);
      const expected = (assessment as { reviewedCommit?: unknown } | null)?.reviewedCommit === f.headSha;
      expect((await readInheritedGitHubReviewWait(db, f.run))?.kind).toBe(expected ? "published" : "revoked");
    }
    await db.$client.unsafe("UPDATE chat_github_reviews SET head_sha = '1', assessment = '{\"reviewedCommit\":1}' WHERE id = $1", [f.reviewId]);
    expect(await readInheritedGitHubReviewWait(db, f.run)).toEqual({ kind: "revoked" });
    await db.$client.unsafe("UPDATE chat_github_reviews SET assessment = NULL WHERE id = $1", [f.reviewId]);
    expect(await readInheritedGitHubReviewWait(db, f.run)).toEqual({ kind: "revoked" });
  });

  it.each(["disabled", "inactive", "review_state", "review_agent", "repository", "repository_id", "thread", "publication", "identity", "endpoint_agent", "company"] as const)(
    "continues to reject a changed %s binding", async change => {
      const f = await seedGitHubReviewWait(db);
      expect((await readInheritedGitHubReviewWait(db, f.run))?.kind).toBe("published");
      if (change === "disabled") await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, f.connectionId));
      if (change === "inactive") await db.update(toolConnections).set({ status: "error" }).where(eq(toolConnections.id, f.connectionId));
      if (change === "review_state") await db.update(chatGitHubReviews).set({ state: "queued" }).where(eq(chatGitHubReviews.id, f.reviewId));
      if (change === "review_agent" || change === "endpoint_agent") {
        const [other] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", adapterType: "process" }).returning();
        if (change === "review_agent") await db.update(heartbeatRuns).set({ agentId: other!.id }).where(eq(heartbeatRuns.id, f.reviewRunId));
        else await db.update(chatEndpoints).set({ assignedAgentId: other!.id }).where(eq(chatEndpoints.id, f.endpointId));
      }
      if (change === "repository") await db.update(chatEndpointResources).set({ providerResourceId: "other/repository" }).where(eq(chatEndpointResources.id, f.resourceId));
      if (change === "repository_id") await db.update(chatEndpointResources).set({ metadata: { providerRepositoryId: "43" } }).where(eq(chatEndpointResources.id, f.resourceId));
      if (change === "thread") await db.update(chatConversations).set({ externalThreadId: "github:synthetic/repository:8" }).where(eq(chatConversations.id, f.conversationId));
      if (change === "publication") await db.update(chatActions).set({ status: "received" }).where(eq(chatActions.id, f.publicationId));
      if (change === "identity") await db.update(runIdentityContexts).set({ status: "rejected" }).where(eq(runIdentityContexts.id, f.activeIdentityContextId!));
      if (change === "company") {
        const otherCompanyId = randomUUID();
        await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: otherCompanyId });
        f.run = { ...f.run, companyId: otherCompanyId };
      }
      expect((await readInheritedGitHubReviewWait(db, f.run))?.kind).not.toBe("published");
    },
  );

  it("does not reuse an older completed review when a newer head is queued", async () => {
    const f = await seedGitHubReviewWait(db);
    const [review] = await db.select().from(chatGitHubReviews).where(eq(chatGitHubReviews.id, f.reviewId));
    await db.insert(chatGitHubReviews).values({ ...review!, id: randomUUID(), deliveryId: randomUUID(),
      headSha: "2".repeat(40), state: "queued", createdAt: new Date(review!.createdAt.getTime() + 1_000) });
    expect(await readInheritedGitHubReviewWait(db, f.run)).toEqual({ kind: "revoked" });
    expect(await readInheritedGitHubReviewWait(db, { ...f.run, nativeIssueId: null })).toBeNull();
    expect(await readInheritedGitHubReviewWait(db, { ...f.run, activeIdentityContextId: null })).toBeNull();
  });
});
