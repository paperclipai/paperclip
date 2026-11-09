import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const indexName = "heartbeat_runs_company_native_workspace_idx";
const migrationFile = "0453_curious_ben_parker.sql";

(support.supported ? describe : describe.skip)("workspace companion expression index", () => {
  it("builds outside a transaction and preserves ordered prepared/finalized references", async () => {
    const database = await startEmbeddedPostgresTestDatabase("workspace-companion-index-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const migration = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(migration).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      await sql.unsafe(`DROP INDEX ${indexName}`);
      const companies = await sql`INSERT INTO companies(name,issue_prefix) VALUES ('Index fixture','CIX1'),('Foreign fixture','CIX2') RETURNING id`;
      const company = companies[0]!.id, foreignCompany = companies[1]!.id;
      const [agent] = await sql`INSERT INTO agents(company_id,name) VALUES (${company},'Local fixture') RETURNING id`;
      const [foreignAgent] = await sql`INSERT INTO agents(company_id,name) VALUES (${foreignCompany},'Foreign fixture') RETURNING id`;
      const issues = await sql`INSERT INTO issues(company_id,title) VALUES (${company},'Source issue'),(${company},'Other source issue') RETURNING id`;
      const workspace = randomUUID(), expected: string[] = [];
      for (const [state, issue] of [["prepared", issues[0]!.id], ["finalized", issues[1]!.id], ["prepared", null], ["finalized", null]] as const) {
        const id = randomUUID(); expected.push(id);
        await sql`INSERT INTO heartbeat_runs(id,company_id,agent_id,native_issue_id,runner_profile_json)
          VALUES (${id},${company},${agent!.id},${issue},${sql.json({ nativeWorkspaceSync: { workspaceId: workspace, state } })})`;
      }
      await sql`INSERT INTO heartbeat_runs(company_id,agent_id,runner_profile_json)
        VALUES (${foreignCompany},${foreignAgent!.id},${sql.json({ nativeWorkspaceSync: { workspaceId: workspace, state: "prepared" } })})`;
      for (const sync of [{ workspaceId: { malformed: true }, state: "prepared" }, { workspaceId: workspace.toUpperCase(), state: "prepared" }, { workspaceId: workspace, state: "other" }, { workspaceId: workspace }, "malformed", null]) {
        await sql`INSERT INTO heartbeat_runs(company_id,agent_id,runner_profile_json)
          VALUES (${company},${agent!.id},${sql.json({ nativeWorkspaceSync: sync })})`;
      }
      const before = await sql`SELECT id,native_issue_id,runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}' workspace_id,
        runner_profile_json#>>'{nativeWorkspaceSync,state}' state FROM heartbeat_runs
        WHERE company_id=${company} AND runner_profile_json#>>'{nativeWorkspaceSync,workspaceId}'=${workspace}
        AND runner_profile_json#>>'{nativeWorkspaceSync,state}' IN ('prepared','finalized') ORDER BY id`;
      expect(before.map(row => row.id)).toEqual(expected.sort());
      await applyPendingMigrations(database.connectionString);
      const after = await sql`SELECT id,native_issue_id,runner_profile_json->'nativeWorkspaceSync'->>'workspaceId' workspace_id,
        runner_profile_json->'nativeWorkspaceSync'->>'state' state FROM heartbeat_runs
        WHERE company_id=${company} AND runner_profile_json->'nativeWorkspaceSync'->>'workspaceId'=${workspace}
        AND runner_profile_json->'nativeWorkspaceSync'->>'state' IN ('prepared','finalized') ORDER BY id`;
      expect(after).toEqual(before);
      const [index] = await sql`SELECT indisvalid,indisready,pg_get_expr(indpred,indrelid) predicate,pg_get_indexdef(indexrelid) definition
        FROM pg_index WHERE indexrelid=${indexName}::regclass`;
      expect(index).toMatchObject({ indisvalid: true, indisready: true, predicate: null });
      expect(index!.definition).toContain("company_id");
      expect(index!.definition).toContain("nativeWorkspaceSync");
      expect(index!.definition).toContain("workspaceId");
      await applyPendingMigrations(database.connectionString);
      const [history] = await sql`SELECT count(*)::int count FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      expect(history!.count).toBe(1);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 90_000);
});
