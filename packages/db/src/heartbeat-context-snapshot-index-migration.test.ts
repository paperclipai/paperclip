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
  it("applies full migration chain and creates the expression indexes", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap16575-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('heartbeat_runs','agent_wakeup_requests')`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    expect(names).toContain("heartbeat_runs_company_ctx_task_created_idx");
    expect(names).toContain("heartbeat_runs_company_ctx_taskkey_created_idx");
    expect(names).toContain("agent_wakeup_requests_company_payload_issue_idx");
    const definitions = new Map(idx.map((row) => [row.indexname as string, row.indexdef as string]));
    expect(definitions.get("heartbeat_runs_company_ctx_issue_created_idx")).toMatch(/context_snapshot.*issueId/);
    expect(definitions.get("heartbeat_runs_company_ctx_task_created_idx")).toMatch(/context_snapshot.*taskId/);
    expect(definitions.get("heartbeat_runs_company_ctx_taskkey_created_idx")).toMatch(/context_snapshot.*taskKey/);
    expect(definitions.get("agent_wakeup_requests_company_payload_issue_idx")).toMatch(/payload.*issueId/);

    // Planner selection on an empty schema is deliberately not asserted: a
    // later covering index can be cheaper for the ORDER BY and PostgreSQL may
    // filter a broader index rather than pick an expression index. The index
    // definitions above are the deterministic migration contract.

    // Idempotency: re-running the migration statements against an already
    // migrated database must be a no-op, not an error.
    for (const migration of [
      "./migrations/0209_heartbeat_context_snapshot_indexes.sql",
      "./migrations/0210_heartbeat_context_taskkey_index.sql",
    ]) {
      const migrationSql = await readFile(
        fileURLToPath(new URL(migration, import.meta.url)),
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
    }
  }, 240_000);
});
