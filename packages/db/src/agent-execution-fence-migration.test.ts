import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const BASE_MIGRATION_FILE = "0224_agent_execution_fence.sql";
const FORWARD_MIGRATION_FILE = "0225_agent_execution_fence_hardening.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash(file: string) {
  const content = await fs.readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("agent execution fence migration", () => {
  it("locks heartbeat admissions before checking the zero-execution cutover precondition", async () => {
    const sql = await fs.readFile(new URL(`./migrations/${FORWARD_MIGRATION_FILE}`, import.meta.url), "utf8");
    const lockIndex = sql.indexOf('LOCK TABLE "heartbeat_runs" IN ACCESS EXCLUSIVE MODE');
    const finalizationColumnIndex = sql.indexOf('ADD COLUMN IF NOT EXISTS "execution_finalization_required"');
    const preconditionBlockIndex = sql.indexOf("DO $$");
    const preconditionIndex = sql.indexOf("Agent execution fence migration requires zero admitted executions");
    const pendingFinalizerIndex = sql.indexOf('"execution_finalized_at" is null');

    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(finalizationColumnIndex).toBeGreaterThan(lockIndex);
    expect(preconditionBlockIndex).toBeGreaterThan(finalizationColumnIndex);
    expect(pendingFinalizerIndex).toBeGreaterThan(preconditionBlockIndex);
    expect(preconditionIndex).toBeGreaterThan(pendingFinalizerIndex);
  });

  it("preserves the already-published 0224 migration and applies hardening through 0225", async () => {
    const base = await fs.readFile(new URL(`./migrations/${BASE_MIGRATION_FILE}`, import.meta.url), "utf8");
    const forward = await fs.readFile(new URL(`./migrations/${FORWARD_MIGRATION_FILE}`, import.meta.url), "utf8");

    expect(base).not.toContain("execution_finalization_required");
    expect(base).not.toContain("process_ownership_released_at");
    expect(forward).toContain('ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "execution_finalization_required"');
    expect(forward).toContain('ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_ownership_released_at"');
  });

  it("scopes leftover process metadata to non-terminal heartbeat runs", async () => {
    const sql = await fs.readFile(new URL(`./migrations/${FORWARD_MIGRATION_FILE}`, import.meta.url), "utf8");
    const preconditionBlock = sql.slice(sql.indexOf("DO $$"), sql.indexOf("END;\n$$;"));

    expect(preconditionBlock).not.toMatch(/OR "process_pid" is not null\s*$/m);
    expect(preconditionBlock).not.toMatch(/OR "process_group_id" is not null\s*$/m);
    expect(preconditionBlock).toContain(
      `"status" NOT IN ('succeeded', 'interrupted', 'failed', 'cancelled', 'timed_out')`,
    );
    expect(preconditionBlock).toContain(
      `AND ("process_pid" is not null OR "process_group_id" is not null)`,
    );
  });
});

describeEmbeddedPostgres("agent execution fence forward migration", () => {
  it("upgrades an existing 0224 database without relabeling legacy runs as finalized", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-fence-forward-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(FORWARD_MIGRATION_FILE)}`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_finalization_requirement_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_finalized_process_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_fence_guard" ON "heartbeat_runs"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "execution_finalization_required"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "process_ownership_released_at"`;
    await sql`
      CREATE TRIGGER "heartbeat_runs_execution_fence_guard"
      BEFORE INSERT OR UPDATE OF "agent_id", "status", "context_snapshot", "execution_finalizer_completed_at", "execution_finalized_at"
      ON "heartbeat_runs"
      FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_heartbeat_execution_fence"()
    `;

    const companyId = randomUUID();
    const agentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const legacyRunId = randomUUID();
    const resourceOwningRunId = randomUUID();
    const unstartedResourceRunId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Fence Migration', 'FNC')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "status")
      VALUES (${agentId}, ${companyId}, 'Legacy Executor', 'idle')
    `;
    await sql`
      INSERT INTO "agent_wakeup_requests" (
        "id", "company_id", "agent_id", "source", "status", "finished_at"
      ) VALUES (
        ${wakeupRequestId}, ${companyId}, ${agentId}, 'on_demand', 'completed', now()
      )
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "started_at", "finished_at", "wakeup_request_id"
      ) VALUES (
        ${legacyRunId}, ${companyId}, ${agentId}, 'succeeded', now() - interval '1 minute', now(), ${wakeupRequestId}
      )
    `;

    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "started_at", "finished_at", "process_pid"
      ) VALUES (
        ${resourceOwningRunId}, ${companyId}, ${agentId}, 'failed', now() - interval '1 minute', now(), 424242
      )
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "process_pid"
      ) VALUES (
        ${unstartedResourceRunId}, ${companyId}, ${agentId}, 'failed', 424243
      )
    `;

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();

    const [legacy] = await sql<{
      execution_finalization_required: boolean;
      execution_finalizer_completed_at: Date | null;
      execution_finalized_at: Date | null;
    }[]>`
      SELECT
        "execution_finalization_required",
        "execution_finalizer_completed_at",
        "execution_finalized_at"
      FROM "heartbeat_runs"
      WHERE "id" = ${legacyRunId}
    `;
    expect(legacy).toEqual({
      execution_finalization_required: false,
      execution_finalizer_completed_at: null,
      execution_finalized_at: null,
    });

    await expect(sql`
      UPDATE "heartbeat_runs"
      SET "process_pid" = 424244
      WHERE "id" = ${legacyRunId}
    `).rejects.toThrow(/already exempt from finalization tracking/i);

    await expect(sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier", "execution_run_id")
      VALUES (${randomUUID()}, ${companyId}, 'Legacy attachment', 'FNC-LEGACY', ${legacyRunId})
    `).rejects.toThrow(/already exempt from finalization tracking/i);

    const environmentId = randomUUID();
    await sql`
      INSERT INTO "environments" ("id", "name", "driver")
      VALUES (${environmentId}, ${`Legacy Fence ${environmentId}`}, 'sandbox')
    `;
    await expect(sql`
      INSERT INTO "environment_leases" ("id", "company_id", "environment_id", "heartbeat_run_id", "status")
      VALUES (${randomUUID()}, ${companyId}, ${environmentId}, ${legacyRunId}, 'active')
    `).rejects.toThrow(/already exempt from finalization tracking/i);

    await expect(sql`
      INSERT INTO "workspace_runtime_services" (
        "id", "company_id", "scope_type", "service_name", "status", "lifecycle", "provider", "started_by_run_id"
      ) VALUES (
        ${randomUUID()}, ${companyId}, 'run', 'legacy-service', 'running', 'ephemeral', 'local', ${legacyRunId}
      )
    `).rejects.toThrow(/already exempt from finalization tracking/i);

    const newRunId = randomUUID();
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "execution_finalization_required"
      ) VALUES (
        ${newRunId}, ${companyId}, ${agentId}, 'queued', false
      )
    `;
    const [postCutover] = await sql<{ execution_finalization_required: boolean }[]>`
      SELECT "execution_finalization_required"
      FROM "heartbeat_runs"
      WHERE "id" = ${newRunId}
    `;
    expect(postCutover?.execution_finalization_required).toBe(true);
  }, 30_000);

  it("upgrades an existing 0224 database whose only run is succeeded with process_pid residue", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-fence-forward-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(FORWARD_MIGRATION_FILE)}`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_finalization_requirement_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_finalized_process_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_fence_guard" ON "heartbeat_runs"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "execution_finalization_required"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "process_ownership_released_at"`;
    await sql`
      CREATE TRIGGER "heartbeat_runs_execution_fence_guard"
      BEFORE INSERT OR UPDATE OF "agent_id", "status", "context_snapshot", "execution_finalizer_completed_at", "execution_finalized_at"
      ON "heartbeat_runs"
      FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_heartbeat_execution_fence"()
    `;

    const companyId = randomUUID();
    const agentId = randomUUID();
    const succeededRunId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Fence Migration', 'FNC')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "status")
      VALUES (${agentId}, ${companyId}, 'Legacy Executor', 'idle')
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "started_at", "finished_at", "process_pid"
      ) VALUES (
        ${succeededRunId}, ${companyId}, ${agentId}, 'succeeded', now() - interval '1 minute', now(), 424242
      )
    `;

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
  }, 30_000);

  it("upgrades an existing 0224 database whose only run is succeeded with process_group_id residue", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-fence-forward-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(FORWARD_MIGRATION_FILE)}`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_finalization_requirement_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_finalized_process_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_fence_guard" ON "heartbeat_runs"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "execution_finalization_required"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "process_ownership_released_at"`;
    await sql`
      CREATE TRIGGER "heartbeat_runs_execution_fence_guard"
      BEFORE INSERT OR UPDATE OF "agent_id", "status", "context_snapshot", "execution_finalizer_completed_at", "execution_finalized_at"
      ON "heartbeat_runs"
      FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_heartbeat_execution_fence"()
    `;

    const companyId = randomUUID();
    const agentId = randomUUID();
    const succeededRunId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Fence Migration', 'FNC')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "status")
      VALUES (${agentId}, ${companyId}, 'Legacy Executor', 'idle')
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "started_at", "finished_at", "process_group_id"
      ) VALUES (
        ${succeededRunId}, ${companyId}, ${agentId}, 'succeeded', now() - interval '1 minute', now(), 424242
      )
    `;

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
  }, 30_000);

  it("upgrades an existing 0224 database whose only run is interrupted with both process identifiers", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-fence-forward-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(FORWARD_MIGRATION_FILE)}`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_finalization_requirement_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_finalized_process_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_fence_guard" ON "heartbeat_runs"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "execution_finalization_required"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "process_ownership_released_at"`;
    await sql`
      CREATE TRIGGER "heartbeat_runs_execution_fence_guard"
      BEFORE INSERT OR UPDATE OF "agent_id", "status", "context_snapshot", "execution_finalizer_completed_at", "execution_finalized_at"
      ON "heartbeat_runs"
      FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_heartbeat_execution_fence"()
    `;

    const companyId = randomUUID();
    const agentId = randomUUID();
    const interruptedRunId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Fence Migration', 'FNC')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "status")
      VALUES (${agentId}, ${companyId}, 'Legacy Executor', 'idle')
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "started_at", "finished_at", "process_pid", "process_group_id"
      ) VALUES (
        ${interruptedRunId}, ${companyId}, ${agentId}, 'interrupted', now() - interval '1 minute', now(), 424242, 424243
      )
    `;

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
  }, 30_000);

  it("still aborts 0225 when a running run carries process_pid", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-execution-fence-forward-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash(FORWARD_MIGRATION_FILE)}`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_finalization_requirement_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_finalized_process_guard" ON "heartbeat_runs"`;
    await sql`DROP TRIGGER IF EXISTS "heartbeat_runs_execution_fence_guard" ON "heartbeat_runs"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "execution_finalization_required"`;
    await sql`ALTER TABLE "heartbeat_runs" DROP COLUMN "process_ownership_released_at"`;
    await sql`
      CREATE TRIGGER "heartbeat_runs_execution_fence_guard"
      BEFORE INSERT OR UPDATE OF "agent_id", "status", "context_snapshot", "execution_finalizer_completed_at", "execution_finalized_at"
      ON "heartbeat_runs"
      FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_heartbeat_execution_fence"()
    `;

    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningRunId = randomUUID();
    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Fence Migration', 'FNC')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "status")
      VALUES (${agentId}, ${companyId}, 'Legacy Executor', 'idle')
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "started_at", "process_pid"
      ) VALUES (
        ${runningRunId}, ${companyId}, ${agentId}, 'running', now() - interval '1 minute', 424242
      )
    `;

    await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow(
      /requires zero admitted executions/i,
    );
  }, 30_000);
});
