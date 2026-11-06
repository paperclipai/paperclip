import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const indexName = "heartbeat_runs_company_agent_created_idx";
const migrationFile = "0435_burly_guardsmen.sql";

(support.supported ? describe : describe.skip)("heartbeat_runs agent run-list index migration", () => {
  it("builds the agent created_at index and repairs an invalid copy after concurrent replay", async () => {
    const database = await startEmbeddedPostgresTestDatabase("heartbeat-runs-agent-created-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const readIndex = async () => (await sql`SELECT indisvalid, pg_get_indexdef(indexrelid) AS definition
        FROM pg_index WHERE indexrelid = ${indexName}::regclass`)[0];
      const built = await readIndex();
      expect(built!.indisvalid).toBe(true);
      expect(built!.definition).toContain("heartbeat_runs USING btree (company_id, agent_id, created_at DESC)");
      await sql`INSERT INTO companies (name, issue_prefix) VALUES ('First', 'HRA1'), ('Second', 'HRA2')`;
      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await sql.unsafe(`DROP INDEX ${indexName}`);
      await expect(sql.unsafe(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON companies ((true))`)).rejects.toThrow();
      expect((await readIndex())!.indisvalid).toBe(false);
      await Promise.all([applyPendingMigrations(database.connectionString), applyPendingMigrations(database.connectionString)]);
      expect(await readIndex()).toEqual(built);
      const [history] = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      expect(history!.count).toBe(1);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 120_000);
});
