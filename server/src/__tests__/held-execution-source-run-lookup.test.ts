import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, issueRecoveryActions, issues } from "@paperclipai/db";
import { heldExecutionWhere, recentInterruptionSourceSql } from "../services/fresh-continuation-eligibility.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

type PlanNode = { "Alias"?: string; "Parent Relationship"?: string; "Plans"?: PlanNode[] };

function sourceRunScans(node: PlanNode, underSubPlan = false): boolean[] {
  const inSubPlan = underSubPlan || node["Parent Relationship"] === "SubPlan";
  const own = node["Alias"] === "source" ? [inSubPlan] : [];
  return [...own, ...(node["Plans"] ?? []).flatMap(child => sourceRunScans(child, inSubPlan))];
}

describeDatabase("held execution source run lookup", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("held-execution-source-run-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function scans(where: ReturnType<typeof and>) {
    const query = db.select({ count: sql<number>`count(*)::int` }).from(issueRecoveryActions)
      .innerJoin(issues, and(eq(issues.id, issueRecoveryActions.sourceIssueId), eq(issues.companyId, issueRecoveryActions.companyId)))
      .where(where);
    const [row] = await db.execute<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(sql`explain (format json) ${query}`);
    return sourceRunScans(row["QUERY PLAN"][0].Plan);
  }

  it("looks up each held record's source run by key instead of joining every failed run", async () => {
    const found = await scans(and(heldExecutionWhere(), sql`not ${recentInterruptionSourceSql(new Date())}`));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(Boolean)).toBe(true);
  });

  it("keeps the per-record lookup when active watchdog holds are included", async () => {
    const found = await scans(heldExecutionWhere({ includeActive: true }));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every(Boolean)).toBe(true);
  });
});
