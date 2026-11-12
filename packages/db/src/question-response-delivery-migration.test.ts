import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function migrationStatements(): Promise<string[]> {
  const migrationSql = await readFile(
    fileURLToPath(
      new URL("./migrations/0228_nasty_grim_reaper.sql", import.meta.url),
    ),
    "utf8",
  );
  return migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describeEmbeddedPostgres("question response delivery migration", () => {
  it("can be replayed against an already migrated database", async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "question-response-migration-",
    );
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, {
      max: 1,
      onnotice: () => {},
    });
    cleanups.push(async () => sql.end());

    const statements = await migrationStatements();
    expect(statements.length).toBeGreaterThan(0);

    for (const statement of statements) await sql.unsafe(statement);
    for (const statement of statements) await sql.unsafe(statement);

    const [table] = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'issue_question_response_deliveries'
    `;
    expect(table?.table_name).toBe("issue_question_response_deliveries");

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname
      FROM pg_indexes
      WHERE indexname IN (
        'issue_question_response_deliveries_interaction_uq',
        'issue_question_response_deliveries_correlation_uq',
        'issue_question_response_deliveries_pending_idx',
        'issue_question_response_deliveries_company_issue_idx',
        'agent_wakeup_requests_question_response_delivery_idempotency_uq'
      )
    `;
    expect(indexes.map((row) => row.indexname).sort()).toEqual(
      [
        "agent_wakeup_requests_question_response_delivery_idempotency_uq",
        "issue_question_response_deliveries_company_issue_idx",
        "issue_question_response_deliveries_correlation_uq",
        "issue_question_response_deliveries_interaction_uq",
        "issue_question_response_deliveries_pending_idx",
      ].sort(),
    );
  }, 240_000);
});
