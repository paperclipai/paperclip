import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

  it("locks and unlocks issue documents", async () => {
    const { issueId } = await createIssueWithDocuments();

    const locked = await svc.lockIssueDocument({
      issueId,
      key: "plan",
      lockedByUserId: "board-user",
    });

    expect(locked.changed).toBe(true);
    expect(locked.document.lockedAt).toBeInstanceOf(Date);
    expect(locked.document.lockedByUserId).toBe("board-user");

    await expect(svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: locked.document.latestRevisionId,
      createdByUserId: "board-user",
    })).rejects.toMatchObject({
      status: 409,
      message: "Document is locked",
    });

    const unlocked = await svc.unlockIssueDocument(issueId, "plan");
    expect(unlocked.changed).toBe(true);
    expect(unlocked.document.lockedAt).toBeNull();

    const updated = await svc.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "# Updated plan",
      baseRevisionId: unlocked.document.latestRevisionId,
      createdByUserId: "board-user",
    });

    expect(updated.created).toBe(false);
    expect(updated.document.body).toBe("# Updated plan");
  });

  it("keeps proposal copies for non-canonical locked documents", async () => {
    const { issueId } = await createIssueWithDocuments();
    await svc.upsertIssueDocument({
      issueId, key: "notes", format: "markdown", body: "# Notes",
    });
    const locked = await svc.lockIssueDocument({
      issueId, key: "notes", lockedByUserId: "board-user",
    });
    const fallback = await svc.upsertIssueDocument({
      issueId, key: "notes", format: "markdown", body: "# Proposed notes",
      baseRevisionId: locked.document.latestRevisionId,
      lockedDocumentStrategy: "create_new_document",
    });
    expect(fallback.document.key).toBe("notes-2");
    expect(await svc.getIssueDocumentByKey(issueId, "notes")).toMatchObject({
      body: "# Notes", lockedAt: expect.any(Date),
    });
    expect(await svc.getIssueDocumentByKey(issueId, "notes-2")).toMatchObject({
      body: "# Proposed notes", lockedAt: null,
    });
  });

  it.each(["plan", "specification"])("never forks the locked canonical %s document", async (key) => {
    const { issueId } = await createIssueWithDocuments();
    if (key === "specification") {
      await svc.upsertIssueDocument({ issueId, key, format: "markdown", body: "# Specification" });
    }
    const locked = await svc.lockIssueDocument({ issueId, key, lockedByUserId: "board-user" });
    const before = await svc.listIssueDocuments(issueId);
    await expect(svc.upsertIssueDocument({
      issueId, key, format: "markdown", body: "# Must not become another document",
      baseRevisionId: locked.document.latestRevisionId,
      lockedDocumentStrategy: "create_new_document",
    })).rejects.toMatchObject({ status: 409 });
    expect(await svc.listIssueDocuments(issueId)).toEqual(before);
    expect(await svc.getIssueDocumentByKey(issueId, key)).toEqual(locked.document);
  });

  it("allows only one concurrent writer to advance a base revision", async () => {
    const { issueId } = await createIssueWithDocuments();
    const plan = await svc.getIssueDocumentByKey(issueId, "plan");
    const results = await Promise.allSettled(["# Writer A", "# Writer B"].map((body) =>
      svc.upsertIssueDocument({
        issueId, key: "plan", format: "markdown", body,
        baseRevisionId: plan!.latestRevisionId,
      }),
    ));
    const successes = results.filter((result) => result.status === "fulfilled");
    const failures = results.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({ status: 409 });
    expect(await svc.getIssueDocumentByKey(issueId, "plan")).toMatchObject({
      body: successes[0].value.document.body,
      latestRevisionNumber: 2,
    });
  });
});
