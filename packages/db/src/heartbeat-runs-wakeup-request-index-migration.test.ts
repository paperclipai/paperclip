import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const indexName = "heartbeat_runs_wakeup_request_id_idx";
const migrationFile = "0451_heartbeat_runs_wakeup_request_index.sql";

(support.supported ? describe : describe.skip)("heartbeat runs wakeup request index migration", () => {
  it("builds a valid index concurrently and replays over an index that already exists", async () => {
    const database = await startEmbeddedPostgresTestDatabase("heartbeat-wakeup-index-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      // A concurrent build cannot run inside the migration transaction, so this
      // row also proves the migration runs through the top-level statement path.
      const [built] = await sql`SELECT indisvalid, indisunique, pg_get_indexdef(indexrelid) definition
        FROM pg_index WHERE indexrelid=${indexName}::regclass`;
      expect(built!.indisvalid).toBe(true);
      expect(built!.indisunique).toBe(false);
      expect(built!.definition).toContain("heartbeat_runs");
      expect(built!.definition).toContain("wakeup_request_id");

      // Operators work around the missing index by creating it by hand. A
      // replay over that index must still record exactly one history receipt.
      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      await applyPendingMigrations(database.connectionString);
      const [history] = await sql`SELECT count(*)::int count FROM drizzle.__drizzle_migrations WHERE hash=${hash}`;
      expect(history!.count).toBe(1);

      const [kept] = await sql`SELECT indisvalid FROM pg_index WHERE indexrelid=${indexName}::regclass`;
      expect(kept!.indisvalid).toBe(true);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 120_000);
});
