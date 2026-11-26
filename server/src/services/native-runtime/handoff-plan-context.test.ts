import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, companies, agents, issues, heartbeatRuns, documents, documentRevisions, issueDocuments, issueThreadInteractions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { handoffPlanContext } from "./handoff-plan-context.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("handoff approval evidence", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("handoff-plan-"); db = createDb(temporary.connectionString); }, 20_000);
  afterAll(async () => { await temporary?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), sourceId = randomUUID(), runId = randomUUID();
    const documentId = randomUUID(), revisionId = randomUUID(), interactionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Planner", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: sourceId, companyId, title: "Source chat", conversationAgentId: agentId, assigneeAgentId: agentId, conversationUserId: "operator", conversationState: "active" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: sourceId, status: "succeeded" });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "A newer unapproved plan" });
    await db.insert(documentRevisions).values({ id: revisionId, documentId, companyId, revisionNumber: 1, body: "Write the approved note." });
    await db.insert(issueDocuments).values({ companyId, issueId: sourceId, documentId, key: "plan" });
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId: sourceId, kind: "request_confirmation", status: "accepted", resolvedAt: new Date("2026-09-01"), payload: { version: 1, prompt: "Approve the plan", target: { type: "issue_document", key: "plan", revisionId } } });
    const [task] = await db.insert(issues).values({ companyId, title: "Execute", originRunId: runId, createdAt: new Date("2026-09-02") }).returning();
    return { task, companyId, sourceId, runId, revisionId, interactionId, documentId };
  }
  it("returns the exact accepted source revision, never a newer unapproved body or new-document approval", async () => {
    const f = await seed();
    const result = await handoffPlanContext(db, f.task);
    expect(result).toMatchObject({ sourceIssueId: f.sourceId, revisionId: f.revisionId, interactionId: f.interactionId, markdown: "Write the approved note." });
    expect(result?.guidance).toContain("not approval of changes");
    expect(result?.guidance).toContain("Preserve other applicable gates");
  });
  it.each(["pending", "later", "other-company", "other-task", "unrelated-document", "no-origin"])("does not infer authority from %s evidence", async (kind) => {
    const f = await seed();
    if (kind === "pending") await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, f.interactionId));
    if (kind === "later") await db.update(issueThreadInteractions).set({ resolvedAt: new Date("2026-09-03") }).where(eq(issueThreadInteractions.id, f.interactionId));
    if (kind === "other-company") f.task.companyId = randomUUID();
    if (kind === "other-task") await db.update(issues).set({ conversationAgentId: null, conversationUserId: null, conversationState: null }).where(eq(issues.id, f.sourceId));
    if (kind === "unrelated-document") await db.update(issueDocuments).set({ key: "unrelated" }).where(eq(issueDocuments.documentId, f.documentId));
    if (kind === "no-origin") f.task.originRunId = null;
    expect(await handoffPlanContext(db, f.task)).toBeNull();
  });
});
