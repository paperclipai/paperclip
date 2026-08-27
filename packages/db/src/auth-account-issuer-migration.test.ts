import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import postgres from "postgres";
import { authAccounts } from "./schema/auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("Better Auth account schema", () => {
  it("maps the issuer field required by Better Auth", () => {
    expect(getTableColumns(authAccounts).issuer.name).toBe("issuer");
  });
});

describeEmbeddedPostgres("Better Auth account issuer migration", () => {
  it("backfills the local credential issuer before making the column required", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-auth-issuer-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`TRUNCATE TABLE "account", "user" CASCADE`;
    await sql`ALTER TABLE "account" DROP COLUMN "issuer"`;
    await sql`
      INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('user-1', 'Board', 'board@example.test', true, now(), now())
    `;
    await sql`
      INSERT INTO "account" (
        "id", "account_id", "provider_id", "user_id", "password", "created_at", "updated_at"
      ) VALUES (
        'account-1', 'user-1', 'credential', 'user-1', 'fixture-password-hash', now(), now()
      )
    `;

    const migrationSql = await readFile(
      new URL("./migrations/0228_gorgeous_slipstream.sql", import.meta.url),
      "utf8",
    );
    for (const statement of migrationSql
      .split("--> statement-breakpoint")
      .map((value) => value.trim())
      .filter(Boolean)) {
      await sql.unsafe(statement);
    }

    const accounts = await sql<{ issuer: string }[]>`
      SELECT "issuer" FROM "account" WHERE "id" = 'account-1'
    `;
    const columns = await sql<{ is_nullable: "YES" | "NO" }[]>`
      SELECT "is_nullable"
      FROM "information_schema"."columns"
      WHERE "table_schema" = 'public'
        AND "table_name" = 'account'
        AND "column_name" = 'issuer'
    `;

    expect(accounts).toEqual([{ issuer: "local:credential" }]);
    expect(columns).toEqual([{ is_nullable: "NO" }]);
  });
});
