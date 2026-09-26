import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping identifier index usage test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list identifier filter index usage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-identifier-idx-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // Enough rows that a seq scan is distinguishable from an index scan.
    await db.insert(issues).values(
      Array.from({ length: 2_000 }, (_, idx) => ({
        id: randomUUID(),
        companyId,
        identifier: `PAP-${idx + 1}`,
        title: `Issue ${idx + 1}`,
        status: "todo" as const,
        priority: "medium" as const,
      })),
    );
    await db.execute(sql`ANALYZE issues`);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves a single identifier through issues_identifier_idx, not a scan", async () => {
    const rows = await db.execute<{ "QUERY PLAN": string }>(sql`
      EXPLAIN (FORMAT TEXT)
      SELECT id FROM issues
      WHERE company_id = ${companyId} AND identifier = ${"PAP-1234"}
    `);
    const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(plan, plan).toContain("issues_identifier_idx");
    expect(plan, plan).not.toMatch(/Seq Scan on issues/);
  });
});
