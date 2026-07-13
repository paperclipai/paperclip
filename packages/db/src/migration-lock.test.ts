import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, ensurePostgresDatabase, inspectMigrations } from "./index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;

describeEmbedded("concurrent migration application", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterAll(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  it("N concurrent applyPendingMigrations calls race safely to an upToDate schema", async () => {
    const seed = await startEmbeddedPostgresTestDatabase("paperclip-migration-lock-");
    cleanups.push(seed.cleanup);
    // Fresh empty sibling DB on the same cluster (no migrations applied yet).
    const adminUrl = new URL(seed.connectionString);
    adminUrl.pathname = "/postgres";
    await ensurePostgresDatabase(adminUrl.toString(), "migration_race");
    const targetUrl = new URL(seed.connectionString);
    targetUrl.pathname = "/migration_race";
    const url = targetUrl.toString();

    const results = await Promise.allSettled([
      applyPendingMigrations(url),
      applyPendingMigrations(url),
      applyPendingMigrations(url),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const state = await inspectMigrations(url);
    expect(state.status).toBe("upToDate");

    // No duplicate journal entries.
    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql`SELECT hash, count(*) AS n FROM drizzle.__drizzle_migrations GROUP BY hash HAVING count(*) > 1`;
      expect(rows.length).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
