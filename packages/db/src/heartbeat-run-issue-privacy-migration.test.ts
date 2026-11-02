import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0313_private_task_access.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
if (!embeddedPostgresSupport.supported) console.warn(`Private-task migration checks unavailable: ${embeddedPostgresSupport.reason}`);
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("heartbeat run issue privacy migration", () => {
  it("backfills every valid context issue binding and preserves maintenance runs", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-run-issue-privacy-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    await sql`DROP TRIGGER IF EXISTS heartbeat_runs_set_scope_kind ON heartbeat_runs`;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const maintenanceRunId = randomUUID();

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Run Privacy', 'RPR')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
      VALUES (${agentId}, ${companyId}, 'Runner', 'engineer', 'process', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier")
      VALUES
        (${firstIssueId}, ${companyId}, 'First private task', 'RPR-1'),
        (${secondIssueId}, ${companyId}, 'Second private task', 'RPR-2')
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "issue_id", "context_snapshot"
      )
      VALUES
        (${firstRunId}, ${companyId}, ${agentId}, 'succeeded', NULL, ${sql.json({ issueId: firstIssueId })}),
        (${secondRunId}, ${companyId}, ${agentId}, 'failed', NULL, ${sql.json({ taskId: secondIssueId })}),
        (${maintenanceRunId}, ${companyId}, ${agentId}, 'succeeded', NULL, ${sql.json({ wakeReason: "heartbeat_timer" })})
    `;

    const legacyProjectId = randomUUID();
    await sql`INSERT INTO projects (id, company_id, name, visibility) VALUES (${legacyProjectId}, ${companyId}, 'Legacy private project', 'private')`;
    await sql`INSERT INTO activity_log (company_id, actor_type, actor_id, action, entity_type, entity_id)
      VALUES (${companyId}, 'user', 'original-owner', 'project.created', 'project', ${legacyProjectId})`;
    await sql`INSERT INTO project_access_members (company_id, project_id, subject_type, subject_id)
      VALUES (${companyId}, ${legacyProjectId}, 'user', 'ordinary-reader')`;

    const agentProjectId = randomUUID(), runProjectId = randomUUID(), preferredProjectId = randomUUID();
    await sql`UPDATE heartbeat_runs SET responsible_user_id = 'run-owner' WHERE id = ${secondRunId}`;
    await sql`INSERT INTO projects (id, company_id, name, visibility) VALUES
      (${agentProjectId}, ${companyId}, 'Agent API project', 'private'),
      (${runProjectId}, ${companyId}, 'Run-backed project', 'private'),
      (${preferredProjectId}, ${companyId}, 'Recorded owner project', 'private')`;
    await sql`INSERT INTO activity_log (company_id, actor_type, actor_id, responsible_user_id, run_id, action, entity_type, entity_id) VALUES
      (${companyId}, 'agent', ${agentId}, 'activity-owner', NULL, 'project.created', 'project', ${agentProjectId}),
      (${companyId}, 'agent', ${agentId}, NULL, ${secondRunId}, 'project.created', 'project', ${runProjectId}),
      (${companyId}, 'agent', ${agentId}, 'activity-owner', ${secondRunId}, 'project.created', 'project', ${preferredProjectId})`;

    await applyPendingMigrations(database.connectionString);
    for (const [projectId, owner] of [[agentProjectId, 'activity-owner'], [runProjectId, 'run-owner'], [preferredProjectId, 'activity-owner']]) {
      expect(await sql`SELECT privacy_owner_user_id FROM projects WHERE id = ${projectId}`).toEqual([{ privacy_owner_user_id: owner }]);
      expect(await sql`SELECT subject_id FROM project_access_members WHERE project_id = ${projectId}`).toEqual([{ subject_id: owner }]);
    }
    const [legacyProject] = await sql`SELECT privacy_owner_user_id FROM projects WHERE id = ${legacyProjectId}`;
    expect(legacyProject.privacy_owner_user_id).toBe('original-owner');
    expect(await sql`SELECT subject_id FROM project_access_members WHERE project_id = ${legacyProjectId} ORDER BY subject_id`)
      .toEqual([{ subject_id: 'ordinary-reader' }, { subject_id: 'original-owner' }]);


    const rows = await sql<{ id: string; issue_id: string | null; scope_kind: string }[]>`
      SELECT "id", "issue_id", "scope_kind"
      FROM "heartbeat_runs"
      WHERE "id" IN (${firstRunId}, ${secondRunId}, ${maintenanceRunId})
      ORDER BY "id"
    `;
    const issueByRun = new Map(rows.map((row) => [row.id, row.issue_id]));
    expect(issueByRun.get(firstRunId)).toBe(firstIssueId);
    expect(issueByRun.get(secondRunId)).toBe(secondIssueId);
    expect(issueByRun.get(maintenanceRunId)).toBeNull();
    expect(rows.find((row) => row.id === firstRunId)?.scope_kind).toBe("issue");
    expect(rows.find((row) => row.id === secondRunId)?.scope_kind).toBe("issue");
    expect(rows.find((row) => row.id === maintenanceRunId)?.scope_kind).toBe("company");

    const [parity] = await sql<{ expected_count: number; populated_count: number }[]>`
      SELECT
        count(*) FILTER (WHERE "context_snapshot" ? 'issueId' OR "context_snapshot" ? 'taskId')::int AS "expected_count",
        count(*) FILTER (WHERE ("context_snapshot" ? 'issueId' OR "context_snapshot" ? 'taskId') AND "issue_id" IS NOT NULL)::int AS "populated_count"
      FROM "heartbeat_runs"
      WHERE "id" IN (${firstRunId}, ${secondRunId}, ${maintenanceRunId})
    `;
    expect(parity).toEqual({ expected_count: 2, populated_count: 2 });

    const [newRun] = await sql<{ id: string; issue_id: string | null; scope_kind: string }[]>`
      INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot)
      VALUES (${companyId}, ${agentId}, 'succeeded', ${sql.json({ taskId: secondIssueId })})
      RETURNING id, issue_id, scope_kind`;
    expect(newRun).toMatchObject({ issue_id: secondIssueId, scope_kind: "issue" });
    await sql`UPDATE heartbeat_runs SET context_snapshot = '{}'::jsonb, scope_kind = 'company' WHERE id = ${newRun.id}`;
    expect(await sql`SELECT issue_id, scope_kind FROM heartbeat_runs WHERE id = ${newRun.id}`)
      .toEqual([{ issue_id: secondIssueId, scope_kind: "issue" }]);

    const indexes = await sql<{ indexname: string }[]>`
      SELECT "indexname"
      FROM "pg_indexes"
      WHERE "schemaname" = 'public'
        AND "indexname" = 'heartbeat_runs_company_issue_created_idx'
    `;
    expect(indexes).toHaveLength(1);
  }, 30_000);

  it("fails closed when a legacy issue claim cannot be resolved", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-run-issue-privacy-invalid-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    await sql`DROP TRIGGER IF EXISTS heartbeat_runs_set_scope_kind ON heartbeat_runs`;
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const foreignIssueId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES
        (${companyId}, 'Run Privacy', 'RPI'),
        (${otherCompanyId}, 'Other Company', 'RPO')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
      VALUES (${agentId}, ${companyId}, 'Runner', 'engineer', 'process', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier")
      VALUES (${foreignIssueId}, ${otherCompanyId}, 'Foreign task', 'RPO-1')
    `;
    await sql`
      INSERT INTO "heartbeat_runs" ("company_id", "agent_id", "status", "context_snapshot")
      VALUES
        (${companyId}, ${agentId}, 'succeeded', ${sql.json({ issueId: "not-a-uuid" })}),
        (${companyId}, ${agentId}, 'succeeded', ${sql.json({ issueId: randomUUID() })}),
        (${companyId}, ${agentId}, 'succeeded', ${sql.json({ issueId: foreignIssueId })}),
        (${companyId}, ${agentId}, 'succeeded', ${sql.json({ taskId: "not-a-uuid" })}),
        (${companyId}, ${agentId}, 'succeeded', ${sql.json({ taskId: randomUUID() })}),
        (${companyId}, ${agentId}, 'succeeded', ${sql.json({ taskId: foreignIssueId })}),
        (${companyId}, ${agentId}, 'succeeded', ${sql.json({ taskId: null })})
    `;

    await applyPendingMigrations(database.connectionString);
    const rows = await sql<{ issue_id: string | null; scope_kind: string }[]>`
      SELECT issue_id, scope_kind FROM heartbeat_runs WHERE company_id = ${companyId}`;
    expect(rows).toHaveLength(7);
    expect(rows.every(row => row.scope_kind === "issue" && row.issue_id === null)).toBe(true);
    // Re-running the migration preserves fail-closed tombstones and constraints.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await applyPendingMigrations(database.connectionString);
  }, 30_000);

  it("releases schema and completed-batch row locks and resumes after interruption", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-privacy-batch-commits-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const runId = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Batch commits', 'BCH')`;
    await sql`INSERT INTO agents (id, company_id, name, adapter_type) VALUES (${agentId}, ${companyId}, 'Runner', 'process')`;
    await sql`INSERT INTO issues (id, company_id, title, visibility) VALUES (${issueId}, ${companyId}, 'Private task', 'private')`;
    await sql`DROP TRIGGER heartbeat_runs_set_scope_kind ON heartbeat_runs`;
    await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, context_snapshot)
      SELECT ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
        ${companyId}::uuid, ${agentId}::uuid, 'succeeded', ${sql.json({ taskId: issueId })}::jsonb
      FROM generate_series(1, 1001) n`;
    // A failed concurrent build must be repaired rather than skipped by
    // CREATE INDEX IF NOT EXISTS when the migration is retried.
    await sql`DROP INDEX heartbeat_runs_company_issue_created_idx`;
    await expect(sql.unsafe("CREATE UNIQUE INDEX CONCURRENTLY heartbeat_runs_company_issue_created_idx ON heartbeat_runs (company_id)"))
      .rejects.toThrow();
    await sql.unsafe(`CREATE FUNCTION interrupt_privacy_batch_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(736319937);
        RAISE EXCEPTION 'fixture interrupted second batch';
      END $$`);
    await sql.unsafe(`CREATE TRIGGER zzz_interrupt_privacy_batch_fixture BEFORE UPDATE ON heartbeat_runs
      FOR EACH ROW WHEN (OLD.scope_kind = 'company' AND NEW.id = '${runId(1001)}'::uuid)
      EXECUTE FUNCTION interrupt_privacy_batch_fixture()`);
    const hash = await migrationHash();
    await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
    await sql`SELECT pg_advisory_lock(736319937)`;
    const migration = applyPendingMigrations(database.connectionString).then(() => null, error => error);
    let contender: Promise<unknown> | undefined;
    try {
      // The second batch is blocked while another session can see the first
      // committed batch and write a row whose lock has already been released.
      await expect.poll(async () => {
        const [row] = await sql`SELECT count(*)::int AS n FROM heartbeat_runs
          WHERE company_id = ${companyId} AND scope_kind = 'issue'`;
        return row.n;
      }, { timeout: 10_000 }).toBe(1000);
      // The session lock survives batch commits and blocks another migrator.
      contender = applyPendingMigrations(database.connectionString).then(() => null, error => error);
      await expect.poll(async () => {
        const [row] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND query LIKE '%SELECT pg_try_advisory_lock%'
            AND query NOT LIKE '%FROM pg_stat_activity%'
            AND strpos(query, 'paperclip:migrations') > 0`;
        return row.n;
      }, { timeout: 10_000 }).toBe(1);
      expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toHaveLength(0);
      await sql`SET lock_timeout = '500ms'`;
      await sql`UPDATE heartbeat_runs SET context_snapshot = context_snapshot || '{"probe":"visible"}'::jsonb
        WHERE id = ${runId(1)}`;
      expect(await sql`SELECT context_snapshot->>'probe' AS probe FROM heartbeat_runs WHERE id = ${runId(1)}`)
        .toEqual([{ probe: "visible" }]);
    } finally {
      await sql`SELECT pg_advisory_unlock(736319937)`;
      await sql`RESET lock_timeout`;
      await migration;
      await contender;
    }
    expect(await migration).toMatchObject({ message: "fixture interrupted second batch" });
    expect(await contender).toMatchObject({ message: "fixture interrupted second batch" });
    expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toHaveLength(0);
    await sql`DROP TRIGGER zzz_interrupt_privacy_batch_fixture ON heartbeat_runs`;
    await sql`DROP FUNCTION interrupt_privacy_batch_fixture()`;
    await Promise.all([applyPendingMigrations(database.connectionString), applyPendingMigrations(database.connectionString)]);
    const [finished] = await sql`SELECT count(*)::int AS n FROM heartbeat_runs
      WHERE company_id = ${companyId} AND scope_kind = 'issue' AND issue_id = ${issueId}`;
    expect(finished.n).toBe(1001);
    expect(await sql`SELECT indisvalid FROM pg_index WHERE indexrelid = 'heartbeat_runs_company_issue_created_idx'::regclass`)
      .toEqual([{ indisvalid: true }]);
    expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toHaveLength(1);
  }, 30_000);

  it("keeps all privacy triggers installed when replacement is interrupted", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-privacy-trigger-atomic-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
    const replacements = content.split("--> statement-breakpoint").filter(statement => /DROP TRIGGER IF EXISTS/.test(statement));
    expect(replacements).toHaveLength(4);
    for (const statement of replacements) {
      const name = statement.match(/DROP TRIGGER IF EXISTS ([A-Za-z_]+)/)![1];
      const interrupted = statement.replace("CREATE TRIGGER", "RAISE EXCEPTION 'fixture interrupted trigger replacement';\n  CREATE TRIGGER");
      await expect(sql.unsafe(interrupted)).rejects.toThrow("fixture interrupted trigger replacement");
      expect(await sql`SELECT tgname FROM pg_trigger WHERE tgname = ${name} AND NOT tgisinternal`).toEqual([{ tgname: name }]);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Atomic triggers', 'ATR')`;
    await sql`INSERT INTO agents (id, company_id, name, adapter_type) VALUES (${agentId}, ${companyId}, 'Runner', 'process')`;
    await sql`INSERT INTO issues (id, company_id, title, visibility) VALUES (${issueId}, ${companyId}, 'Private', 'private')`;
    expect(await sql`INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot)
      VALUES (${companyId}, ${agentId}, 'succeeded', ${sql.json({ taskId: issueId })}) RETURNING issue_id, scope_kind`)
      .toEqual([{ issue_id: issueId, scope_kind: "issue" }]);
  }, 30_000);

});
