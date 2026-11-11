import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { authAccounts } from "./schema/auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0230_better_auth_account_issuer.sql";
const UNIQUE_INDEX = "account_issuer_account_id_uq";

const CREDENTIAL_ISSUER = "local:credential";
const OAUTH_ISSUER_PREFIX = "local:oauth:";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function applySqlMigration(sql: postgres.Sql, file: string) {
  const content = await fs.promises.readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
  await sql.begin(async (transaction) => {
    for (const statement of content.split("--> statement-breakpoint")) {
      if (statement.trim()) await transaction.unsafe(statement);
    }
  });
}

describe("account issuer schema", () => {
  it("keeps issuer nullable and identifies accounts by provider and account ID", () => {
    const config = getTableConfig(authAccounts);
    const issuer = config.columns.find((column) => column.name === "issuer");
    expect(issuer).toBeDefined();
    expect(issuer?.notNull).toBe(false);

    const unique = config.indexes.find((index) => index.config.name === "account_provider_account_id_uq");
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      "provider_id",
      "account_id",
    ]);
  });
});

describeEmbeddedPostgres("historical issuer migration and patched provider identity upgrade", () => {
  // Reverse registration order, one at a time. The raw `postgres` client is not
  // registered with the module's client registry, so the cluster teardown does
  // not close it. Stopping the cluster while that client is still draining kills
  // the backend socket under a queued write and can crash the runner.
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it("backfills every pre-upgrade row before the column goes NOT NULL", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-account-issuer-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DROP INDEX IF EXISTS "account_provider_account_id_uq"`;
    await sql`DROP INDEX IF EXISTS ${sql(UNIQUE_INDEX)}`;
    await sql`ALTER TABLE "account" DROP COLUMN IF EXISTS "issuer"`;

    const credentialUserId = `user-${randomUUID()}`;
    const socialUserId = `user-${randomUUID()}`;
    const credentialAccountId = `account-${randomUUID()}`;
    const githubAccountId = `account-${randomUUID()}`;
    const googleAccountId = `account-${randomUUID()}`;

    await sql`
      INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at")
      VALUES
        (${credentialUserId}, 'Credential User', 'credential@example.com', now(), now()),
        (${socialUserId}, 'Social User', 'social@example.com', now(), now())
    `;
    await sql`
      INSERT INTO "account"
        ("id", "account_id", "provider_id", "user_id", "password", "created_at", "updated_at")
      VALUES
        (${credentialAccountId}, ${credentialUserId}, 'credential', ${credentialUserId}, 'hashed', now(), now()),
        (${githubAccountId}, 'github-subject-1', 'github', ${socialUserId}, NULL, now(), now()),
        (${googleAccountId}, 'google-subject-1', 'google', ${socialUserId}, NULL, now(), now())
    `;

    await applySqlMigration(sql, MIGRATION_FILE);

    const rows = await sql<{ id: string; issuer: string }[]>`
      SELECT "id", "issuer" FROM "account" ORDER BY "id"
    `;
    const issuerById = new Map(rows.map((row) => [row.id, row.issuer]));
    expect(issuerById.get(credentialAccountId)).toBe(CREDENTIAL_ISSUER);
    // A backfill restricted to `provider_id = 'credential'` leaves these NULL,
    // and SET NOT NULL then aborts the upgrade.
    expect(issuerById.get(githubAccountId)).toBe(`${OAUTH_ISSUER_PREFIX}github`);
    expect(issuerById.get(googleAccountId)).toBe(`${OAUTH_ISSUER_PREFIX}google`);

    const [issuerColumn] = await sql<{ is_nullable: string }[]>`
      SELECT "is_nullable" FROM "information_schema"."columns"
      WHERE "table_name" = 'account' AND "column_name" = 'issuer'
    `;
    expect(issuerColumn?.is_nullable).toBe("NO");

    const indexes = await sql<{ indexname: string }[]>`
      SELECT "indexname" FROM "pg_indexes"
      WHERE "tablename" = 'account' AND "indexname" = ${UNIQUE_INDEX}
    `;
    expect(indexes).toHaveLength(1);

    // The restored index rejects a second account under the same key.
    await expect(
      sql`
        INSERT INTO "account"
          ("id", "issuer", "account_id", "provider_id", "user_id", "created_at", "updated_at")
        VALUES (${`account-${randomUUID()}`}, ${CREDENTIAL_ISSUER}, ${credentialUserId}, 'credential', ${credentialUserId}, now(), now())
      `,
    ).rejects.toMatchObject({ code: "23505", constraint_name: UNIQUE_INDEX });

    await applySqlMigration(sql, "0465_better_auth_account_identity.sql");
    const preserved = await sql`SELECT "id", "issuer" FROM "account" ORDER BY "id"`;
    expect(preserved).toEqual(rows);
    const [nullable] = await sql`
      SELECT "is_nullable" FROM "information_schema"."columns"
      WHERE "table_schema" = 'public' AND "table_name" = 'account' AND "column_name" = 'issuer'
    `;
    expect(nullable?.is_nullable).toBe("YES");
    await expect(sql`
      INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "created_at", "updated_at")
      VALUES (${randomUUID()}, ${credentialUserId}, 'credential', ${credentialUserId}, now(), now())
    `).rejects.toMatchObject({ code: "23505", constraint_name: "account_provider_account_id_uq" });
    await sql`
      INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "created_at", "updated_at")
      VALUES (${randomUUID()}, 'new-subject', 'credential', ${credentialUserId}, now(), now())
    `;
  }, 30_000);
});

describeEmbeddedPostgres("provider identity migration with duplicate legacy keys", () => {
  it("rejects ambiguous provider/account keys without changing legacy rows", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-account-duplicates-");
    const sql = postgres(database.connectionString, { max: 1 });
    try {
      await sql`DROP INDEX "account_provider_account_id_uq"`;
      await sql`ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL`;
      await sql`CREATE UNIQUE INDEX "account_issuer_account_id_uq" ON "account" ("issuer", "account_id")`;
      const userId = randomUUID();
      await sql`INSERT INTO "user" ("id", "name", "email", "created_at", "updated_at")
        VALUES (${userId}, 'Legacy User', 'legacy@example.com', now(), now())`;
      await sql`INSERT INTO "account" ("id", "issuer", "account_id", "provider_id", "user_id", "created_at", "updated_at")
        VALUES (${randomUUID()}, 'issuer-a', 'same-subject', 'credential', ${userId}, now(), now()),
               (${randomUUID()}, 'issuer-b', 'same-subject', 'credential', ${userId}, now(), now())`;
      const before = await sql`SELECT "id", "issuer" FROM "account" ORDER BY "id"`;
      await expect(applySqlMigration(sql, "0465_better_auth_account_identity.sql"))
        .rejects.toMatchObject({ code: "23505" });
      expect(await sql`SELECT "id", "issuer" FROM "account" ORDER BY "id"`).toEqual(before);
      const [column] = await sql`SELECT "is_nullable" FROM "information_schema"."columns"
        WHERE "table_schema" = 'public' AND "table_name" = 'account' AND "column_name" = 'issuer'`;
      expect(column?.is_nullable).toBe("NO");
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 30_000);
});
