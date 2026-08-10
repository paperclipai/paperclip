import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0212_issue_result_comment_grace_flags.sql";
const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

async function migrationHash(): Promise<string> {
  const sql = await readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

d("issue result comment grace flags migration", () => {
  it("applies after a database already recorded through migration 0211", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-result-comment-grace-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql.unsafe('DROP TABLE "issue_result_comment_grace_flags"');

    await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();

    const [result] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.issue_result_comment_grace_flags') IS NOT NULL AS "exists"
    `;
    expect(result?.exists).toBe(true);
  }, 240_000);
});
