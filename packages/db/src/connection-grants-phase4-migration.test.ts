import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0231_fixed_hannibal_king.sql";
const migrationSql = fs.readFileSync(
  path.join(import.meta.dirname, "migrations", MIGRATION_FILE),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function migrationHash() {
  return createHash("sha256").update(migrationSql).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("connection grants phase 4 migration", () => {
  it("adds replay-safe named-agent standing delegations", () => {
    expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS "connection_grant_delegations"`);
    expect(migrationSql).toContain(`"connection_grant_delegations_grant_agent_uq"`);
    expect(migrationSql).toContain(`FOREIGN KEY ("company_id","grant_id")`);
    expect(migrationSql).toContain(`DROP CONSTRAINT IF EXISTS "connection_grant_delegations_company_grant_fk"`);
    expect(migrationSql).toContain(`CREATE INDEX IF NOT EXISTS "connection_grant_delegations_company_agent_idx"`);
    expect(migrationSql).toContain(`ON CONFLICT DO NOTHING`);
  });

  it("remediates ambiguous personal-secret ownership without assigning an arbitrary owner", () => {
    expect(migrationSql).toContain(`phase4_ambiguous_personal_secrets`);
    expect(migrationSql).toContain(`count(DISTINCT g."subject_user_id") AS "owner_count"`);
    expect(migrationSql).toContain(`organization_grant."kind" <> 'user'`);
    expect(migrationSql).toContain(`FROM "company_secret_bindings" binding`);
    expect(migrationSql).toContain(`"status" = 'needs_reauthorization'`);
    expect(migrationSql).toContain(`"health_status" = 'missing_secret'`);
  });
});

describeEmbeddedPostgres("connection grants phase 4 executable migration", () => {
  it("converts one owner and rejects two-owner or mixed legacy references", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-connection-phase4-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });

    async function rewindMigration() {
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash()}`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
    }

    async function seedLegacyCredential(input: {
      ownerUserIds: string[];
      includeOrganizationGrant?: boolean;
      includeConnectionReference?: boolean;
      includeCompanyBinding?: boolean;
    }) {
      const companyId = randomUUID();
      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const secretId = randomUUID();
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, ${`Phase 4 ${companyId}`}, ${`P${companyId.slice(0, 5)}`})
      `;
      await sql`
        INSERT INTO "tool_applications" ("id", "company_id", "name", "type")
        VALUES (${applicationId}, ${companyId}, ${`App ${applicationId}`}, 'mcp_http')
      `;
      await sql`
        INSERT INTO "tool_connections" (
          "id", "company_id", "application_id", "name", "uid", "transport", "credential_secret_refs"
        ) VALUES (
          ${connectionId}, ${companyId}, ${applicationId}, ${`Connection ${connectionId}`},
          ${`connection-${connectionId}`}, 'mcp_remote',
          ${sql.json(input.includeConnectionReference ? [{ secretId, version: "latest" }] : [])}
        )
      `;
      await sql`
        INSERT INTO "company_secrets" ("id", "company_id", "key", "name", "scope")
        VALUES (${secretId}, ${companyId}, ${`secret-${secretId}`}, ${`Secret ${secretId}`}, 'company')
      `;
      for (const ownerUserId of input.ownerUserIds) {
        await sql`
          INSERT INTO "connection_grants" (
            "company_id", "connection_id", "kind", "subject_user_id", "credential_secret_refs"
          ) VALUES (
            ${companyId}, ${connectionId}, 'user', ${ownerUserId},
            ${sql.json([{ secretId, version: "latest" }])}
          )
        `;
      }
      if (input.includeOrganizationGrant) {
        await sql`
          INSERT INTO "connection_grants" (
            "company_id", "connection_id", "kind", "credential_secret_refs"
          ) VALUES (
            ${companyId}, ${connectionId}, 'organization',
            ${sql.json([{ secretId, version: "latest" }])}
          )
        `;
      }
      if (input.includeCompanyBinding) {
        await sql`
          INSERT INTO "company_secret_bindings" (
            "company_id", "secret_id", "target_type", "target_id", "config_path"
          ) VALUES (
            ${companyId}, ${secretId}, 'environment', ${randomUUID()}, 'env.SHARED_TOKEN'
          )
        `;
      }
      return { companyId, connectionId, secretId, ownerUserId: input.ownerUserIds[0]! };
    }

    try {
      const valid = await seedLegacyCredential({ ownerUserIds: ["alice"] });
      await rewindMigration();
      await applyPendingMigrations(database.connectionString);
      const converted = await sql<{
        scope: string;
        owner_user_id: string | null;
        user_secret_definition_id: string | null;
      }[]>`
        SELECT "scope", "owner_user_id", "user_secret_definition_id"
        FROM "company_secrets"
        WHERE "id" = ${valid.secretId}
      `;
      expect(converted).toEqual([{
        scope: "user",
        owner_user_id: valid.ownerUserId,
        user_secret_definition_id: expect.any(String),
      }]);

      const bound = await seedLegacyCredential({
        ownerUserIds: ["binding-owner"],
        includeCompanyBinding: true,
      });
      await rewindMigration();
      await applyPendingMigrations(database.connectionString);
      expect(await sql<{ scope: string; owner_user_id: string | null }[]>`
        SELECT "scope", "owner_user_id"
        FROM "company_secrets"
        WHERE "id" = ${bound.secretId}
      `).toEqual([{ scope: "company", owner_user_id: null }]);
      expect(await sql<{ status: string; credential_secret_refs: unknown[] }[]>`
        SELECT "status", "credential_secret_refs"
        FROM "connection_grants"
        WHERE "company_id" = ${bound.companyId} AND "kind" = 'user'
      `).toEqual([{ status: "needs_reauthorization", credential_secret_refs: [] }]);
      expect(await sql<{ secret_id: string }[]>`
        SELECT "secret_id"
        FROM "company_secret_bindings"
        WHERE "company_id" = ${bound.companyId}
      `).toEqual([{ secret_id: bound.secretId }]);

      // Replaying the migration preserves the same company-scoped binding.
      await rewindMigration();
      await applyPendingMigrations(database.connectionString);
      expect(await sql<{ scope: string; owner_user_id: string | null }[]>`
        SELECT "scope", "owner_user_id"
        FROM "company_secrets"
        WHERE "id" = ${bound.secretId}
      `).toEqual([{ scope: "company", owner_user_id: null }]);

      const ambiguous = await seedLegacyCredential({ ownerUserIds: ["alice", "bob"] });
      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      expect(await sql<{
        status: string;
        is_default: boolean;
        credential_secret_refs: unknown[];
      }[]>`
        SELECT "status", "is_default", "credential_secret_refs"
        FROM "connection_grants"
        WHERE "company_id" = ${ambiguous.companyId}
        ORDER BY "is_default" DESC, "id"
      `).toEqual([
        { status: "active", is_default: true, credential_secret_refs: [] },
        { status: "needs_reauthorization", is_default: false, credential_secret_refs: [] },
        { status: "needs_reauthorization", is_default: false, credential_secret_refs: [] },
      ]);
      expect(await sql<{ scope: string; owner_user_id: string | null }[]>`
        SELECT "scope", "owner_user_id"
        FROM "company_secrets"
        WHERE "id" = ${ambiguous.secretId}
      `).toEqual([{ scope: "company", owner_user_id: null }]);

      const mixed = await seedLegacyCredential({
        ownerUserIds: ["carol"],
        includeOrganizationGrant: true,
        includeConnectionReference: true,
      });
      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).resolves.toBeUndefined();
      expect(await sql<{
        status: string;
        enabled: boolean;
        health_status: string;
        credential_secret_refs: unknown[];
      }[]>`
        SELECT "status", "enabled", "health_status", "credential_secret_refs"
        FROM "tool_connections"
        WHERE "id" = ${mixed.connectionId}
      `).toEqual([{
        status: "draft",
        enabled: false,
        health_status: "missing_secret",
        credential_secret_refs: [],
      }]);
      expect(await sql<{ status: string; credential_secret_refs: unknown[] }[]>`
        SELECT "status", "credential_secret_refs"
        FROM "connection_grants"
        WHERE "company_id" = ${mixed.companyId}
        ORDER BY "kind"
      `).toEqual([
        { status: "needs_reauthorization", credential_secret_refs: [] },
        { status: "needs_reauthorization", credential_secret_refs: [] },
        { status: "needs_reauthorization", credential_secret_refs: [] },
      ]);
    } finally {
      await sql.end();
    }
  }, 45_000);
});
