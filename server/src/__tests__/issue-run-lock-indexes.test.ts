import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

type Plan = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; Plans?: Plan[] };
const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];

describeDatabase("issue execution lock lookups", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("issue-run-lock-indexes-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function plan(query: SQL) {
    const rows = await db.execute(sql`EXPLAIN (FORMAT JSON) ${query}`);
    return flatten((rows[0]["QUERY PLAN"] as Array<{ Plan: Plan }>)[0].Plan);
  }

  it("finds the issues a run holds through the run id indexes", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Locks", issuePrefix: `LK${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Locks" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" }).returning();
    const rows = Array.from({ length: 2_000 }, (_, i) => ({ companyId, title: `Task ${i}` }));
    const inserted = await db.insert(issues).values(rows).returning({ id: issues.id });
    const contextIssueId = inserted[0].id;
    await db.execute(sql`UPDATE issues SET execution_run_id = ${run.id}, checkout_run_id = ${run.id} WHERE id = ${contextIssueId}`);
    await db.execute(sql`ANALYZE issues`);

    const lock = await plan(sql`
      select id from issues
      where company_id = ${companyId}
        and (id = ${contextIssueId} or execution_run_id = ${run.id} or checkout_run_id = ${run.id})
      order by id for update`);
    const release = await plan(sql`
      update issues set execution_run_id = null
      where company_id = ${companyId} and execution_run_id = ${run.id}`);
    const checkout = await plan(sql`
      update issues set checkout_run_id = null
      where company_id = ${companyId} and checkout_run_id = ${run.id}`);

    for (const nodes of [lock, release, checkout]) {
      expect(nodes.some((node) => node["Node Type"] === "Seq Scan" && node["Relation Name"] === "issues")).toBe(false);
    }
    expect(lock.map((node) => node["Index Name"])).toEqual(expect.arrayContaining(["issues_execution_run_idx", "issues_checkout_run_idx"]));
    expect(release.map((node) => node["Index Name"])).toContain("issues_execution_run_idx");
    expect(checkout.map((node) => node["Index Name"])).toContain("issues_checkout_run_idx");
  });
});
