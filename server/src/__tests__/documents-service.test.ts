import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  documentRevisions,
  documents,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres document service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("documentService system issue documents", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-documents-service-");
    db = createDb(tempDb.connectionString);
    svc = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssueWithDocuments() {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-1600",
      title: "System document filtering",
      description: "Validate document filtering",
      status: "in_progress",
      priority: "medium",
    });

    await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Plan",
    });
    await svc.upsertIssueDocument({
      issueId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Handoff",
    });

    return { issueId };
  }

  it("filters continuation summaries from default document lists and issue payload summaries", async () => {
    const { issueId } = await createIssueWithDocuments();

    const defaultDocuments = await svc.listIssueDocuments(issueId);
    expect(defaultDocuments.map((doc) => doc.key)).toEqual(["plan"]);

    const payload = await svc.getIssueDocumentPayload({ id: issueId, description: null });
    expect(payload.planDocument?.key).toBe("plan");
    expect(payload.documentSummaries.map((doc) => doc.key)).toEqual(["plan"]);
  });

  it("keeps system documents available for includeSystem and direct fetch callers", async () => {
    const { issueId } = await createIssueWithDocuments();

    const debugDocuments = await svc.listIssueDocuments(issueId, { includeSystem: true });
    expect(debugDocuments.map((doc) => doc.key)).toEqual([
      ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      "plan",
    ]);

    const directHandoff = await svc.getIssueDocumentByKey(issueId, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY);
    expect(directHandoff).toEqual(expect.objectContaining({
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      body: "# Handoff",
    }));
  });

  it("redacts document text before persistence and returned downstream payloads", async () => {
    const { issueId } = await createIssueWithDocuments();
    const inputValue = "test-only-sensitive-value";

    const created = await svc.upsertIssueDocument({
      issueId,
      key: "security-notes",
      title: `Credential PAPERCLIP_API_KEY=${inputValue}`,
      format: "markdown",
      body: `# Notes\n\nOPENAI_API_KEY: ${inputValue}\n\nOrdinary prose: follow up with the vendor.`,
      changeSummary: `Added secret=${inputValue}`,
    });
    const updated = await svc.upsertIssueDocument({
      issueId,
      key: "security-notes",
      title: `Updated AUTH_TOKEN=${inputValue}`,
      format: "markdown",
      body: `Updated password: ${inputValue}\n\nOrdinary prose: status is pending.`,
      changeSummary: `Updated token=${inputValue}`,
      baseRevisionId: created.document.latestRevisionId,
    });

    const storedDocument = await db
      .select()
      .from(documents)
      .where(eq(documents.id, updated.document.id))
      .then((rows) => rows[0]);
    const storedRevisions = await db
      .select()
      .from(documentRevisions)
      .where(eq(documentRevisions.documentId, updated.document.id));
    const fetched = await svc.getIssueDocumentByKey(issueId, "security-notes");
    const revisions = await svc.listIssueDocumentRevisions(issueId, "security-notes");

    expect(updated.document).toEqual(expect.objectContaining({
      title: "Updated AUTH_TOKEN=***REDACTED***",
      body: "Updated password: ***REDACTED***\n\nOrdinary prose: status is pending.",
    }));
    expect(fetched).toEqual(expect.objectContaining({
      title: updated.document.title,
      body: updated.document.body,
      latestRevisionId: updated.document.latestRevisionId,
    }));
    expect(JSON.stringify({ storedDocument, storedRevisions, fetched, revisions })).not.toContain(inputValue);
    expect(JSON.stringify({ storedDocument, storedRevisions, fetched, revisions })).toContain("Ordinary prose: status is pending.");
  });

  it("redacts legacy revision text before restoring it into current document state", async () => {
    const { issueId } = await createIssueWithDocuments();
    const legacyValue = "test-only-restored-sensitive-value";
    const created = await svc.upsertIssueDocument({
      issueId,
      key: "security-notes",
      title: "Safe title",
      format: "markdown",
      body: "Safe body",
    });

    // Simulate a pre-redaction revision, then ensure a restore cannot copy it
    // into the current document or a newly-created revision in plaintext.
    await db
      .update(documentRevisions)
      .set({
        title: `PAPERCLIP_API_KEY=${legacyValue}`,
        body: `password: ${legacyValue}`,
      })
      .where(eq(documentRevisions.id, created.document.latestRevisionId));
    const updated = await svc.upsertIssueDocument({
      issueId,
      key: "security-notes",
      title: "Current safe title",
      format: "markdown",
      body: "Current safe body",
      baseRevisionId: created.document.latestRevisionId,
    });

    const restored = await svc.restoreIssueDocumentRevision({
      issueId,
      key: "security-notes",
      revisionId: created.document.latestRevisionId!,
    });
    const storedDocument = await db
      .select()
      .from(documents)
      .where(eq(documents.id, restored.document.id))
      .then((rows) => rows[0]);
    const restoredRevision = await db
      .select()
      .from(documentRevisions)
      .where(eq(documentRevisions.id, restored.document.latestRevisionId!))
      .then((rows) => rows[0]);

    expect(updated.document.latestRevisionId).not.toBe(restored.document.latestRevisionId);
    expect(JSON.stringify({ restored, storedDocument, restoredRevision })).not.toContain(legacyValue);
    expect(restored.document).toEqual(expect.objectContaining({
      title: "PAPERCLIP_API_KEY=***REDACTED***",
      body: "password: ***REDACTED***",
    }));
  });

  it("redacts legacy document rows at every service output boundary", async () => {
    const { issueId } = await createIssueWithDocuments();
    const legacyValue = "test-only-legacy-sensitive-value";
    const created = await svc.upsertIssueDocument({
      issueId,
      key: "security-notes",
      title: "Safe title",
      format: "markdown",
      body: "Safe body",
      changeSummary: "Safe summary",
    });

    await db
      .update(documents)
      .set({
        title: `PAPERCLIP_API_KEY=${legacyValue}`,
        latestBody: `password: ${legacyValue}`,
      })
      .where(eq(documents.id, created.document.id));
    await db
      .update(documentRevisions)
      .set({
        title: `AUTH_TOKEN=${legacyValue}`,
        body: `token=${legacyValue}`,
        changeSummary: `secret=${legacyValue}`,
      })
      .where(eq(documentRevisions.id, created.document.latestRevisionId));

    const fetched = await svc.getIssueDocumentByKey(issueId, "security-notes");
    const listed = await svc.listIssueDocuments(issueId);
    const payload = await svc.getIssueDocumentPayload({ id: issueId, description: null });
    const revisions = await svc.listIssueDocumentRevisions(issueId, "security-notes");

    expect(JSON.stringify({ fetched, listed, payload, revisions })).not.toContain(legacyValue);
    expect(fetched).toEqual(expect.objectContaining({
      title: "PAPERCLIP_API_KEY=***REDACTED***",
      body: "password: ***REDACTED***",
    }));
    expect(revisions[0]).toEqual(expect.objectContaining({
      title: "AUTH_TOKEN=***REDACTED***",
      body: "token=***REDACTED***",
      changeSummary: "secret=***REDACTED***",
    }));
  });

  it("redacts a legacy document title before returning it for deletion activity", async () => {
    const { issueId } = await createIssueWithDocuments();
    const legacyValue = "test-only-deleted-document-secret";
    const created = await svc.upsertIssueDocument({
      issueId,
      key: "security-notes",
      title: "Safe title",
      format: "markdown",
      body: "Safe body",
    });
    await db
      .update(documents)
      .set({ title: `PAPERCLIP_API_KEY=${legacyValue}` })
      .where(eq(documents.id, created.document.id));

    const removed = await svc.deleteIssueDocument(issueId, "security-notes");

    expect(removed).toEqual(expect.objectContaining({
      title: "PAPERCLIP_API_KEY=***REDACTED***",
    }));
    expect(JSON.stringify(removed)).not.toContain(legacyValue);
  });
});
