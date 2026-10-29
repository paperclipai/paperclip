import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("workspace preferences migration", () => {
  it("defaults off and preserves existing preferences when the renumbered migration replays", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-workspace-preferences-replay-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const userId = randomUUID();
      const [original] = await sql`
        INSERT INTO user_workspace_preferences (user_id) VALUES (${userId}) RETURNING *
      `;
      expect(original.coordinator_workspace_enabled).toBe(false);
      await sql`UPDATE user_workspace_preferences SET coordinator_workspace_enabled = true WHERE user_id = ${userId}`;
      const [before] = await sql`SELECT * FROM user_workspace_preferences WHERE user_id = ${userId}`;

      // An isolated build may already have applied this table under an older
      // migration number before master claimed that number for another table.
      const migrations = new URL("./migrations/", import.meta.url);
      const files = (await readdir(migrations)).filter(file => file.endsWith(".sql"));
      const statements = await Promise.all(files.map(file => readFile(new URL(file, migrations), "utf8")));
      const migration = statements.find(source => /CREATE TABLE(?: IF NOT EXISTS)? "user_workspace_preferences"/.test(source));
      expect(migration, "workspace preferences table migration is present").toBeDefined();
      for (const statement of migration!.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) {
        await sql.unsafe(statement);
      }

      const [after] = await sql`SELECT * FROM user_workspace_preferences WHERE user_id = ${userId}`;
      expect(after).toEqual(before);
      await expect(sql`INSERT INTO user_workspace_preferences (user_id) VALUES (${userId})`)
        .rejects.toMatchObject({ code: "23505", constraint_name: "user_workspace_preferences_user_uq" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
