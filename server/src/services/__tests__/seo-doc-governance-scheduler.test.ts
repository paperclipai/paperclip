import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  issueComments,
  issueDocuments,
  issues,
  seoDocRegistryEntries,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { documentService } from "../documents.js";
import { createSeoDocGovernanceScheduler } from "../seo-doc-governance-scheduler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function governedBody(lastUpdated: string, criticality: "normal" | "critical" = "normal") {
  return [
    "---",
    "seo_governance:",
    "  owner: cto",
    `  last_updated: ${lastUpdated}`,
    "  update_cadence: weekly",
    "  status: active",
    "  document_class: architecture",
    `  criticality: ${criticality}`,
    "  dependencies:",
    "---",
    "",
    "# Body",
  ].join("\n");
}

describeEmbeddedPostgres("createSeoDocGovernanceScheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let docsSvc!: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-seo-governance-scheduler-");
    db = createDb(tempDb.connectionString);
    docsSvc = documentService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(issueComments);
    await db.delete(seoDocRegistryEntries);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssue(identifier: string) {
    const companyId = randomUUID();
    const cmoAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: cmoAgentId,
      companyId,
      name: "CMO",
      role: "cmo",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      issueNumber: Number(identifier.split("-")[1] ?? "1"),
      title: identifier,
      status: "todo",
      priority: "high",
      createdByUserId: "user-1",
    });
    return { companyId, issueId, cmoAgentId };
  }

  it("emits one escalation for critical stale docs until last_updated changes", async () => {
    const { issueId, cmoAgentId } = await createIssue("INS-321");
    const enqueueWakeup = vi.fn(async () => null);

    const created = await docsSvc.upsertIssueDocument({
      issueId,
      key: "plan",
      format: "markdown",
      body: governedBody("2026-03-01", "critical"),
    });

    const scheduler = createSeoDocGovernanceScheduler({
      db,
      enqueueWakeup,
      intervalMs: 60_000,
      now: () => new Date("2026-04-21T00:00:00.000Z"),
    });
    expect((await scheduler.runOnce(new Date("2026-04-21T00:00:00.000Z"))).escalatedDocKeys).toContain("INS-321#document-plan");
    expect((await scheduler.runOnce(new Date("2026-04-21T00:00:00.000Z"))).escalatedDocKeys).toEqual([]);

    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenNthCalledWith(
      1,
      cmoAgentId,
      expect.objectContaining({
        reason: "issue_comment_mentioned",
        payload: expect.objectContaining({ issueId }),
      }),
    );

    await docsSvc.upsertIssueDocument({
      issueId,
      key: "plan",
      format: "markdown",
      baseRevisionId: created.document.latestRevisionId,
      body: governedBody("2026-04-22", "critical"),
    });

    expect((await scheduler.runOnce(new Date("2026-05-10T00:00:00.000Z"))).escalatedDocKeys).toContain("INS-321#document-plan");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(2);
    expect(comments[0]?.body).toContain(`[@CMO](agent://${cmoAgentId})`);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
  });

  it("continues auditing other docs when one governed document is malformed", async () => {
    const malformed = await createIssue("INS-322");
    const healthy = await createIssue("INS-323");

    await docsSvc.upsertIssueDocument({
      issueId: malformed.issueId,
      key: "plan",
      format: "markdown",
      body: governedBody("2026-04-20", "normal"),
    });
    const healthyDoc = await docsSvc.upsertIssueDocument({
      issueId: healthy.issueId,
      key: "plan",
      format: "markdown",
      body: governedBody("2026-03-01", "normal"),
    });

    const malformedDocumentId = await db
      .select({ documentId: issueDocuments.documentId })
      .from(issueDocuments)
      .where(and(eq(issueDocuments.issueId, malformed.issueId), eq(issueDocuments.key, "plan")))
      .then((rows) => rows[0]?.documentId ?? null);
    if (malformedDocumentId) {
      await db.update(documents).set({ latestBody: "# malformed frontmatter removed" }).where(eq(documents.id, malformedDocumentId));
    }

    const scheduler = createSeoDocGovernanceScheduler({ db, now: () => new Date("2026-04-21T00:00:00.000Z") });
    const result = await scheduler.runOnce(new Date("2026-04-21T00:00:00.000Z"));

    expect(result.scanned).toBe(2);
    expect(result.staleDocKeys).toContain("INS-323#document-plan");
    expect(result.violations.some((v) => v.code === "missing_frontmatter" && v.docKey === "INS-322#document-plan")).toBe(true);

    await docsSvc.upsertIssueDocument({
      issueId: healthy.issueId,
      key: "plan",
      format: "markdown",
      baseRevisionId: healthyDoc.document.latestRevisionId,
      body: governedBody("2026-04-21", "normal"),
    });
  });
});
