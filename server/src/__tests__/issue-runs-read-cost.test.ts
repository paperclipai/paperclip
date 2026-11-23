import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, applyPendingMigrations, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { activityService } from "../services/activity.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISSUE_RUNS_COST_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
type Plan = { "Relation Name"?: string; "Actual Rows": number; "Actual Loops": number;
  "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number; Plans?: Plan[] };

// The task chat reads a task's two latest runs before its first frame (the
// chat bootstrap and `/issues/:id/runs?view=recent`). That read must cost the
// task's own runs, not every run the company ever had.
describe.skipIf(!support.supported)("issue runs read cost", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let capture = false;
  const queries: Array<{ query: string; parameters: unknown[] }> = [];
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("issue-runs-cost-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
    db.$client.options.debug = (_connection, query, parameters) => {
      if (capture && /from "heartbeat_runs"/.test(query)) queries.push({ query, parameters: [...parameters] });
    };
  }, 30_000);
  afterEach(async () => { capture = false; queries.length = 0; await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it("reads a task's latest runs without walking the company's run history", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Busy", issuePrefix: `BR${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const [task, other] = await db.insert(issues).values([
      { companyId, title: "Opened task", status: "in_progress" },
      { companyId, title: "Other task", status: "in_progress" },
    ]).returning();
    // 20,000 runs of other work, newer than the task's own runs.
    await db.execute(sql`insert into heartbeat_runs (company_id, agent_id, issue_id, status, created_at)
      select ${companyId}::uuid, ${agentId}::uuid, ${other!.id}::uuid, 'succeeded',
        '2026-06-01T00:00:00Z'::timestamptz + n * interval '1 second' from generate_series(1, 20000) n`);
    // The task's runs: two linked directly, one only through its activity.
    const [direct1, direct2, viaActivity] = await db.insert(heartbeatRuns).values([
      { companyId, agentId, issueId: task!.id, status: "succeeded", createdAt: new Date("2026-01-01T00:00:01Z") },
      { companyId, agentId, issueId: task!.id, status: "succeeded", createdAt: new Date("2026-01-01T00:00:02Z") },
      { companyId, agentId, status: "succeeded", createdAt: new Date("2026-01-01T00:00:03Z") },
    ]).returning();
    await db.insert(activityLog).values({ companyId, actorType: "agent", actorId: agentId, action: "issue.updated",
      entityType: "issue", entityId: task!.id, runId: viaActivity!.id });
    await db.execute(sql`analyze heartbeat_runs`);
    await db.execute(sql`analyze activity_log`);

    capture = true;
    const recent = await activityService(db).runsForIssue(companyId, task!.id, null, 2, undefined, { skipLivenessBackfill: true });
    const all = await activityService(db).runsForIssue(companyId, task!.id, null, undefined, undefined, { skipLivenessBackfill: true });
    capture = false;

    expect(recent.map(run => run.runId)).toEqual([viaActivity!.id, direct2!.id]);
    expect(all.map(run => run.runId)).toEqual([viaActivity!.id, direct2!.id, direct1!.id]);

    expect(queries.length).toBeGreaterThan(0);
    let runRowsExamined = 0;
    for (const statement of queries) {
      const result = await db.$client.unsafe("EXPLAIN (ANALYZE, FORMAT JSON) " + statement.query, statement.parameters as never[]);
      const visit = (node: Plan) => {
        if (node["Relation Name"] === "heartbeat_runs") runRowsExamined += node["Actual Loops"]
          * (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0));
        node.Plans?.forEach(visit);
      };
      visit((result[0]!["QUERY PLAN"] as Array<{ Plan: Plan }>)[0]!.Plan);
    }
    process.stdout.write(JSON.stringify({ issueRunsReadCost: { companyRuns: 20003, runRowsExamined, queryCount: queries.length } }) + "\n");
    // Two reads of a three-run task. The other task's 20,000 runs must not be scanned.
    expect(runRowsExamined).toBeLessThanOrEqual(100);
  }, 120_000);
});
