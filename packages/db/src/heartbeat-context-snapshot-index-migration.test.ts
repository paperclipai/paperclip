import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

d("heartbeat context_snapshot expression index migration", () => {
  it("applies full migration chain and uses the new indexes", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap16575-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('heartbeat_runs','agent_wakeup_requests')`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    expect(names).toContain("heartbeat_runs_company_ctx_task_created_idx");
    expect(names).toContain("agent_wakeup_requests_company_payload_issue_idx");

    await sql.unsafe("SET enable_seqscan = off");
    const plan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot ->> 'issueId' = 'x' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("heartbeat_runs_company_ctx_issue_created_idx");

    const taskPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM heartbeat_runs WHERE company_id = '00000000-0000-0000-0000-000000000001' AND context_snapshot ->> 'taskId' = 'x' ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    const taskText = taskPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(taskText).toContain("heartbeat_runs_company_ctx_task_created_idx");

    const wakePlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM agent_wakeup_requests WHERE company_id = '00000000-0000-0000-0000-000000000001' AND status = 'deferred_issue_execution' AND payload ->> 'issueId' = 'x' LIMIT 1",
    );
    const wakeText = wakePlan.map((r) => Object.values(r)[0]).join("\n");
    expect(wakeText).toContain("agent_wakeup_requests_company_payload_issue_idx");

    // Idempotency: re-running the migration statements against an already
    // migrated database must be a no-op, not an error.
    const migrationSql = await readFile(
      fileURLToPath(new URL("./migrations/0209_heartbeat_context_snapshot_indexes.sql", import.meta.url)),
      "utf8",
    );
    const statements = migrationSql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  }, 240_000);
});
