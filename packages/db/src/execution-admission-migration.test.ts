import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const hashMigration = async (name: string) => createHash("sha256")
  .update(await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8")).digest("hex");
const migrationName = "0426_absent_guardian.sql";
const migrationHash = await hashMigration(migrationName);
const retainedSetMigration = "0428_retained_admitted_project_sets.sql";
const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("execution admission migration", () => {
  it("adds empty admission storage without changing existing projects or runs", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-admission-migration-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql`DROP TABLE execution_admission_project_charges, execution_admissions, project_task_execution_policies`;
      await sql`DROP FUNCTION paperclip_execution_admission_project_set_immutable`;
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash IN (${migrationHash}, ${await hashMigration(retainedSetMigration)})`;
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
        .toMatchObject({ status: "needsMigrations", pendingMigrations: [migrationName, retainedSetMigration] });

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

  it("keeps the admitted sets of shipped 0426 rows that still have charges and marks settled ones unknown", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-admission-sets-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql`DROP TRIGGER paperclip_execution_admission_project_set_immutable ON execution_admissions`;
      await sql`DROP FUNCTION paperclip_execution_admission_project_set_immutable`;
      await sql`ALTER TABLE execution_admissions DROP CONSTRAINT execution_admissions_project_set_check, DROP COLUMN admitted_project_ids`;
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${await hashMigration(retainedSetMigration)}`;
      const companyId = randomUUID(), agentId = randomUUID();
      const [a, b] = [randomUUID(), randomUUID()].sort();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Upgrade', 'UPS')`;
      await sql`INSERT INTO agents (id, company_id, name, adapter_type) VALUES (${agentId}, ${companyId}, 'Agent', 'process')`;
      await sql`INSERT INTO projects (id, company_id, name) VALUES (${b}, ${companyId}, 'B'), (${a}, ${companyId}, 'A')`;
      const [live, empty, settled] = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of [live, empty, settled]) {
        const [run] = await sql`INSERT INTO heartbeat_runs (company_id, agent_id) VALUES (${companyId}, ${agentId}) RETURNING id`;
        await sql`INSERT INTO execution_admissions (id, company_id, run_id, attempt, primary_project_id, context_revision,
          settlement_id, settled_at) VALUES (${id}, ${companyId}, ${run.id}, 1, ${a}, 'issue:1',
          ${id === settled ? randomUUID() : null}, ${id === settled ? sql`now()` : null})`;
      }
      await sql`INSERT INTO execution_admission_project_charges (admission_id, company_id, project_id)
        VALUES (${live}, ${companyId}, ${b}), (${live}, ${companyId}, ${a})`;

      const sets = () => sql`SELECT id, admitted_project_ids FROM execution_admissions ORDER BY id`;
      await applyPendingMigrations(database.connectionString);

      const upgraded = await sets();
      expect(upgraded).toEqual(expect.arrayContaining([
        { id: live, admitted_project_ids: [a, b] },
        { id: empty, admitted_project_ids: [] },
        { id: settled, admitted_project_ids: null },
      ]));
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${await hashMigration(retainedSetMigration)}`;
      await applyPendingMigrations(database.connectionString);
      expect(await sets()).toEqual(upgraded);
      expect(await sql`SELECT count(*)::int AS count FROM execution_admission_project_charges`).toEqual([{ count: 2 }]);
      await expect(sql`UPDATE execution_admissions SET admitted_project_ids = '{}' WHERE id = ${settled}`)
        .rejects.toMatchObject({ message: "execution admission project set is immutable" });
      expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
