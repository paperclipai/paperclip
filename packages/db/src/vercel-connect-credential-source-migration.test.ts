import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0233_living_dreaming_celestial.sql";
const migrationSql = fs.readFileSync(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("Vercel Connect credential-source migration", () => {
  it("defaults legacy rows to the vault and rejects mixed credential custody", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-vercel-connect-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash}`;
    await sql`ALTER TABLE "connection_grants" DROP COLUMN "external_credential"`;
    await sql`ALTER TABLE "tool_connections" DROP COLUMN "external_credential"`;
    await sql`ALTER TABLE "tool_connections" DROP COLUMN "credential_source"`;

    const companyId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Vercel migration', 'VCM')`;
    await sql`INSERT INTO "tool_applications" ("id", "company_id", "name", "type") VALUES (${applicationId}, ${companyId}, 'PostHog', 'mcp_http')`;
    await sql`
      INSERT INTO "tool_connections" ("id", "company_id", "application_id", "name", "uid", "transport")
      VALUES (${connectionId}, ${companyId}, ${applicationId}, 'PostHog', ${`posthog/${connectionId}`}, 'mcp_remote')
    `;

    await applyPendingMigrations(database.connectionString);

    const [legacy] = await sql<{ credential_source: string; external_credential: unknown }[]>`
      SELECT "credential_source", "external_credential" FROM "tool_connections" WHERE "id" = ${connectionId}
    `;
    expect(legacy).toEqual({ credential_source: "paperclip_vault", external_credential: null });

    await expect(sql`
      UPDATE "tool_connections" SET "credential_source" = 'vercel_connect' WHERE "id" = ${connectionId}
    `).rejects.toMatchObject({ code: "23514" });

    await sql`
      UPDATE "tool_connections" SET
        "credential_source" = 'vercel_connect',
        "external_credential" = ${sql.json({ provider: "vercel_connect", connectorUid: "posthog-paperclip" })},
        "credential_refs" = '[]'::jsonb,
        "credential_secret_refs" = '[]'::jsonb
      WHERE "id" = ${connectionId}
    `;
    await expect(sql`
      UPDATE "tool_connections" SET "credential_secret_refs" = ${sql.json([{ secretId: randomUUID() }])}
      WHERE "id" = ${connectionId}
    `).rejects.toMatchObject({ code: "23514" });

    const grantId = randomUUID();
    await sql`
      INSERT INTO "connection_grants" (
        "id", "company_id", "connection_id", "kind", "is_default", "external_credential"
      ) VALUES (
        ${grantId}, ${companyId}, ${connectionId}, 'organization', true,
        ${sql.json({ provider: "vercel_connect", subjectType: "app" })}
      )
    `;
    await expect(sql`
      UPDATE "connection_grants" SET "credential_secret_refs" = ${sql.json([{ secretId: randomUUID() }])}
      WHERE "id" = ${grantId}
    `).rejects.toMatchObject({ code: "23514" });
  }, 30_000);
});
