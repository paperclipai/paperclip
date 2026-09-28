import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("X chat migration", () => {
  it("repairs a clone without provider checks and safely reapplies the publication constraints", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-x-migration-");
    const sql = postgres(database.connectionString, { onnotice: () => {} });
    try {
      await sql.unsafe('ALTER TABLE chat_endpoints DROP CONSTRAINT chat_endpoints_provider_check');
      await sql.unsafe('ALTER TABLE chat_external_principals DROP CONSTRAINT chat_external_principals_provider_check');
      const migration = await readFile(new URL("./migrations/0285_ancient_rumiko_fujikawa.sql", import.meta.url), "utf8");
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const statement of migration.split("--> statement-breakpoint")) await sql.unsafe(statement);
      }
      const constraints = await sql`
        SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname IN ('chat_endpoints_provider_check', 'chat_external_principals_provider_check', 'chat_endpoints_x_policy_check')
      `;
      expect(constraints).toHaveLength(3);
      for (const constraint of constraints) expect(constraint.definition).toContain("'x'");
      expect(constraints.find(row => row.conname === "chat_endpoints_x_policy_check")?.definition).toContain("'explicit'");
      const [index] = await sql`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'chat_publications_x_interaction_uq'
      `;
      expect(index.indexdef).toContain("CREATE UNIQUE INDEX");
      expect(index.indexdef).toContain("replyToPostId");
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
