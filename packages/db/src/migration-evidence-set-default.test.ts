import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { reconcilePendingMigrationHistory } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

// 0001 is the earliest migration whose body contains an
// `ALTER COLUMN ... SET DEFAULT` statement, which the migration-evidence
// detector previously could not reason about.
const MIGRATION_FILE = "0001_fast_northstar.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("migration history reconcile: SET DEFAULT evidence", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it("records a migration whose only unrecognized statement is ALTER COLUMN SET DEFAULT", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-set-default-evidence-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // The schema is fully migrated. Drop only this migration's history row so
    // it looks pending while every statement in it is already applied.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    const defaultBefore = await sql<{ columnDefault: string | null }[]>`
      SELECT column_default AS "columnDefault"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'heartbeat_runs'
        AND column_name = 'invocation_source'
    `;
    expect(defaultBefore[0]?.columnDefault ?? "").toContain("on_demand");

    const result = await reconcilePendingMigrationHistory(database.connectionString);

    // Before the fix this returned an empty list: the SET DEFAULT statement was
    // unrecognized, so the migration was treated as unapplied and the reconcile
    // loop stopped, leaving every later migration unrecorded too.
    expect(result.repairedMigrations).toContain(MIGRATION_FILE);

    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    expect(Number(rows[0]?.count ?? 0)).toBe(1);
  }, 60_000);

  it("does not record a migration whose SET DEFAULT is absent from the schema", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-set-default-missing-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`ALTER TABLE "heartbeat_runs" ALTER COLUMN "invocation_source" DROP DEFAULT`;

    const result = await reconcilePendingMigrationHistory(database.connectionString);

    // The evidence is genuinely missing, so the migration must stay pending
    // rather than be silently marked as applied.
    expect(result.repairedMigrations).not.toContain(MIGRATION_FILE);
  }, 60_000);
});
