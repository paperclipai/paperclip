import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const migrationName = "0425_little_hobgoblin.sql";
const migrationHash = createHash("sha256")
  .update(await readFile(new URL(`./migrations/${migrationName}`, import.meta.url), "utf8")).digest("hex");
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("execution admission migration", () => {
  it("adds empty admission storage without changing existing projects or runs", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-admission-migration-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql`DROP TABLE execution_admission_project_charges, execution_admissions, project_task_execution_policies`;
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash}`;
      const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Upgrade', 'UPG')`;
      await sql`INSERT INTO agents (id, company_id, name, adapter_type) VALUES (${agentId}, ${companyId}, 'Agent', 'process')`;
      await sql`INSERT INTO projects (id, company_id, name, execution_workspace_policy, archived_at) VALUES
        (${projectId}, ${companyId}, 'Legacy', '{"enabled":true,"sharedWorkspaceConcurrency":"serialize"}', now())`;
      await sql`INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot) VALUES
        (${companyId}, ${agentId}, 'running', ${sql.json({ projectId })})`;
      const contents = async () => ({
        projects: await sql`SELECT * FROM projects ORDER BY id`,
        runs: await sql`SELECT * FROM heartbeat_runs ORDER BY id`,
      });
      const before = await contents();
      expect(await inspectMigrations(database.connectionString))
        .toMatchObject({ status: "needsMigrations", pendingMigrations: [migrationName] });

      await applyPendingMigrations(database.connectionString);

      expect(await contents()).toEqual(before);
      for (const table of ["project_task_execution_policies", "execution_admissions", "execution_admission_project_charges"]) {
        expect(await sql.unsafe(`SELECT count(*)::int AS count FROM "${table}"`)).toEqual([{ count: 0 }]);
      }
      expect((await sql`SELECT conname FROM pg_constraint WHERE conrelid = 'execution_admission_project_charges'::regclass
        AND contype = 'f' ORDER BY conname`).map(row => row.conname)).toEqual([
        "execution_admission_project_charges_company_admission_fk",
        "execution_admission_project_charges_company_project_fk",
      ]);
      expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
