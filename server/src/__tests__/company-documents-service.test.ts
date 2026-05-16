import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyDocuments,
  createDb,
  documentRevisions,
  documents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService } from "../services/documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company-document service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("documentService company-root documents", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-documents-service-");
    db = createDb(tempDb.connectionString);
    svc = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentRevisions);
    await db.delete(companyDocuments);
    await db.delete(documents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("lists empty by default and returns the document after upsert", async () => {
    const companyId = await createCompany();

    expect(await svc.listCompanyDocuments(companyId)).toEqual([]);

    const created = await svc.upsertCompanyDocument({
      companyId,
      key: "legal-avv-template",
      title: "AVV",
      format: "markdown",
      body: "# AVV",
    });

    expect(created.created).toBe(true);
    expect(created.document.key).toBe("legal-avv-template");
    expect(created.document.body).toBe("# AVV");
    expect(created.document.latestRevisionNumber).toBe(1);

    const listed = await svc.listCompanyDocuments(companyId);
    expect(listed.map((doc) => doc.key)).toEqual(["legal-avv-template"]);

    const fetched = await svc.getCompanyDocumentByKey(companyId, "legal-avv-template");
    expect(fetched).toEqual(expect.objectContaining({ body: "# AVV", title: "AVV" }));
  });

  it("rejects a conflicting upsert without baseRevisionId", async () => {
    const companyId = await createCompany();
    await svc.upsertCompanyDocument({
      companyId,
      key: "legal-vvt",
      format: "markdown",
      body: "# v1",
    });

    await expect(
      svc.upsertCompanyDocument({
        companyId,
        key: "legal-vvt",
        format: "markdown",
        body: "# v2",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("accepts an update when baseRevisionId matches and bumps revision", async () => {
    const companyId = await createCompany();
    const initial = await svc.upsertCompanyDocument({
      companyId,
      key: "legal-cookie-categories",
      format: "markdown",
      body: "# v1",
    });

    const updated = await svc.upsertCompanyDocument({
      companyId,
      key: "legal-cookie-categories",
      format: "markdown",
      body: "# v2",
      baseRevisionId: initial.document.latestRevisionId,
    });

    expect(updated.created).toBe(false);
    expect(updated.document.body).toBe("# v2");
    expect(updated.document.latestRevisionNumber).toBe(2);

    const revisions = await svc.listCompanyDocumentRevisions(companyId, "legal-cookie-categories");
    expect(revisions.map((rev) => rev.revisionNumber)).toEqual([2, 1]);
  });

  it("restores a prior revision as the new latest", async () => {
    const companyId = await createCompany();
    const first = await svc.upsertCompanyDocument({
      companyId,
      key: "legal-datenschutz",
      format: "markdown",
      body: "# v1",
    });
    const second = await svc.upsertCompanyDocument({
      companyId,
      key: "legal-datenschutz",
      format: "markdown",
      body: "# v2",
      baseRevisionId: first.document.latestRevisionId,
    });
    expect(second.document.latestRevisionNumber).toBe(2);

    const restored = await svc.restoreCompanyDocumentRevision({
      companyId,
      key: "legal-datenschutz",
      revisionId: first.document.latestRevisionId!,
    });
    expect(restored.document.body).toBe("# v1");
    expect(restored.document.latestRevisionNumber).toBe(3);
  });

  it("locks the document so updates without create_new_document fail with 409", async () => {
    const companyId = await createCompany();
    const initial = await svc.upsertCompanyDocument({
      companyId,
      key: "legal-sub-processors",
      format: "markdown",
      body: "# v1",
    });

    const locked = await svc.lockCompanyDocument({
      companyId,
      key: "legal-sub-processors",
      lockedByUserId: "board-user",
    });
    expect(locked.changed).toBe(true);
    expect(locked.document.lockedAt).toBeInstanceOf(Date);

    await expect(
      svc.upsertCompanyDocument({
        companyId,
        key: "legal-sub-processors",
        format: "markdown",
        body: "# v2",
        baseRevisionId: initial.document.latestRevisionId,
        createdByUserId: "board-user",
      }),
    ).rejects.toMatchObject({ status: 409, message: "Document is locked" });

    const fallback = await svc.upsertCompanyDocument({
      companyId,
      key: "legal-sub-processors",
      format: "markdown",
      body: "# fork",
      lockedDocumentStrategy: "create_new_document",
    });
    expect(fallback.created).toBe(true);
    expect(fallback.document.key).not.toBe("legal-sub-processors");
    expect(fallback.document.body).toBe("# fork");

    const unlocked = await svc.unlockCompanyDocument(companyId, "legal-sub-processors");
    expect(unlocked.changed).toBe(true);
    expect(unlocked.document.lockedAt).toBeNull();
  });

  it("deletes a company document by key", async () => {
    const companyId = await createCompany();
    await svc.upsertCompanyDocument({
      companyId,
      key: "brand-voice",
      format: "markdown",
      body: "# Voice",
    });

    const removed = await svc.deleteCompanyDocument(companyId, "brand-voice");
    expect(removed).not.toBeNull();
    expect(await svc.getCompanyDocumentByKey(companyId, "brand-voice")).toBeNull();
    expect(await svc.listCompanyDocuments(companyId)).toEqual([]);
  });
});
