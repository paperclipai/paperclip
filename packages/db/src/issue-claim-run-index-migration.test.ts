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

// The claim lookup (`company_id = $1 AND (checkout_run_id = $2 OR execution_run_id = $2)`)
// runs on every issue write made by an unanchored timer run. Both claim columns are null on
// all but a few dozen rows per company, so the two partial indexes together answer the OR
// instead of the planner reading the company's issues.
d("issue claim run index migration", () => {
  it("applies full migration chain and uses the new indexes", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("aut5543-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql`SELECT indexname FROM pg_indexes WHERE tablename = 'issues'`;
    const names = idx.map((r) => r.indexname as string);
    expect(names).toContain("issues_company_checkout_run_idx");
    expect(names).toContain("issues_company_execution_run_idx");

    // Company shape mirrors the live instance: thousands of issues, a handful of claims.
    const companyId = "00000000-0000-0000-0000-000000000001";
    const agentId = "00000000-0000-0000-0000-000000000002";
    const runId = "00000000-0000-0000-0000-000000000003";
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Claim lookup', 'CLM')`;
    await sql`INSERT INTO agents (id, company_id, name) VALUES (${agentId}, ${companyId}, 'Claiming agent')`;
    await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status)
      VALUES (${runId}, ${companyId}, ${agentId}, 'running')`;
    await sql.unsafe(
      `INSERT INTO issues (company_id, title, status)
       SELECT '${companyId}', 'bulk ' || n, 'backlog' FROM generate_series(1, 3000) n`,
    );
    await sql`INSERT INTO issues (company_id, title, status, checkout_run_id)
      VALUES (${companyId}, 'Checked out claim', 'in_progress', ${runId})`;
    await sql`INSERT INTO issues (company_id, title, status, execution_run_id)
      VALUES (${companyId}, 'Executing claim', 'in_progress', ${runId})`;
    // Without statistics the planner costs a heap fetch per estimated row and can prefer
    // issues_conversation_identity_idx, which matches every unclaimed row on a NULL triple.
    await sql.unsafe("ANALYZE issues");

    // The combined OR lookup is the whole point: the planner must BitmapOr both partial
    // indexes rather than fall back to reading the company's 3,002 issues. No
    // enable_seqscan override, so this fails if the indexes go missing or the predicates
    // stop matching the query.
    const claimQuery = `EXPLAIN (ANALYZE, BUFFERS)
      SELECT id FROM issues
      WHERE company_id = '${companyId}' AND (checkout_run_id = '${runId}' OR execution_run_id = '${runId}')`;
    const plan = await sql.unsafe(claimQuery);
    const planText = plan.map((r) => Object.values(r)[0]).join("\n");
    expect(planText).toContain("issues_company_checkout_run_idx");
    expect(planText).toContain("issues_company_execution_run_idx");
    expect(planText).not.toContain("Seq Scan");

    const claimed = await sql.unsafe(
      `SELECT id FROM issues
       WHERE company_id = '${companyId}' AND (checkout_run_id = '${runId}' OR execution_run_id = '${runId}')`,
    );
    expect(claimed).toHaveLength(2);

    // Partial predicates: an unclaimed company run must not fall back to a scan either.
    const missingPlan = await sql.unsafe(
      `EXPLAIN SELECT id FROM issues
       WHERE company_id = '${companyId}'
         AND (checkout_run_id = '00000000-0000-0000-0000-0000000000ff'
              OR execution_run_id = '00000000-0000-0000-0000-0000000000ff')`,
    );
    expect(missingPlan.map((r) => Object.values(r)[0]).join("\n")).not.toContain("Seq Scan");

    // Idempotency: re-running the migration statements against an already
    // migrated database must be a no-op, not an error.
    const migrationSql = await readFile(
      fileURLToPath(new URL("./migrations/0298_issue_claim_run_indexes.sql", import.meta.url)),
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
