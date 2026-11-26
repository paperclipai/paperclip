import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("heartbeat run issue lookup indexes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-run-issue-lookup-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    await db.execute(sql`ALTER TABLE heartbeat_runs DISABLE TRIGGER heartbeat_runs_set_scope_kind`);
  });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lookup", issuePrefix: `LK${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lookup" });
    const nativeIssueIds = Array.from({ length: 20 }, () => randomUUID());
    const legacyIssueIds = Array.from({ length: 30 }, () => randomUUID());
    await db.execute(sql`
      insert into heartbeat_runs (company_id, agent_id, status, native_issue_id, created_at)
      select ${companyId}::uuid, ${agentId}::uuid, 'succeeded', (${sql.param(nativeIssueIds)}::uuid[])[1 + n % 20],
        now() - interval '30 days' + n * interval '1 second'
      from generate_series(1, 4000) n
    `);
    await db.execute(sql`
      insert into heartbeat_runs (company_id, agent_id, status, context_snapshot, created_at)
      select ${companyId}::uuid, ${agentId}::uuid, 'succeeded',
        jsonb_build_object('issueId', (${sql.param(legacyIssueIds)}::text[])[1 + n % 30]),
        now() - interval '10 days' + n * interval '1 second'
      from generate_series(1, 6000) n
    `);
    await db.execute(sql`analyze heartbeat_runs`);
    return { companyId, agentId, legacyIssueIds };
  }

  async function plan(query: ReturnType<typeof sql>) {
    return JSON.stringify(await db.execute(sql`explain (format json) ${query}`));
  }

  it("finds the newest native run of an issue without walking the company's runs", async () => {
    const { companyId } = await seed();
    const text = await plan(sql`
      select id from heartbeat_runs
      where company_id = ${companyId}::uuid and native_issue_id = ${randomUUID()}::uuid
      order by created_at desc, id desc limit 1
    `);
    expect(text).toContain("heartbeat_runs_company_native_issue_created_idx");
    expect(text).not.toContain("heartbeat_runs_company_created_at_desc_idx");
  });

  it("finds the latest settled run per agent and issue key by index", async () => {
    const { companyId, agentId, legacyIssueIds } = await seed();
    const issueKey = sql`coalesce(native_issue_id::text, context_snapshot->>'issueId')`;
    const text = await plan(sql`
      select distinct on (agent_id, ${issueKey}) id, agent_id, ${issueKey}
      from heartbeat_runs
      where company_id = ${companyId}::uuid and agent_id in (${agentId}::uuid)
        and ${issueKey} in (${legacyIssueIds[0]}, ${legacyIssueIds[1]})
        and status in ('succeeded', 'failed', 'cancelled', 'timed_out')
      order by agent_id, ${issueKey}, created_at desc
    `);
    expect(text).toContain("heartbeat_runs_company_agent_issue_settled_idx");
    expect(text).not.toContain("Seq Scan");
  });
});
