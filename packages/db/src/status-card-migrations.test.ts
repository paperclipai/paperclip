import fs from "node:fs";
import { afterEach, describe, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILES = [
  "0185_status_cards.sql",
  "0186_status_card_compile_provenance.sql",
  "0187_status_card_pending_change_hash.sql",
  "0188_status_card_generation_issue_index.sql",
  "0189_status_card_agent.sql",
] as const;
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("status card migrations", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("can be reapplied after the schema already exists", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-status-card-migrations-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    for (const migrationFile of MIGRATION_FILES) {
      const migrationSql = await fs.promises.readFile(
        new URL(`./migrations/${migrationFile}`, import.meta.url),
        "utf8",
      );
      await sql.unsafe(migrationSql);
    }
  });
});
