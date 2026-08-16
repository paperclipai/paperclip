import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const FORWARD = "0218_unusual_the_hunter.sql";
const DOWN = "rollback/0218_unusual_the_hunter.sql";
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

async function readMigration(path: string) {
  return fs.promises.readFile(new URL(`./migrations/${path}`, import.meta.url), "utf8");
}

async function executeStatements(sql: postgres.Sql, text: string) {
  for (const statement of text.split("--> statement-breakpoint").flatMap((part) => part.split(";"))) {
    if (statement.trim()) await sql.unsafe(statement);
  }
}

async function columns(sql: postgres.Sql) {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'issue_execution_decisions'
  `;
  return rows.map((row) => row.column_name);
}

describeEmbeddedPostgres("issue execution review decision migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("applies forward, rolls back, and reapplies cleanly", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-review-decision-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());
    const forward = await readMigration(FORWARD);
    const down = await readMigration(DOWN);

    // The isolated database starts fully migrated. Rewind 0218, then exercise
    // the exact forward/down/reapply lifecycle against real embedded Postgres.
    await executeStatements(sql, down);
    expect(await columns(sql)).not.toEqual(expect.arrayContaining(["review_round_id", "idempotency_key", "payload_hash"]));

    await executeStatements(sql, forward);
    expect(await columns(sql)).toEqual(expect.arrayContaining(["review_round_id", "idempotency_key", "payload_hash"]));
    const firstIndexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
        AND indexname IN (
          'issue_execution_decisions_review_round_uq',
          'issue_execution_decisions_reviewer_run_idempotency_uq'
        )
    `;
    expect(firstIndexes).toHaveLength(2);

    await executeStatements(sql, down);
    expect(await columns(sql)).not.toEqual(expect.arrayContaining(["review_round_id", "idempotency_key", "payload_hash"]));
    await executeStatements(sql, forward);
    expect(await columns(sql)).toEqual(expect.arrayContaining(["review_round_id", "idempotency_key", "payload_hash"]));
  }, 30_000);
});

