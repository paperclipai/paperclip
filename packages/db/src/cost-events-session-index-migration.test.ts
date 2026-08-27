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

d("cost_events issue and session token index migration", () => {
  it("applies full migration chain and uses the new indexes", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("pap16575-r3-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename IN ('cost_events','session')`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("cost_events_company_issue_idx");
    expect(names).toContain("session_token_uq");

    await sql.unsafe("SET enable_seqscan = off");

    // The productivity-review sweep sums cost per candidate issue on every
    // 30s tick. Without this index each sum reads every cost event the
    // company ever recorded.
    const costPlan = await sql.unsafe(
      "EXPLAIN SELECT coalesce(sum(cost_cents), 0)::int FROM cost_events WHERE company_id = '00000000-0000-0000-0000-000000000001' AND issue_id = '00000000-0000-0000-0000-000000000002'",
    );
    const costText = costPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(costText).toContain("cost_events_company_issue_idx");

    // Session auth resolves the bearer token on every request; the lookup
    // must be an index scan, and tokens must be unique.
    const sessionPlan = await sql.unsafe(
      "EXPLAIN SELECT id FROM session WHERE token = 'x'",
    );
    const sessionText = sessionPlan.map((r) => Object.values(r)[0]).join("\n");
    expect(sessionText).toContain("session_token_uq");

    // Idempotency: re-running the migration statements against an already
    // migrated database must be a no-op, not an error.
    const migrationSql = await readFile(
      fileURLToPath(new URL("./migrations/0228_cost_events_issue_session_token_indexes.sql", import.meta.url)),
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
