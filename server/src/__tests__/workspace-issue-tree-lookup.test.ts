import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { workspaceIssueTreeCondition } from "../services/execution-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

type Plan = {
  "Node Type": string;
  "Relation Name"?: string;
  "Parent Relationship"?: string;
  "Actual Rows"?: number;
  Plans?: Plan[];
};

function allPlanNodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(allPlanNodes)];
}

function outerPlanNodes(plan: Plan): Plan[] {
  const children = (plan.Plans ?? [])
    .filter((child) => child["Parent Relationship"] !== "InitPlan")
    .flatMap(outerPlanNodes);
  return [plan, ...children];
}

describeDatabase("workspace issue tree lookup", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("workspace-issue-tree-lookup-");
    db = createDb(database.connectionString, { maxConnections: 1 });
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  async function seedTree() {
    const companyId = randomUUID();
    const rootId = randomUUID();
    const childId = randomUUID();
    const grandchildId = randomUUID();
    const unrelatedId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Issue tree", issuePrefix: `IT${companyId.slice(0, 6)}` });
    await db.insert(issues).values([
      { id: rootId, companyId, title: "Root" },
      { id: childId, companyId, title: "Child", parentId: rootId },
      { id: grandchildId, companyId, title: "Grandchild", parentId: childId },
      { id: unrelatedId, companyId, title: "Unrelated" },
      ...Array.from({ length: 2000 }, (_, index) => ({ companyId, title: `Filler ${index}` })),
    ]);
    await db.execute(sql`ANALYZE issues`);
    return { companyId, rootId, childId, grandchildId, unrelatedId };
  }

  it("returns the source issue and all of its descendants", async () => {
    const { companyId, rootId, childId, grandchildId } = await seedTree();
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), workspaceIssueTreeCondition(companyId, rootId)));
    expect(rows.map((row) => row.id).sort()).toEqual([rootId, childId, grandchildId].sort());
  });

  it("runs the recursive lookup once and reads the outer issues table through an index", async () => {
    const { companyId, rootId } = await seedTree();
    const query = db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), workspaceIssueTreeCondition(companyId, rootId)))
      .toSQL();
    const [explained] = await db.$client.unsafe(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${query.sql}`,
      query.params as never[],
    );
    const root = (explained["QUERY PLAN"] as Array<{ Plan: Plan }>)[0].Plan;
    const outerIssueScans = outerPlanNodes(root).filter((node) => node["Relation Name"] === "issues");
    expect(allPlanNodes(root).some((node) => node["Parent Relationship"] === "InitPlan")).toBe(true);
    expect(outerPlanNodes(root).some((node) => node["Node Type"].includes("Join"))).toBe(false);
    expect(outerIssueScans.length).toBeGreaterThan(0);
    expect(outerIssueScans.some((node) => node["Node Type"] === "Seq Scan")).toBe(false);
    expect(outerIssueScans.every((node) => (node["Actual Rows"] ?? 0) <= 3)).toBe(true);
  });
});
