import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const indexName = "agent_wakeup_requests_question_response_history_idx";
const migrationFile = "0332_little_night_nurse.sql";

(support.supported ? describe : describe.skip)("question-response history migration", () => {
  it("repairs an interrupted concurrent index build and serializes replay without deleting wakes", async () => {
    const database = await startEmbeddedPostgresTestDatabase("question-history-migration-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Migration fixture', 'QHM')`;
      await sql`INSERT INTO agents (id, company_id, name, role, adapter_type)
        VALUES (${agentId}, ${companyId}, 'Fixture', 'engineer', 'process')`;
      await sql`INSERT INTO agent_wakeup_requests (company_id, agent_id, source, idempotency_key, status)
        SELECT ${companyId}::uuid, ${agentId}::uuid, 'automation', 'question-response:' || n::text, 'failed'
        FROM generate_series(1, 3) n`;
      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await sql.unsafe(`DROP INDEX ${indexName}`);
      // A failed concurrent UNIQUE build leaves the same invalid-index state
      // as an interrupted nonunique build, without relying on timing a cancel.
      await expect(sql.unsafe(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON agent_wakeup_requests (company_id)`))
        .rejects.toThrow();
      const [invalid] = await sql`SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ${indexName}`;
      expect(invalid?.indisvalid).toBe(false);
      await Promise.all([applyPendingMigrations(database.connectionString), applyPendingMigrations(database.connectionString)]);
      const [rebuilt] = await sql`SELECT i.indisvalid, i.indisunique, pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = ${indexName}`;
      expect(rebuilt?.indisvalid).toBe(true);
      expect(rebuilt?.indisunique).toBe(false);
      expect(rebuilt?.definition).toContain("company_id, idempotency_key");
      expect(rebuilt?.definition).toContain("question-response:%");
      const [wakes] = await sql`SELECT count(*)::int AS n FROM agent_wakeup_requests WHERE company_id = ${companyId}`;
      expect(wakes?.n).toBe(3);
      const [history] = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      expect(history?.n).toBe(1);
      await applyPendingMigrations(database.connectionString);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 60_000);
});
