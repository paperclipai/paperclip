import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0182_connections_v3_schema_core.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

describeEmbeddedPostgres("connections v3 schema core migration", () => {
  afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

  it("backfills a workspace grant and rolls back without losing the connection", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-connections-v3-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`DROP TABLE IF EXISTS "connection_grants"`;
    await sql`DROP INDEX IF EXISTS "tool_connections_company_uid_uq"`;
    await sql`ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_company_id_uq"`;
    await sql`ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_ownership_check"`;
    await sql`ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_transport_check"`;
    await sql`ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_auth_kind_check"`;
    await sql`ALTER TABLE "tool_connections" DROP COLUMN IF EXISTS "uid"`;
    await sql`ALTER TABLE "tool_connections" DROP COLUMN IF EXISTS "ownership"`;
    await sql`ALTER TABLE "tool_connections" DROP COLUMN IF EXISTS "auth_kind"`;

    const companyId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const secretId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Paperclip', 'PAP')`;
    await sql`INSERT INTO "tool_applications" ("id", "company_id", "application_key", "name", "type") VALUES (${applicationId}, ${companyId}, 'linear', 'Linear', 'mcp_http')`;
    await sql`
      INSERT INTO "tool_connections" ("id", "company_id", "application_id", "name", "connection_kind", "transport", "config", "credential_secret_refs")
      VALUES (${connectionId}, ${companyId}, ${applicationId}, 'Production', 'managed', 'remote_http', '{"oauth":{"provider":"linear"}}'::jsonb, ${sql.json([{ secretId, configPath: "oauth.refresh_token" }])})
    `;

    await applyPendingMigrations(database.connectionString);

    const [connection] = await sql<{ uid: string; ownership: string; transport: string; auth_kind: string }[]>`
      SELECT "uid", "ownership", "transport", "auth_kind" FROM "tool_connections" WHERE "id" = ${connectionId}
    `;
    expect(connection).toMatchObject({ ownership: "customer", transport: "mcp_remote", auth_kind: "oauth" });
    expect(connection?.uid).toMatch(/^linear\/production-[0-9a-f]{8}$/);

    const [grant] = await sql<{ kind: string; is_default: boolean; credential_secret_refs: unknown[] }[]>`
      SELECT "kind", "is_default", "credential_secret_refs" FROM "connection_grants" WHERE "connection_id" = ${connectionId}
    `;
    expect(grant).toMatchObject({ kind: "workspace", is_default: true });
    expect(grant?.credential_secret_refs).toEqual([{ secretId, configPath: "oauth.refresh_token" }]);

    const otherCompanyId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${otherCompanyId}, 'Other', 'OTH')`;
    await expect(sql`
      INSERT INTO "connection_grants" ("company_id", "connection_id", "kind")
      VALUES (${otherCompanyId}, ${connectionId}, 'workspace')
    `).rejects.toMatchObject({ code: "23503" });
    await expect(sql`
      INSERT INTO "connection_grants" ("company_id", "connection_id", "kind", "subject_user_id", "is_default")
      VALUES (${companyId}, ${connectionId}, 'user', 'user-1', true)
    `).rejects.toMatchObject({ code: "23514" });

    await sql`DROP TABLE "connection_grants"`;
    await sql`DROP INDEX "tool_connections_company_uid_uq"`;
    await sql`ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_company_id_uq"`;
    await sql`ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_ownership_check"`;
    await sql`ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_transport_check"`;
    await sql`ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_auth_kind_check"`;
    await sql`UPDATE "tool_connections" SET "transport" = 'remote_http' WHERE "transport" = 'mcp_remote'`;
    await sql`ALTER TABLE "tool_connections" DROP COLUMN "uid"`;
    await sql`ALTER TABLE "tool_connections" DROP COLUMN "ownership"`;
    await sql`ALTER TABLE "tool_connections" DROP COLUMN "auth_kind"`;

    const [rolledBack] = await sql<{ id: string; transport: string }[]>`
      SELECT "id", "transport" FROM "tool_connections" WHERE "id" = ${connectionId}
    `;
    expect(rolledBack).toEqual({ id: connectionId, transport: "remote_http" });
  }, 30_000);
});
