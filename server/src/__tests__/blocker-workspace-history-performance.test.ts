import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, companies, createDb, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_BLOCKER_HISTORY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
type Plan = { "Node Type": string; "Relation Name"?: string; "Actual Rows": number; "Actual Loops": number;
  "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number; Plans?: Plan[] };

describe.skipIf(!support.supported)("blocker workspace retained history cost", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let capture = false;
  const queries: Array<{ query: string; parameters: unknown[] }> = [];
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("blocker-history-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
    db.$client.options.debug = (_connection, query, parameters) => {
      if (capture && query.includes("workspace_operations")) queries.push({ query, parameters: [...parameters] });
    };
  }, 30_000);
  afterEach(async () => { capture = false; queries.length = 0; await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it.each(["finalized", "pending"] as const)("bounds operation-history work for 2100 blockers sharing 5000 %s operations", async kind => {
    const companyId = randomUUID(), workspaceId = randomUUID(), unrelatedWorkspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Shared history", issuePrefix: `SH${companyId.slice(0, 6)}` });
    const [root] = await db.insert(issues).values({ companyId, title: "History dependent", status: "blocked" }).returning();
    await db.execute(sql`insert into execution_workspaces (id, company_id, name, mode, strategy_type)
      values (${workspaceId}::uuid, ${companyId}::uuid, 'Shared operation history', 'shared', 'project_primary'),
        (${unrelatedWorkspaceId}::uuid, ${companyId}::uuid, 'Unrelated history', 'shared', 'project_primary')`);
    await db.execute(sql`insert into workspace_operations (company_id, execution_workspace_id, phase, status, started_at)
      select ${companyId}::uuid, ${unrelatedWorkspaceId}::uuid, 'worktree_prepare', 'succeeded',
        '2025-01-01T00:00:00Z'::timestamptz + n * interval '1 second' from generate_series(1, 50000) n`);
    await db.execute(sql`insert into workspace_operations (company_id, execution_workspace_id, phase, status, started_at)
      select ${companyId}::uuid, ${workspaceId}::uuid,
        case when n = 5000 and ${kind} = 'finalized' then 'workspace_finalize' else 'worktree_prepare' end,
        'succeeded', '2026-01-01T00:00:00Z'::timestamptz + n * interval '1 second' from generate_series(1, 5000) n`);
    await db.execute(sql`with history as (
      insert into issues (company_id, title, status, execution_workspace_id)
      select ${companyId}::uuid, 'done blocker ' || n, 'done', ${workspaceId}::uuid
      from generate_series(1, 2100) n returning id)
      insert into issue_relations (company_id, issue_id, related_issue_id, type)
      select ${companyId}::uuid, id, ${root.id}::uuid, 'blocks' from history`);
    await db.execute(sql`analyze workspace_operations`);
    await db.execute(sql`analyze issues`);
    await db.execute(sql`analyze issue_relations`);
    capture = true;
    const batch = await issueService(db).listBlockerAttentionBatch(companyId, [root]);
    capture = false;
    expect(queries.length).toBeGreaterThan(0);
    expect(Math.max(...queries.map(statement => statement.parameters.length))).toBeLessThanOrEqual(1100);
    let operationRowsExamined = 0;
    const measurements: unknown[] = [];
    for (const statement of queries) {
      const result = await db.$client.unsafe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement.query,
        statement.parameters as never[]);
      const explain = (result[0]!["QUERY PLAN"] as Array<{ Plan: Plan }>)[0]!;
      const visit = (node: Plan) => {
        if (node["Relation Name"] === "workspace_operations") operationRowsExamined += node["Actual Loops"]
          * (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0));
        node.Plans?.forEach(visit);
      };
      visit(explain.Plan);
      measurements.push({ ...statement, explain });
    }
    process.stdout.write(JSON.stringify({ sharedWorkspaceHistory: { kind, blockers: 2100, retainedOperations: 5000, unrelatedOperations: 50000,
      operationRowsExamined, queryCount: queries.length, measurements } }) + "\n");
    // The finite graph/pair pages may each read the 5,000 candidate rows once.
    // Neither 2,100 blockers nor 50,000 unrelated operations may multiply that work.
    expect(operationRowsExamined).toBeLessThanOrEqual(55_000);
    expect(batch.deferredRootIds.has(root.id)).toBe(kind === "pending");
    if (kind === "finalized") expect(batch.nodeCount).toBe(1);
  }, 120_000);
  it("preserves attributed precedence and the strict later-finalize boundary", async () => {
    const companyId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Finalize policy", issuePrefix: `FP${companyId.slice(0, 6)}` });
    await db.execute(sql`insert into execution_workspaces (id, company_id, name, mode, strategy_type)
      values (${workspaceId}::uuid, ${companyId}::uuid, 'Policy workspace', 'shared', 'project_primary')`);
    const roots = await db.insert(issues).values(["older", "equal", "fallback"].map(title => ({ companyId, title, status: "blocked" }))).returning();
    const blockers = await db.insert(issues).values(roots.map(root => ({ companyId, title: root.title + " blocker", status: "done", executionWorkspaceId: workspaceId }))).returning();
    for (let index = 0; index < roots.length; index += 1) {
      await db.execute(sql`insert into issue_relations (company_id, issue_id, related_issue_id, type)
        values (${companyId}::uuid, ${blockers[index]!.id}::uuid, ${roots[index]!.id}::uuid, 'blocks')`);
    }
    await db.execute(sql`insert into workspace_operations (company_id, execution_workspace_id, issue_id, phase, status, started_at) values
      (${companyId}::uuid, ${workspaceId}::uuid, ${blockers[0]!.id}::uuid, 'worktree_prepare', 'succeeded', '2026-01-01T00:00:01Z'),
      (${companyId}::uuid, ${workspaceId}::uuid, ${blockers[1]!.id}::uuid, 'worktree_prepare', 'succeeded', '2026-01-01T00:00:02Z'),
      (${companyId}::uuid, ${workspaceId}::uuid, null, 'workspace_finalize', 'succeeded', '2026-01-01T00:00:02Z'),
      (${companyId}::uuid, ${workspaceId}::uuid, null, 'worktree_prepare', 'succeeded', '2026-01-01T00:00:03Z')`);
    const service = issueService(db);
    expect((await service.listBlockerAttentionBatch(companyId, [roots[0]!])).nodeCount).toBe(1);
    expect((await service.listBlockerAttentionBatch(companyId, [roots[1]!])).nodeCount).toBe(2);
    expect((await service.listBlockerAttentionBatch(companyId, [roots[2]!])).nodeCount).toBe(2);
  });

});
