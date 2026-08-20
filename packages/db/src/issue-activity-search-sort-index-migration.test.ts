import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0226_issue_activity_search_sort_idx.sql";
const INDEX_NAME = "activity_log_issue_entity_sort_idx";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue activity search index migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue activity search sort index migration", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  async function createMigratedDatabase() {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-issue-activity-search-index-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    return { database, sql };
  }

  async function makeMigrationPending(sql: ReturnType<typeof postgres>): Promise<void> {
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
  }

  it("replays when the exact index definition already exists", async () => {
    const { database, sql } = await createMigratedDatabase();
    await makeMigrationPending(sql);

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
    await expect(inspectMigrations(database.connectionString)).resolves.toMatchObject({ status: "upToDate" });
  }, 30_000);

  it("rejects a divergent index that reuses the migration index name", async () => {
    const { database, sql } = await createMigratedDatabase();
    await sql.unsafe(`DROP INDEX "${INDEX_NAME}"`);
    await sql.unsafe(`CREATE INDEX "${INDEX_NAME}" ON "activity_log" ("company_id")`);
    await makeMigrationPending(sql);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow(
      "activity_log_issue_entity_sort_idx exists with an incompatible definition",
    );
  }, 30_000);
});
