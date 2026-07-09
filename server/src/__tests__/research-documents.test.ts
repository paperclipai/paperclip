import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, documents, issueDocuments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { researchDocumentService } from "../services/research-documents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres research document tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("research documents", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof researchDocumentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-research-documents-");
    db = createDb(tempDb.connectionString);
    svc = researchDocumentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: companyId.slice(0, 8),
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedDocument(input: {
    companyId: string;
    key: string;
    body: string;
    title?: string | null;
    issueTitle?: string;
    issueIdentifier?: string | null;
    createdByUserId?: string | null;
    createdByAgentId?: string | null;
  }) {
    const issueId = randomUUID();
    const documentId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.issueTitle ?? "Research task",
      identifier: input.issueIdentifier ?? null,
      createdByUserId: input.createdByUserId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
    });
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: input.title ?? null,
      format: "markdown",
      latestBody: input.body,
      latestRevisionNumber: 1,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId,
      documentId,
      key: input.key,
    });
    return { issueId, documentId };
  }

  it("lists research documents and ignores non-research keys", async () => {
    const companyId = await seedCompany();
    await seedDocument({ companyId, key: "research", body: "Findings about pricing", title: "Pricing" });
    await seedDocument({ companyId, key: "plan", body: "Not research" });

    const items = await svc.list(companyId);
    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe("research");
    expect(items[0]?.title).toBe("Pricing");
    expect(items[0]?.excerpt).toBe("Findings about pricing");
  });

  it("includes research-* fallback keys produced when a document is locked", async () => {
    const companyId = await seedCompany();
    await seedDocument({ companyId, key: "research-2", body: "Second research doc" });

    const items = await svc.list(companyId);
    expect(items.map((item) => item.key)).toEqual(["research-2"]);
  });

  it("resolves who started the research (agent name preferred over user id)", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Researcher", role: "researcher" });

    await seedDocument({ companyId, key: "research", body: "By agent", createdByAgentId: agentId });
    await seedDocument({ companyId, key: "research", body: "By user", createdByUserId: "jonas" });

    const items = await svc.list(companyId);
    const labels = items.map((item) => item.startedByLabel).sort();
    expect(labels).toEqual(["Researcher", "jonas"]);
  });

  it("scopes research documents by company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    await seedDocument({ companyId, key: "research", body: "Mine" });
    await seedDocument({ companyId: otherCompanyId, key: "research", body: "Theirs" });

    expect(await svc.list(companyId)).toHaveLength(1);
  });

  it("returns the full body only via get()", async () => {
    const companyId = await seedCompany();
    const longBody = `${"word ".repeat(200)}end`;
    const { documentId } = await seedDocument({ companyId, key: "research", body: longBody });

    const [listed] = await svc.list(companyId);
    expect(listed?.excerpt.length).toBeLessThan(longBody.length);
    expect("body" in listed!).toBe(false);

    const detail = await svc.get(companyId, documentId);
    expect(detail?.body).toBe(longBody);

    expect(await svc.get(companyId, randomUUID())).toBeNull();
  });
});
