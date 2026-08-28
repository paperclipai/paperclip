/**
 * The `account.issuer` backfill has to be total. The column lands NOT NULL, so
 * a row the UPDATE misses aborts the whole migration and leaves an upgraded
 * install with no working auth at all. This suite rewinds the migration,
 * seeds the pre-upgrade rows an existing deployment would have, and re-applies
 * it — a backfill narrowed to one provider fails here.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { authAccounts } from "./schema/auth.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0230_better_auth_account_issuer.sql";
const UNIQUE_INDEX = "account_issuer_account_id_uq";

// Better Auth's own issuer helpers: `createLocalAccountIssuer("credential")`
// for email/password and `createOAuthAccountIssuer(providerId)` for a social
// provider that declares no issuer of its own. Sign-in looks the credential
// account up by this exact value.
const CREDENTIAL_ISSUER = "local:credential";
const OAUTH_ISSUER_PREFIX = "local:oauth:";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

describe("account issuer schema", () => {
  it("declares the column Better Auth requires and the key it indexes on", () => {
    const config = getTableConfig(authAccounts);
    const issuer = config.columns.find((column) => column.name === "issuer");
    expect(issuer).toBeDefined();
    expect(issuer?.notNull).toBe(true);

    // Better Auth declares `(issuer, accountId)` unique on the account model
    // and resolves accounts by that pair.
    const unique = config.indexes.find((index) => index.config.name === UNIQUE_INDEX);
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      "issuer",
      "account_id",
    ]);
  });
});

describeEmbeddedPostgres("account issuer migration", () => {
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

    // Rewind to the pre-upgrade shape: no issuer column, no unique index.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
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

    await applyPendingMigrations(database.connectionString);

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
  }, 30_000);
});
