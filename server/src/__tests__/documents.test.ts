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
import {
  PAPERCLIP_SESSION_DOCUMENT_KEY,
  PAPERCLIP_SESSION_RECEIPT_DOCUMENT_KEY_PREFIX,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentService, extractLegacyPlanBody } from "../services/documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres document service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("extractLegacyPlanBody", () => {
  it("returns null when no plan block exists", () => {
    expect(extractLegacyPlanBody("hello world")).toBeNull();
  });

  it("extracts plan body from legacy issue descriptions", () => {
    expect(
      extractLegacyPlanBody(`
intro

<plan>

# Plan

- one
- two

</plan>
      `),
    ).toBe("# Plan\n\n- one\n- two");
  });

  it("ignores empty plan blocks", () => {
    expect(extractLegacyPlanBody("<plan>   </plan>")).toBeNull();
  });
});

describeEmbeddedPostgres("documentService reserved session documents", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof documentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-documents-service-");
    db = createDb(tempDb.connectionString);
    svc = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "CAR",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Session root issue",
      status: "todo",
      priority: "medium",
    });

    return { companyId, issueId };
  }

  it("rejects generic writes to session-reserved document keys", async () => {
    const { issueId } = await seedIssue();

    await expect(svc.upsertIssueDocument({
      issueId,
      key: PAPERCLIP_SESSION_DOCUMENT_KEY,
      format: "markdown",
      body: "{}",
    })).rejects.toMatchObject({ status: 403 });

    await expect(svc.upsertIssueDocument({
      issueId,
      key: `${PAPERCLIP_SESSION_RECEIPT_DOCUMENT_KEY_PREFIX}${randomUUID()}`,
      format: "markdown",
      body: "{}",
    })).rejects.toMatchObject({ status: 403 });
  });

  it("allows session-service writes but blocks generic deletion of session documents", async () => {
    const { companyId, issueId } = await seedIssue();

    const created = await svc.upsertIssueDocument({
      issueId,
      key: PAPERCLIP_SESSION_DOCUMENT_KEY,
      format: "markdown",
      body: "{}",
      allowReservedSessionDocumentKey: true,
      expectedCompanyId: companyId,
    });

    expect(created.created).toBe(true);
    expect(created.document.key).toBe(PAPERCLIP_SESSION_DOCUMENT_KEY);
    await expect(svc.deleteIssueDocument(issueId, PAPERCLIP_SESSION_DOCUMENT_KEY)).rejects.toMatchObject({ status: 403 });
  });
});
