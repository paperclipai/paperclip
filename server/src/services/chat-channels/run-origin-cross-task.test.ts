import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, runIdentityContexts } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { seedGitHubReviewWait } from "../../__tests__/helpers/github-review-wait.js";
import { chatRunSourceMessageId } from "./run-origin.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("channel task provenance: cross-task ancestor", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-channel-origin-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Channel continuation", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Channel agent", role: "general", adapterType: "codex_local" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Channel task", assigneeAgentId: agent.id }).returning();
    const [source, continued] = await db.insert(heartbeatRuns).values([
      { companyId: company.id, agentId: agent.id, status: "succeeded", contextSnapshot: { issueId: issue.id }, responsibleUserId: "requester" },
      { companyId: company.id, agentId: agent.id, status: "running", nativeIssueId: issue.id, contextSnapshot: {}, responsibleUserId: "requester" },
    ]).returning();
    const messageId = randomUUID();
    const [origin] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: source.id, revision: 1, responsibleUserId: "requester", messageId, cause: "instruction", correlationId: "message" }).returning();
    const [context] = await db.insert(runIdentityContexts).values({ companyId: company.id, runId: continued.id, revision: 1, responsibleUserId: "requester", parentContextId: origin.id, cause: "monitor", correlationId: "dispatch" }).returning();
    const [run] = await db.update(heartbeatRuns).set({ activeIdentityContextId: context.id }).where(eq(heartbeatRuns.id, continued.id)).returning();
    return { company, agent, issue, source, run, origin, context, messageId };
  }

  it("withholds chat tools from a same-task continuation whose ancestor carries a comment of another task", async () => {
    const f = await fixture();
    const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Other task" }).returning();
    const [foreign] = await db.insert(issueComments).values({
      companyId: f.company.id, issueId: other.id, authorType: "user", authorUserId: "requester", body: "Cross-task comment",
    }).returning();
    await db.update(runIdentityContexts).set({ messageId: foreign.id }).where(eq(runIdentityContexts.id, f.origin.id));
    await expect(chatRunSourceMessageId(db, f.run, { provider: "github" })).resolves.toBeNull();
    await expect(chatRunSourceMessageId(db, f.run)).resolves.toBe(foreign.id);
  });

  it("withholds chat tools from a same-task continuation whose ancestor links to another task's chat", async () => {
    const f = await fixture();
    const other = await seedGitHubReviewWait(db, { companyId: f.company.id, agentId: f.agent.id });
    await db.update(runIdentityContexts).set({ messageId: other.commentId }).where(eq(runIdentityContexts.id, f.origin.id));
    const [run] = await db.update(heartbeatRuns)
      .set({ contextSnapshot: { wakeCommentId: f.messageId } })
      .where(eq(heartbeatRuns.id, f.run.id)).returning();
    await expect(chatRunSourceMessageId(db, run, { provider: "github" })).resolves.toBeNull();
    await expect(chatRunSourceMessageId(db, run, { provider: "github", allowLegacyWakeComment: true }))
      .resolves.toBe(f.messageId);
  });
});
