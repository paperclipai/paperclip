import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documentRevisions,
  documents,
  issueComments,
  issueDocuments,
  issues,
  seoDocRegistryEntries,
} from "@paperclipai/db";
import { HttpError } from "../../errors.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { documentService } from "../documents.js";
import { seoDocGovernanceService } from "../seo-doc-governance.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function governedBody(input: {
  owner?: string;
  lastUpdated?: string;
  updateCadence?: "weekly" | "biweekly" | "monthly";
  status?: "active" | "stale" | "deprecated";
  documentClass?: "strategy" | "implementation" | "runbook" | "incident" | "experimentation" | "architecture" | "governance";
  criticality?: "normal" | "critical";
  dependencies?: Array<{
    type: "issue_document" | "issue";
    role: "source_strategy" | "implementation_handoff" | "related";
    target: string;
  }>;
}) {
  const deps = input.dependencies ?? [];
  return [
    "---",
    "seo_governance:",
    ...(input.owner !== undefined ? [`  owner: ${input.owner}`] : []),
    `  last_updated: ${input.lastUpdated ?? "2026-04-20"}`,
    ...(input.updateCadence !== undefined ? [`  update_cadence: ${input.updateCadence}`] : []),
    `  status: ${input.status ?? "active"}`,
    `  document_class: ${input.documentClass ?? "architecture"}`,
    `  criticality: ${input.criticality ?? "normal"}`,
    "  dependencies:",
    ...deps.flatMap((dep) => [
      "    - type: " + dep.type,
      "      role: " + dep.role,
      "      target: " + dep.target,
    ]),
    "---",
    "",
    "# Body",
  ].join("\n");
}

describeEmbeddedPostgres("seoDocGovernanceService", () => {
  let db!: ReturnType<typeof createDb>;
  let docsSvc!: ReturnType<typeof documentService>;
  let governance!: ReturnType<typeof seoDocGovernanceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-seo-doc-governance-");
    db = createDb(tempDb.connectionString);
    docsSvc = documentService(db);
    governance = seoDocGovernanceService(db);
  }, 30_000);

  afterEach(async () => {
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

  async function createCompanyAndIssue(identifier = "INS-312") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier,
      issueNumber: Number(identifier.split("-")[1] ?? "1"),
      title: `Issue ${identifier}`,
      status: "todo",
      priority: "high",
      createdByUserId: "user-1",
    });
    return { companyId, issueId };
  }

  it("inserts registry rows on valid governed document create", async () => {
    const { companyId, issueId } = await createCompanyAndIssue("INS-312");

    await docsSvc.upsertIssueDocument({
      issueId,
      key: "plan-eng-review",
      title: "Plan",
      format: "markdown",
      body: governedBody({
        owner: "cto",
        updateCadence: "monthly",
        documentClass: "architecture",
        dependencies: [{ type: "issue_document", role: "source_strategy", target: "INS-85#document-plan" }],
      }),
    });

    const row = await db
      .select()
      .from(seoDocRegistryEntries)
      .where(and(eq(seoDocRegistryEntries.companyId, companyId), eq(seoDocRegistryEntries.issueId, issueId)))
      .then((rows) => rows[0]);

    expect(row.docKey).toBe("INS-312#document-plan-eng-review");
    expect(row.updateCadence).toBe("monthly");
    expect(row.documentClass).toBe("architecture");
    expect((row.dependencies ?? [])[0]).toMatchObject({ target: "INS-85#document-plan" });
  });

  it("returns 422 and does not persist registry when owner is missing", async () => {
    const { issueId } = await createCompanyAndIssue("INS-313");

    await expect(() =>
      docsSvc.upsertIssueDocument({
        issueId,
        key: "plan",
        format: "markdown",
        body: governedBody({ owner: undefined, updateCadence: "monthly" }),
      }))
      .rejects
      .toMatchObject({ status: 422, details: { code: "missing_owner" } } as Partial<HttpError>);

    expect(await db.select().from(seoDocRegistryEntries)).toHaveLength(0);
  });

  it("restoring an older revision rewrites registry metadata", async () => {
    const { companyId, issueId } = await createCompanyAndIssue("INS-314");

    const first = await docsSvc.upsertIssueDocument({
      issueId,
      key: "plan",
      format: "markdown",
      body: governedBody({ owner: "cto", updateCadence: "monthly", status: "active", lastUpdated: "2026-04-01" }),
    });
    const second = await docsSvc.upsertIssueDocument({
      issueId,
      key: "plan",
      format: "markdown",
      baseRevisionId: first.document.latestRevisionId,
      body: governedBody({ owner: "cmo", updateCadence: "weekly", status: "deprecated", lastUpdated: "2026-04-20" }),
    });

    const revisions = await docsSvc.listIssueDocumentRevisions(issueId, "plan");
    const originalRevision = revisions.find((r) => r.revisionNumber === 1);
    expect(originalRevision).toBeTruthy();

    await docsSvc.restoreIssueDocumentRevision({
      issueId,
      key: "plan",
      revisionId: originalRevision!.id,
      createdByUserId: "user-2",
    });

    const row = await db
      .select()
      .from(seoDocRegistryEntries)
      .where(and(eq(seoDocRegistryEntries.companyId, companyId), eq(seoDocRegistryEntries.docKey, "INS-314#document-plan")))
      .then((rows) => rows[0]);

    expect(second.document.latestRevisionNumber).toBe(2);
    expect(row.owner).toBe("cto");
    expect(row.status).toBe("active");
    expect(row.updateCadence).toBe("monthly");
  });

  it("flags implementation docs without source_strategy dependency", async () => {
    const { issueId } = await createCompanyAndIssue("INS-315");

    await docsSvc.upsertIssueDocument({
      issueId,
      key: "plan",
      format: "markdown",
      body: governedBody({ owner: "cto", updateCadence: "weekly", documentClass: "implementation", dependencies: [] }),
    });

    const violations = await governance.validateRegistryEntry("INS-315#document-plan");
    expect(violations.some((v) => v.code === "implementation_missing_source_strategy")).toBe(true);
  });

  it("flags strategy docs without implementation_handoff dependency", async () => {
    const { issueId } = await createCompanyAndIssue("INS-316");

    await docsSvc.upsertIssueDocument({
      issueId,
      key: "plan",
      format: "markdown",
      body: governedBody({ owner: "cto", updateCadence: "weekly", documentClass: "strategy", dependencies: [] }),
    });

    const violations = await governance.validateRegistryEntry("INS-316#document-plan");
    expect(violations.some((v) => v.code === "strategy_missing_handoff_issue")).toBe(true);
  });

  it("marks weekly/biweekly/monthly docs stale at the expected thresholds", async () => {
    const now = new Date("2026-04-21T00:00:00.000Z");
    const weekly = await createCompanyAndIssue("INS-317");
    const biweekly = await createCompanyAndIssue("INS-318");
    const monthly = await createCompanyAndIssue("INS-319");

    await docsSvc.upsertIssueDocument({
      issueId: weekly.issueId,
      key: "plan",
      format: "markdown",
      body: governedBody({ owner: "cto", updateCadence: "weekly", lastUpdated: "2026-04-13T23:58:00.000Z" }),
    });
    await docsSvc.upsertIssueDocument({
      issueId: biweekly.issueId,
      key: "plan",
      format: "markdown",
      body: governedBody({ owner: "cto", updateCadence: "biweekly", lastUpdated: "2026-04-06T23:58:00.000Z" }),
    });
    await docsSvc.upsertIssueDocument({
      issueId: monthly.issueId,
      key: "plan",
      format: "markdown",
      body: governedBody({ owner: "cto", updateCadence: "monthly", lastUpdated: "2026-03-20T23:58:00.000Z" }),
    });

    expect((await governance.auditCompany(weekly.companyId, now)).staleDocKeys).toContain("INS-317#document-plan");
    expect((await governance.auditCompany(biweekly.companyId, now)).staleDocKeys).toContain("INS-318#document-plan");
    expect((await governance.auditCompany(monthly.companyId, now)).staleDocKeys).toContain("INS-319#document-plan");
  });

  it("keeps deprecated docs queryable and excludes them from escalation", async () => {
    const { companyId, issueId } = await createCompanyAndIssue("INS-320");

    await docsSvc.upsertIssueDocument({
      issueId,
      key: "plan",
      format: "markdown",
      body: governedBody({
        owner: "cto",
        updateCadence: "weekly",
        status: "deprecated",
        criticality: "critical",
        lastUpdated: "2026-01-01",
      }),
    });

    const result = await governance.auditCompany(companyId, new Date("2026-04-21T00:00:00.000Z"));
    expect(result.escalatedDocKeys).toEqual([]);

    const row = await db
      .select()
      .from(seoDocRegistryEntries)
      .where(eq(seoDocRegistryEntries.docKey, "INS-320#document-plan"))
      .then((rows) => rows[0] ?? null);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("deprecated");
  });

  it("seedFromIssueIdentifiers backfills INS-312 and INS-85 without duplicates", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `I${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    for (const identifier of ["INS-312", "INS-85"]) {
      const issueId = randomUUID();
      const documentId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        identifier,
        issueNumber: Number(identifier.split("-")[1] ?? "1"),
        title: `Issue ${identifier}`,
        status: "todo",
        priority: "high",
        createdByUserId: "user-1",
      });
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Plan",
        format: "markdown",
        latestBody: governedBody({ owner: "cto", updateCadence: "monthly" }),
        latestRevisionNumber: 1,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
    }

    expect(await governance.seedFromIssueIdentifiers(companyId, ["INS-312", "INS-85"])).toEqual({ synced: 2 });
    expect(await governance.seedFromIssueIdentifiers(companyId, ["INS-312", "INS-85"])).toEqual({ synced: 0 });
  });
});
