import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  issueComments,
  issueDocuments,
  issues,
  projects,
} from "@paperclipai/db";
import { companySearchQuerySchema, COMPANY_SEARCH_MAX_QUERY_LENGTH } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  COMPANY_SEARCH_BRANCH_FETCH_LIMIT,
  companySearchBranchFetchLimit,
  companySearchService,
} from "../services/company-search.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company search tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("company search query validation", () => {
  it("clamps query length, limit, and offset without rejecting the request", () => {
    const parsed = companySearchQuerySchema.parse({
      q: "x".repeat(COMPANY_SEARCH_MAX_QUERY_LENGTH + 50),
      limit: "500",
      offset: "9000",
      scope: "not-a-scope",
    });

    expect(parsed.q).toHaveLength(COMPANY_SEARCH_MAX_QUERY_LENGTH);
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(200);
    expect(parsed.scope).toBe("all");
  });

  it("includes offset in the internal per-branch fetch window", () => {
    const lowOffset = companySearchQuerySchema.parse({ q: "needle", limit: "50", offset: "0" });
    const highOffset = companySearchQuerySchema.parse({ q: "needle", limit: "50", offset: "9000" });

    expect(companySearchBranchFetchLimit(lowOffset.limit, lowOffset.offset)).toBe(51);
    expect(companySearchBranchFetchLimit(highOffset.limit, highOffset.offset)).toBe(COMPANY_SEARCH_BRANCH_FETCH_LIMIT);
  });
});

describeEmbeddedPostgres("companySearchService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySearchService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-search-");
    db = createDb(tempDb.connectionString);
    svc = companySearchService(db);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createIssue(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const id = values.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: values.title ?? "Search target",
      description: values.description ?? null,
      status: values.status ?? "todo",
      priority: values.priority ?? "medium",
      identifier: values.identifier ?? null,
      hiddenAt: values.hiddenAt ?? null,
      ...values,
    });
    return id;
  }

  async function createAgent(companyId: string, values: Partial<typeof agents.$inferInsert> = {}) {
    const id = values.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: values.name ?? "Search agent",
      role: values.role ?? "engineer",
      title: values.title ?? null,
      capabilities: values.capabilities ?? null,
      ...values,
    });
    return id;
  }

  async function createProject(companyId: string, values: Partial<typeof projects.$inferInsert> = {}) {
    const id = values.id ?? randomUUID();
    await db.insert(projects).values({
      id,
      companyId,
      name: values.name ?? "Search project",
      description: values.description ?? null,
      ...values,
    });
    return id;
  }

  it("ranks exact issue identifiers before weaker title matches", async () => {
    const companyId = await createCompany();
    const exactId = await createIssue(companyId, {
      identifier: "TST-42",
      title: "Backend endpoint",
    });
    await createIssue(companyId, {
      identifier: "TST-43",
      title: "TST-42 mentioned in title only",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "TST-42" }));

    expect(result.results[0]?.id).toBe(exactId);
    expect(result.results[0]?.matchedFields).toContain("identifier");
  });

  it("matches multiple tokens across the same issue thread and returns comment snippets", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, {
      identifier: "TST-7",
      title: "Checkout semantics",
      description: "Atomic ownership is enforced here.",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "The ranking snippet should explain why this thread matched.",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "checkout snippet" }));
    const match = result.results.find((item) => item.id === issueId);

    expect(match).toBeTruthy();
    expect(match?.matchedFields).toEqual(expect.arrayContaining(["title", "comment"]));
    expect(match?.snippets.some((snippet) => /snippet/i.test(snippet.text))).toBe(true);
  });

  it("searches issue documents and returns document metadata for snippets", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, {
      identifier: "TST-8",
      title: "Adapter manager",
    });
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Hermes Parser Plan",
      latestBody: "The external adapter parser should be discovered from the plugin package.",
      format: "markdown",
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "Hermes parser", scope: "documents" }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe(issueId);
    expect(result.results[0]?.matchedFields).toContain("document");
    expect(result.results[0]?.href).toContain("#document-plan");
    expect(result.results[0]?.snippet).toMatch(/parser/i);
  });

  it("excludes hidden issues and other companies' data", async () => {
    const companyId = await createCompany("Visible Co");
    const otherCompanyId = await createCompany("Other Co");
    const visibleId = await createIssue(companyId, {
      identifier: "VIS-1",
      title: "Visible needle",
    });
    await createIssue(companyId, {
      identifier: "HID-1",
      title: "Hidden needle",
      hiddenAt: new Date(),
    });
    await createIssue(otherCompanyId, {
      identifier: "OTH-1",
      title: "Other company needle",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "needle" }));

    expect(result.results.map((item) => item.id)).toEqual([visibleId]);
  });

  it("treats bare SQL wildcard characters as literals instead of match-all queries", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, {
      identifier: "TST-20",
      title: "Plain issue target",
      description: "Plain issue description",
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: "Plain comment body",
    });
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plain document",
      latestBody: "Plain document body",
      format: "markdown",
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plain",
    });
    await createAgent(companyId, {
      name: "Plain Agent",
      role: "engineer",
      capabilities: "Plain agent capabilities",
    });
    await createProject(companyId, {
      name: "Plain Project",
      description: "Plain project description",
    });

    for (const q of ["%", "_", "\\"]) {
      const result = await svc.search(companyId, companySearchQuerySchema.parse({ q }));
      expect(result.results, `q=${q}`).toEqual([]);
    }
  });

  it("matches percent characters literally across issue, comment, document, agent, and project results", async () => {
    const companyId = await createCompany();
    const issueMatchId = await createIssue(companyId, {
      identifier: "TST-21",
      title: "Release 100% checklist",
    });
    const issueDecoyId = await createIssue(companyId, {
      identifier: "TST-22",
      title: "Release 1000 checklist",
    });
    const commentMatchId = await createIssue(companyId, {
      identifier: "TST-23",
      title: "Comment literal holder",
    });
    const commentDecoyId = await createIssue(companyId, {
      identifier: "TST-24",
      title: "Comment decoy holder",
    });
    await db.insert(issueComments).values([
      {
        companyId,
        issueId: commentMatchId,
        body: "QA is 100% confident in this result.",
      },
      {
        companyId,
        issueId: commentDecoyId,
        body: "QA is 1000 confident in this result.",
      },
    ]);
    const documentMatchIssueId = await createIssue(companyId, {
      identifier: "TST-25",
      title: "Document literal holder",
    });
    const documentDecoyIssueId = await createIssue(companyId, {
      identifier: "TST-26",
      title: "Document decoy holder",
    });
    const documentMatchId = randomUUID();
    const documentDecoyId = randomUUID();
    await db.insert(documents).values([
      {
        id: documentMatchId,
        companyId,
        title: "Literal rollout",
        latestBody: "Ship 100% complete adapter support.",
        format: "markdown",
      },
      {
        id: documentDecoyId,
        companyId,
        title: "Decoy rollout",
        latestBody: "Ship 1000 complete adapter support.",
        format: "markdown",
      },
    ]);
    await db.insert(issueDocuments).values([
      {
        companyId,
        issueId: documentMatchIssueId,
        documentId: documentMatchId,
        key: "literal",
      },
      {
        companyId,
        issueId: documentDecoyIssueId,
        documentId: documentDecoyId,
        key: "decoy",
      },
    ]);
    const agentMatchId = await createAgent(companyId, {
      name: "100% Specialist",
      role: "engineer",
    });
    const agentDecoyId = await createAgent(companyId, {
      name: "1000 Specialist",
      role: "engineer",
    });
    const projectMatchId = await createProject(companyId, {
      name: "100% Launch Plan",
    });
    const projectDecoyId = await createProject(companyId, {
      name: "1000 Launch Plan",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "100%" }));
    const ids = result.results.map((row) => row.id);

    expect(ids).toEqual(expect.arrayContaining([
      issueMatchId,
      commentMatchId,
      documentMatchIssueId,
      agentMatchId,
      projectMatchId,
    ]));
    expect(ids).not.toEqual(expect.arrayContaining([
      issueDecoyId,
      commentDecoyId,
      documentDecoyIssueId,
      agentDecoyId,
      projectDecoyId,
    ]));
  });

  it("applies offset after merging cross-type result ranking", async () => {
    const companyId = await createCompany();
    const base = new Date("2026-01-01T00:00:00.000Z").getTime();
    const agentIds = await Promise.all([
      createAgent(companyId, { name: "Needle agent 1", updatedAt: new Date(base + 6_000) }),
      createAgent(companyId, { name: "Needle agent 2", updatedAt: new Date(base + 5_000) }),
      createAgent(companyId, { name: "Needle agent 3", updatedAt: new Date(base + 4_000) }),
    ]);
    const projectIds = await Promise.all([
      createProject(companyId, { name: "Needle project 1", updatedAt: new Date(base + 3_000) }),
      createProject(companyId, { name: "Needle project 2", updatedAt: new Date(base + 2_000) }),
      createProject(companyId, { name: "Needle project 3", updatedAt: new Date(base + 1_000) }),
    ]);

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "needle", limit: "2", offset: "2" }));

    expect(result.results.map((row) => row.id)).toEqual([agentIds[2], projectIds[0]]);
    expect(result.countsByType).toEqual({ issue: 0, agent: 3, project: 3 });
    expect(result.hasMore).toBe(true);
  });

  it("escapes underscore and backslash characters in issue phrase and token patterns", async () => {
    const companyId = await createCompany();
    const literalId = await createIssue(companyId, {
      identifier: "TST-27",
      title: "Literal foo_bar path c:\\tmp",
    });
    const decoyId = await createIssue(companyId, {
      identifier: "TST-28",
      title: "Decoy fooXbar path c:tmp",
    });

    for (const q of ["foo_bar", "c:\\tmp"]) {
      const result = await svc.search(companyId, companySearchQuerySchema.parse({ q, scope: "issues" }));
      const ids = result.results.map((row) => row.id);
      expect(ids, `q=${q}`).toContain(literalId);
      expect(ids, `q=${q}`).not.toContain(decoyId);
    }
  });

  it("uses pg_trgm for conservative fuzzy title matches", async () => {
    const companyId = await createCompany();
    const issueId = await createIssue(companyId, {
      identifier: "TST-9",
      title: "Onboarding wizard polish",
    });

    const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: "onbordng wizard" }));

    expect(result.results[0]?.id).toBe(issueId);
    expect(result.results[0]?.matchedFields).toContain("title");
  });

  it("matches transposition typos against multi-word titles", async () => {
    const companyId = await createCompany();
    const searchIssueId = await createIssue(companyId, {
      identifier: "TST-10",
      title: "Improve search performance",
    });
    const mobileIssueId = await createIssue(companyId, {
      identifier: "TST-11",
      title: "Polish mobile navigation",
    });
    const otherIssueId = await createIssue(companyId, {
      identifier: "TST-12",
      title: "Refactor billing reports",
    });

    const transpositionCases: Array<{ query: string; expectedId: string; rejected: string }> = [
      { query: "serach", expectedId: searchIssueId, rejected: otherIssueId },
      { query: "mibile", expectedId: mobileIssueId, rejected: otherIssueId },
      { query: "mobail", expectedId: mobileIssueId, rejected: otherIssueId },
    ];

    for (const { query, expectedId, rejected } of transpositionCases) {
      const result = await svc.search(companyId, companySearchQuerySchema.parse({ q: query }));
      const ids = result.results.map((row) => row.id);
      expect(ids, `query=${query}`).toContain(expectedId);
      expect(ids, `query=${query} should not match unrelated issue`).not.toContain(rejected);
    }
  });
});
