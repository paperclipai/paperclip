import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documents,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_ISSUE,
  companySearchExtractQuerySchema,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySearchExtractService } from "../services/company-search-extract.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres extract-search tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("extract-search query validation", () => {
  it("accepts supported extraction filters and rejects unsafe or ambiguous input", () => {
    const parsed = companySearchExtractQuerySchema.parse({
      contains: "github.com/paperclipai/paperclip/pull",
      kind: "url",
      scope: "comments",
      status: "in_progress,in_review",
      limit: "200",
      offset: "5000",
      updatedWithin: "30d",
    });

    expect(parsed.kind).toBe("url");
    expect(parsed.scope).toBe("comments");
    expect(parsed.status).toEqual(["in_progress", "in_review"]);
    expect(() => companySearchExtractQuerySchema.parse({ contains: ".*", kind: "regex" })).toThrow();
    expect(() => companySearchExtractQuerySchema.parse({ contains: "x" })).toThrow();
    expect(() => companySearchExtractQuerySchema.parse({ contains: "needle", limit: "201" })).toThrow();
    expect(() => companySearchExtractQuerySchema.parse({
      contains: "needle",
      updatedWithin: "30d",
      updatedAfter: "2026-01-01T00:00:00.000Z",
    })).toThrow();
  });
});

describeEmbeddedPostgres("companySearchExtractService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof companySearchExtractService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-search-extract-");
    db = createDb(tempDb.connectionString);
    svc = companySearchExtractService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
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
      issuePrefix: `E${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createIssue(companyId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const id = values.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      identifier: values.identifier ?? "EXT-1",
      title: values.title ?? "Extract target",
      description: values.description ?? null,
      status: values.status ?? "in_progress",
      priority: values.priority ?? "medium",
      ...values,
    });
    return id;
  }

  it("expands and deduplicates URLs across issue, comment, and document sources", async () => {
    const companyId = await createCompany();
    const firstUrl = "https://github.com/paperclipai/paperclip/pull/123";
    const secondUrl = "https://github.com/paperclipai/paperclip/pull/456";
    const thirdUrl = "https://github.com/paperclipai/paperclip/pull/789";
    const issueId = await createIssue(companyId, {
      description: `Primary ${firstUrl} and duplicate ${firstUrl}.`,
    });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      body: `Review ${secondUrl} and repeat ${firstUrl}`,
    });
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: `PR notes ${thirdUrl}`,
      latestBody: `Also see [the second PR](${secondUrl}).`,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });

    const result = await svc.extract(companyId, companySearchExtractQuerySchema.parse({
      contains: "github.com/paperclipai/paperclip/pull",
      kind: "url",
    }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.matches.map((match) => match.value)).toEqual([firstUrl, secondUrl, thirdUrl]);
    expect(result.results[0]?.matches.map((match) => match.field)).toEqual([
      "description",
      "comment",
      "document_title",
    ]);
    expect(result.results[0]?.matchesTruncated).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("keeps URL sources selected by scheme-less queries", async () => {
    const companyId = await createCompany();
    const titleUrl = "https://github.com/paperclipai/paperclip/pull/101";
    const descriptionUrl = "https://github.com/paperclipai/paperclip/pull/102";
    const documentTitleUrl = "https://github.com/paperclipai/paperclip/pull/103";
    const documentBodyUrl = "https://github.com/paperclipai/paperclip/pull/104";
    const issueId = await createIssue(companyId, {
      title: `Review ${titleUrl}`,
      description: `Then merge ${descriptionUrl}`,
    });
    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: `Tracking ${documentTitleUrl}`,
      latestBody: `Final follow-up ${documentBodyUrl}`,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
    });

    const result = await svc.extract(companyId, companySearchExtractQuerySchema.parse({
      contains: "github.com/paperclipai/paperclip/pull",
      kind: "url",
      scope: "all",
    }));

    expect(result.results[0]?.matches.map((match) => [match.field, match.value])).toEqual([
      ["title", titleUrl],
      ["description", descriptionUrl],
      ["document_title", documentTitleUrl],
      ["document_body", documentBodyUrl],
    ]);
  });

  it("filters by issue update window and status", async () => {
    const companyId = await createCompany();
    const now = Date.now();
    const recentId = await createIssue(companyId, {
      identifier: "EXT-RECENT",
      description: "needle",
      status: "in_review",
      updatedAt: new Date(now - 24 * 60 * 60 * 1000),
    });
    await createIssue(companyId, {
      identifier: "EXT-OLD",
      description: "needle",
      status: "in_review",
      updatedAt: new Date(now - 60 * 24 * 60 * 60 * 1000),
    });
    await createIssue(companyId, {
      identifier: "EXT-DONE",
      description: "needle",
      status: "done",
      updatedAt: new Date(now - 24 * 60 * 60 * 1000),
    });

    const result = await svc.extract(companyId, companySearchExtractQuerySchema.parse({
      contains: "needle",
      updatedWithin: "30d",
      status: "in_review",
    }));

    expect(result.results.map((row) => row.issueId)).toEqual([recentId]);
  });

  it("caps distinct matches per issue and marks truncation explicitly", async () => {
    const companyId = await createCompany();
    const urls = Array.from(
      { length: COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_ISSUE + 1 },
      (_, index) => `https://github.com/paperclipai/paperclip/pull/${index + 1}`,
    );
    await createIssue(companyId, { description: urls.join(" ") });

    const result = await svc.extract(companyId, companySearchExtractQuerySchema.parse({
      contains: "github.com/paperclipai/paperclip/pull",
      kind: "url",
    }));

    expect(result.results[0]?.matches).toHaveLength(COMPANY_SEARCH_EXTRACT_MAX_MATCHES_PER_ISSUE);
    expect(result.results[0]?.matchesTruncated).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("does not return matching issues from another company", async () => {
    const companyId = await createCompany();
    const otherCompanyId = await createCompany("Other");
    await createIssue(otherCompanyId, { description: "needle" });

    const result = await svc.extract(companyId, companySearchExtractQuerySchema.parse({ contains: "needle" }));

    expect(result.results).toEqual([]);
  });
});
