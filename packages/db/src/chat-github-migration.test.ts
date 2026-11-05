import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("GitHub preview migration replay", () => {
  it("preserves existing relations and constraints when the renumbered migration runs again", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-github-migration-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const relations = () => sql`SELECT oid::text, relname FROM pg_class WHERE relname IN ('chat_github_configurations', 'chat_github_registrations', 'chat_github_reviews') ORDER BY relname`;
      const constraints = () => sql`SELECT oid::text, conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('chat_github_configurations'::regclass, 'chat_github_registrations'::regclass, 'chat_github_reviews'::regclass) ORDER BY conname`;
      const beforeRelations = await relations();
      const beforeConstraints = await constraints();
      expect(beforeRelations).toHaveLength(3);
      expect(beforeConstraints.some((row) => row.definition.includes("FOREIGN KEY (company_id, endpoint_id)"))).toBe(true);
      const migration = await readFile(new URL("./migrations/0283_jittery_psynapse.sql", import.meta.url), "utf8");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await sql.unsafe(statement);
        }
        expect(await relations()).toEqual(beforeRelations);
        expect(await constraints()).toEqual(beforeConstraints);
      }
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
