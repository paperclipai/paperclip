import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0207_moaning_amazoness.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company secret proposals migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company secret proposals migration", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  // Starting an embedded Postgres and replaying a migration against it does not
  // fit vitest's 5s default: the neighbouring replay suites measure 7-12s on
  // CI. Every other embedded-Postgres migration test in this package carries an
  // explicit timeout for that reason; this one did not, so it failed on any
  // runner that was not unusually fast.
  it("can be reapplied after its migration journal entry is removed", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-secret-proposals-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();

    const [result] = await sql<{ constraints: number; indexes: number }[]>`
      SELECT
        (SELECT count(*)::int FROM pg_constraint WHERE conrelid = 'company_secret_proposals'::regclass AND contype <> 'n') AS constraints,
        (SELECT count(*)::int FROM pg_indexes WHERE tablename = 'company_secret_proposals') AS indexes
    `;
    expect(result).toEqual({ constraints: 13, indexes: 5 });
  }, 30_000);
});
