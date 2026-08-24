import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0227_interaction_idempotency_pending_only.sql";
const INDEX_NAME = "issue_thread_interactions_company_issue_idempotency_uq";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("interaction idempotency pending-only migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  // Starting the server and replaying migrations against it does not fit
  // vitest's 5s default, same as every other embedded-Postgres migration test
  // in this package.
  it("scopes the idempotency index to pending rows and can be reapplied", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-interaction-idempotency-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    const migrationSql = await fs.promises.readFile(
      new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
      "utf8",
    );

    // Replaying on top of the already-migrated schema must be a no-op, not a
    // duplicate-index error.
    await sql.unsafe(migrationSql);

    const [index] = await sql<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'issue_thread_interactions' AND indexname = ${INDEX_NAME}
    `;
    expect(index?.indexdef).toContain("UNIQUE");
    expect(index?.indexdef).toContain("status = 'pending'");
  }, 30_000);
});
