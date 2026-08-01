import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  inspectMigrations,
  resetPostgresDatabase,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-client-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function migrationHash(migrationFile: string): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

const userVisibleUpdatedAtTables = new Set([
  "companies",
  "heartbeat_runs",
  "issue_comments",
  "issues",
  "routine_runs",
  "routines",
]);

const migrationUpdatedAtUpdateAllowlist = new Map<string, ReadonlySet<string>>([
  [
    "0105_instance_scoped_environments.sql",
    new Set(["issues"]),
  ],
  [
    "0131_repair_run_responsible_user_context_refs.sql",
    new Set(["heartbeat_runs"]),
  ],
  [
    "0135_repair_run_responsible_user_updated_at_sweep.sql",
    new Set(["companies", "heartbeat_runs", "issues", "routine_runs", "routines"]),
  ],
]);

function findUserVisibleUpdatedAtBackfillViolations(
  migrationFile: string,
  content: string,
): string[] {
  const allowedTables = migrationUpdatedAtUpdateAllowlist.get(migrationFile) ?? new Set<string>();
  const violations: string[] = [];

  for (const statement of content.split("--> statement-breakpoint")) {
    const updateMatch = statement.match(/\bUPDATE\s+"([^"]+)"/i);
    if (!updateMatch) continue;

    const tableName = updateMatch[1];
    if (!userVisibleUpdatedAtTables.has(tableName)) continue;
    if (!/\bSET\b[\s\S]*"updated_at"\s*=/i.test(statement)) continue;
    if (allowedTables.has(tableName)) continue;

    violations.push(`${migrationFile}: UPDATE "${tableName}" sets updated_at`);
  }

  return violations;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("resetPostgresDatabase", () => {
  it("recreates an existing database so stale tables are removed", async () => {
    const connectionString = await createTempDatabase();
    const adminUrl = new URL(connectionString);
    const databaseName = adminUrl.pathname.replace(/^\//, "");
    adminUrl.pathname = "/postgres";

    const setupSql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      await setupSql.unsafe(`CREATE TABLE stale_reseed_target_only (id integer PRIMARY KEY)`);
    } finally {
      await setupSql.end();
    }

    await resetPostgresDatabase(adminUrl.toString(), databaseName);

    const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      const rows = await verifySql.unsafe<{ stale_table: string | null }[]>(
        `SELECT to_regclass('public.stale_reseed_target_only')::text AS stale_table`,
      );
      expect(rows[0]?.stale_table).toBeNull();
    } finally {
      await verifySql.end();
    }
  }, 30_000);
});

describeEmbeddedPostgres("applyPendingMigrations", () => {
  it("rejects unallowlisted migration backfills that bump updated_at on user-visible tables", async () => {
    const entries = await fs.promises.readdir(new URL("./migrations", import.meta.url), {
      withFileTypes: true,
    });
    const violations: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
      const content = await fs.promises.readFile(
        new URL(`./migrations/${entry.name}`, import.meta.url),
        "utf8",
      );
      violations.push(...findUserVisibleUpdatedAtBackfillViolations(entry.name, content));
    }

    expect(violations).toEqual([]);
    expect(
      findUserVisibleUpdatedAtBackfillViolations(
        "9999_bad_backfill.sql",
        `
          UPDATE "issues" AS i
          SET "responsible_user_id" = 'owner-user',
              "updated_at" = now()
          WHERE i."responsible_user_id" IS NULL;
        `,
      ),
    ).toEqual(['9999_bad_backfill.sql: UPDATE "issues" sets updated_at']);
  });

  it(
    "applies an inserted earlier migration without replaying later legacy migrations",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const richMagnetoHash = await migrationHash("0030_rich_magneto.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${richMagnetoHash}'`,
        );
        await sql.unsafe(`DROP TABLE "company_logos"`);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0030_rich_magneto.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('company_logos', 'execution_workspaces')
            ORDER BY table_name
          `,
        );
        expect(rows.map((row) => row.table_name)).toEqual([
          "company_logos",
          "execution_workspaces",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0044 safely when its schema changes already exist",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const illegalToadHash = await migrationHash("0044_illegal_toad.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${illegalToadHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'instance_settings'
              AND column_name = 'general'
          `,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0044_illegal_toad.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");
    },
    20_000,
  );

  it(
    "enforces a unique board_api_keys.key_hash after migration 0044",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`
          INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
          VALUES ('user-1', 'User One', 'user@example.com', true, now(), now())
        `);
        await sql.unsafe(`
          INSERT INTO "board_api_keys" ("id", "user_id", "name", "key_hash", "created_at")
          VALUES ('00000000-0000-0000-0000-000000000001', 'user-1', 'Key One', 'dup-hash', now())
        `);
        await expect(
          sql.unsafe(`
            INSERT INTO "board_api_keys" ("id", "user_id", "name", "key_hash", "created_at")
            VALUES ('00000000-0000-0000-0000-000000000002', 'user-1', 'Key Two', 'dup-hash', now())
          `),
        ).rejects.toThrow();
      } finally {
        await sql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0046 safely when document revision columns already exist",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const smoothSentinelsHash = await migrationHash("0046_smooth_sentinels.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${smoothSentinelsHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string; is_nullable: string; column_default: string | null }[]>(
          `
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'document_revisions'
              AND column_name IN ('title', 'format')
            ORDER BY column_name
          `,
        );
        expect(columns).toHaveLength(2);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0046_smooth_sentinels.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await verifySql.unsafe<{ column_name: string; is_nullable: string; column_default: string | null }[]>(
          `
            SELECT column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'document_revisions'
              AND column_name IN ('title', 'format')
            ORDER BY column_name
          `,
        );
        expect(columns).toEqual([
          expect.objectContaining({
            column_name: "format",
            is_nullable: "NO",
          }),
          expect.objectContaining({
            column_name: "title",
            is_nullable: "YES",
          }),
        ]);
        expect(columns[0]?.column_default).toContain("'markdown'");
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0047 safely when feedback tables and run columns already exist",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const overjoyedGrootHash = await migrationHash("0047_overjoyed_groot.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${overjoyedGrootHash}'`,
        );

        const tables = await sql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('feedback_exports', 'feedback_votes')
            ORDER BY table_name
          `,
        );
        expect(tables.map((row) => row.table_name)).toEqual([
          "feedback_exports",
          "feedback_votes",
        ]);

        const columns = await sql.unsafe<{ table_name: string; column_name: string }[]>(
          `
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND (
                (table_name = 'companies' AND column_name IN (
                  'feedback_data_sharing_enabled',
                  'feedback_data_sharing_consent_at',
                  'feedback_data_sharing_consent_by_user_id',
                  'feedback_data_sharing_terms_version'
                ))
                OR (table_name = 'document_revisions' AND column_name = 'created_by_run_id')
                OR (table_name = 'issue_comments' AND column_name = 'created_by_run_id')
              )
            ORDER BY table_name, column_name
          `,
        );
        expect(columns).toHaveLength(6);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0047_overjoyed_groot.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const constraints = await verifySql.unsafe<{ conname: string }[]>(
          `
            SELECT conname
            FROM pg_constraint
            WHERE conname IN (
              'feedback_exports_company_id_companies_id_fk',
              'feedback_exports_feedback_vote_id_feedback_votes_id_fk',
              'feedback_exports_issue_id_issues_id_fk',
              'feedback_votes_company_id_companies_id_fk',
              'feedback_votes_issue_id_issues_id_fk'
            )
            ORDER BY conname
          `,
        );
        expect(constraints.map((row) => row.conname)).toEqual([
          "feedback_exports_company_id_companies_id_fk",
          "feedback_exports_feedback_vote_id_feedback_votes_id_fk",
          "feedback_exports_issue_id_issues_id_fk",
          "feedback_votes_company_id_companies_id_fk",
          "feedback_votes_issue_id_issues_id_fk",
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0048 safely when routines.variables already exists",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const flashyMarrowHash = await migrationHash("0048_flashy_marrow.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${flashyMarrowHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'routines'
              AND column_name = 'variables'
          `,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0048_flashy_marrow.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await verifySql.unsafe<{ column_name: string; is_nullable: string; data_type: string }[]>(
          `
            SELECT column_name, is_nullable, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'routines'
              AND column_name = 'variables'
          `,
        );
        expect(columns).toEqual([
          expect.objectContaining({
            column_name: "variables",
            is_nullable: "NO",
            data_type: "jsonb",
          }),
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0050 safely when projects.env already exists",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const stiffLuckmanHash = await migrationHash("0050_stiff_luckman.sql");

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${stiffLuckmanHash}'`,
        );

        const columns = await sql.unsafe<{ column_name: string }[]>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'projects'
              AND column_name = 'env'
          `,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0050_stiff_luckman.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const columns = await verifySql.unsafe<{ column_name: string; is_nullable: string; data_type: string }[]>(
          `
            SELECT column_name, is_nullable, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'projects'
              AND column_name = 'env'
          `,
        );
        expect(columns).toEqual([
          expect.objectContaining({
            column_name: "env",
            is_nullable: "YES",
            data_type: "jsonb",
          }),
        ]);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0059 safely when plugin_database_namespaces already exists",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const pluginNamespacesHash = await migrationHash(
          "0059_plugin_database_namespaces.sql",
        );

        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${pluginNamespacesHash}'`,
        );

        const tables = await sql.unsafe<{ table_name: string }[]>(
          `
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('plugin_database_namespaces', 'plugin_migrations')
            ORDER BY table_name
          `,
        );
        expect(tables.map((row) => row.table_name)).toEqual([
          "plugin_database_namespaces",
          "plugin_migrations",
        ]);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0059_plugin_database_namespaces.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const indexes = await verifySql.unsafe<{ indexname: string }[]>(
          `
            SELECT indexname
            FROM pg_indexes
            WHERE schemaname = 'public'
              AND tablename IN ('plugin_database_namespaces', 'plugin_migrations')
            ORDER BY indexname
          `,
        );
        expect(indexes.map((row) => row.indexname)).toEqual(
          expect.arrayContaining([
            "plugin_database_namespaces_namespace_idx",
            "plugin_database_namespaces_plugin_idx",
            "plugin_database_namespaces_status_idx",
            "plugin_migrations_plugin_idx",
            "plugin_migrations_plugin_key_idx",
            "plugin_migrations_status_idx",
          ]),
        );
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays the built-in managed resources migration after the legacy 0136 journal entry",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const builtInResourcesHash = await migrationHash(
        "0140_built_in_managed_resources.sql",
      );
      const legacyBuiltInResourcesHash = createHash("sha256")
        .update("legacy 0136_built_in_managed_resources.sql")
        .digest("hex");

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${builtInResourcesHash}'`,
        );
        await sql.unsafe(
          `
            INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
            VALUES ('${legacyBuiltInResourcesHash}', 1783555200000)
          `,
        );
        await sql.unsafe(`
          ALTER TABLE "built_in_managed_resources"
          DROP CONSTRAINT IF EXISTS "built_in_managed_resources_company_id_companies_id_fk"
        `);
        await sql.unsafe(`DROP INDEX IF EXISTS "built_in_managed_resources_company_idx"`);
        await sql.unsafe(`DROP INDEX IF EXISTS "built_in_managed_resources_resource_idx"`);
        await sql.unsafe(`DROP INDEX IF EXISTS "built_in_managed_resources_company_bundle_resource_uq"`);
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0140_built_in_managed_resources.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<{
          foreign_key_exists: boolean;
          company_index_exists: boolean;
          resource_index_exists: boolean;
          unique_index_exists: boolean;
        }[]>(`
          SELECT
            EXISTS (
              SELECT 1
              FROM "pg_constraint" c
              JOIN "pg_class" t ON t.oid = c.conrelid
              JOIN "pg_namespace" n ON n.oid = t.relnamespace
              WHERE n.nspname = 'public'
                AND t.relname = 'built_in_managed_resources'
                AND c.conname = 'built_in_managed_resources_company_id_companies_id_fk'
            ) AS "foreign_key_exists",
            EXISTS (
              SELECT 1
              FROM "pg_class" c
              JOIN "pg_namespace" n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relkind = 'i'
                AND c.relname = 'built_in_managed_resources_company_idx'
            ) AS "company_index_exists",
            EXISTS (
              SELECT 1
              FROM "pg_class" c
              JOIN "pg_namespace" n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relkind = 'i'
                AND c.relname = 'built_in_managed_resources_resource_idx'
            ) AS "resource_index_exists",
            EXISTS (
              SELECT 1
              FROM "pg_class" c
              JOIN "pg_namespace" n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relkind = 'i'
                AND c.relname = 'built_in_managed_resources_company_bundle_resource_uq'
            ) AS "unique_index_exists"
        `);
        expect(rows[0]).toEqual({
          foreign_key_exists: true,
          company_index_exists: true,
          resource_index_exists: true,
          unique_index_exists: true,
        });
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0134 without bumping issue updated_at for inbox archives",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const runResponsibleUserHash = await migrationHash(
          "0134_run_responsible_user_invariant.sql",
        );

        await sql.unsafe(`
          INSERT INTO "companies" ("id", "name", "issue_prefix", "created_at", "updated_at")
          VALUES (
            '00000000-0000-0000-0000-000000000120',
            'Migration Inbox Co',
            'TST120',
            '2026-03-26T09:00:00.000Z',
            '2026-03-26T09:00:00.000Z'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "company_memberships" (
            "id",
            "company_id",
            "principal_type",
            "principal_id",
            "status",
            "membership_role",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000121',
            '00000000-0000-0000-0000-000000000120',
            'user',
            'owner-user',
            'active',
            'owner',
            '2026-03-26T09:00:00.000Z',
            '2026-03-26T09:00:00.000Z'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "issues" (
            "id",
            "company_id",
            "title",
            "status",
            "responsible_user_id",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000122',
            '00000000-0000-0000-0000-000000000120',
            'Archived issue needing responsible user backfill',
            'todo',
            NULL,
            '2026-03-26T10:00:00.000Z',
            '2026-03-26T10:00:00.000Z'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "issue_inbox_archives" (
            "id",
            "company_id",
            "issue_id",
            "user_id",
            "archived_at",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000123',
            '00000000-0000-0000-0000-000000000120',
            '00000000-0000-0000-0000-000000000122',
            'owner-user',
            '2026-03-26T12:00:00.000Z',
            '2026-03-26T12:00:00.000Z',
            '2026-03-26T12:00:00.000Z'
          )
        `);
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${runResponsibleUserHash}'`,
        );
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0134_run_responsible_user_invariant.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<{
          responsible_user_id: string | null;
          updated_at: Date;
          inbox_archive_still_current: boolean;
        }[]>(`
          SELECT
            i."responsible_user_id",
            i."updated_at",
            EXISTS (
              SELECT 1
              FROM "issue_inbox_archives" AS archive
              WHERE archive."company_id" = i."company_id"
                AND archive."issue_id" = i."id"
                AND archive."user_id" = 'owner-user'
                AND archive."archived_at" >= i."updated_at"
            ) AS "inbox_archive_still_current"
          FROM "issues" AS i
          WHERE i."id" = '00000000-0000-0000-0000-000000000122'
        `);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.responsible_user_id).toBe("owner-user");
        expect(rows[0]?.updated_at.toISOString()).toBe("2026-03-26T10:00:00.000Z");
        expect(rows[0]?.inbox_archive_still_current).toBe(true);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "replays migration 0135 to repair updated_at sweeps and no-op when clean",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const repairSweepHash = await migrationHash(
        "0135_repair_run_responsible_user_updated_at_sweep.sql",
      );
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`
          INSERT INTO "companies" ("id", "name", "issue_prefix", "created_at", "updated_at")
          VALUES (
            '00000000-0000-0000-0000-000000000240',
            'Clean Migration Co',
            'CLN134',
            '2026-04-01T09:00:00.000Z',
            '2026-04-02T09:00:00.000Z'
          )
        `);
        await sql.unsafe(`
          INSERT INTO "issues" ("id", "company_id", "title", "status", "created_at", "updated_at")
          VALUES (
            '00000000-0000-0000-0000-000000000241',
            '00000000-0000-0000-0000-000000000240',
            'Clean issue should not be touched',
            'todo',
            '2026-04-01T10:00:00.000Z',
            '2026-04-02T10:00:00.000Z'
          )
        `);
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${repairSweepHash}'`,
        );
      } finally {
        await sql.end();
      }

      await applyPendingMigrations(connectionString);

      const afterCleanReplay = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const cleanRows = await afterCleanReplay.unsafe<{ updated_at: Date }[]>(`
          SELECT "updated_at"
          FROM "issues"
          WHERE "id" = '00000000-0000-0000-0000-000000000241'
        `);
        expect(cleanRows[0]?.updated_at.toISOString()).toBe("2026-04-02T10:00:00.000Z");

        await afterCleanReplay.unsafe(`
          INSERT INTO "companies" ("id", "name", "issue_prefix", "created_at", "updated_at")
          VALUES (
            '00000000-0000-0000-0000-000000000250',
            'Sweep Migration Co',
            'SWP134',
            '2026-01-01T00:00:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "created_at", "updated_at")
          VALUES (
            '00000000-0000-0000-0000-000000000251',
            '00000000-0000-0000-0000-000000000250',
            'Sweep Agent',
            'general',
            'process',
            '2026-01-02T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "issues" ("id", "company_id", "title", "status", "created_at", "updated_at")
          SELECT
            ('10000000-0000-0000-0000-' || lpad(gs::text, 12, '0'))::uuid,
            '00000000-0000-0000-0000-000000000250',
            'Swept issue ' || gs::text,
            'todo',
            '2026-02-01T00:00:00.000Z'::timestamptz + (gs::text || ' minutes')::interval,
            '2026-04-03T12:00:00.123456Z'
          FROM generate_series(1, 101) AS gs
        `);
        await afterCleanReplay.unsafe(`
          UPDATE "issues"
          SET
            "status" = 'done',
            "completed_at" = '2026-04-03T12:00:00.123456Z'
          WHERE "id" = '10000000-0000-0000-0000-000000000003'
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "issue_comments" ("id", "company_id", "issue_id", "body", "created_at", "updated_at")
          VALUES (
            '00000000-0000-0000-0000-000000000252',
            '00000000-0000-0000-0000-000000000250',
            '10000000-0000-0000-0000-000000000001',
            'Latest pre-sweep activity',
            '2026-03-01T15:30:00.000Z',
            '2026-03-02T16:45:00.000Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "heartbeat_runs" (
            "id",
            "company_id",
            "agent_id",
            "status",
            "started_at",
            "finished_at",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000253',
            '00000000-0000-0000-0000-000000000250',
            '00000000-0000-0000-0000-000000000251',
            'completed',
            '2026-02-10T10:00:00.000Z',
            '2026-02-10T10:30:00.000Z',
            '2026-02-10T09:55:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "heartbeat_runs" (
            "id",
            "company_id",
            "agent_id",
            "status",
            "started_at",
            "last_output_at",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000256',
            '00000000-0000-0000-0000-000000000250',
            '00000000-0000-0000-0000-000000000251',
            'running',
            '2026-02-10T11:00:00.000Z',
            '2026-04-03T12:00:00.123456Z',
            '2026-02-10T10:55:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "routines" (
            "id",
            "company_id",
            "title",
            "last_triggered_at",
            "last_enqueued_at",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000254',
            '00000000-0000-0000-0000-000000000250',
            'Swept routine',
            '2026-03-20T10:00:00.000Z',
            '2026-03-21T11:00:00.000Z',
            '2026-02-11T00:00:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "routines" (
            "id",
            "company_id",
            "title",
            "last_triggered_at",
            "last_enqueued_at",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000257',
            '00000000-0000-0000-0000-000000000250',
            'Same-timestamp active routine',
            '2026-03-20T10:00:00.000Z',
            '2026-04-03T12:00:00.123456Z',
            '2026-02-11T00:00:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "routine_runs" (
            "id",
            "company_id",
            "routine_id",
            "source",
            "status",
            "completed_at",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000255',
            '00000000-0000-0000-0000-000000000250',
            '00000000-0000-0000-0000-000000000254',
            'schedule',
            'completed',
            '2026-02-12T12:00:00.000Z',
            '2026-02-12T11:00:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "routine_runs" (
            "id",
            "company_id",
            "routine_id",
            "source",
            "status",
            "triggered_at",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000258',
            '00000000-0000-0000-0000-000000000250',
            '00000000-0000-0000-0000-000000000257',
            'schedule',
            'running',
            '2026-04-03T12:00:00.123456Z',
            '2026-02-12T13:00:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "companies" ("id", "name", "issue_prefix", "created_at", "updated_at")
          VALUES (
            '00000000-0000-0000-0000-000000000260',
            'Coincident Timestamp Co',
            'CTS134',
            '2026-01-05T00:00:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "created_at", "updated_at")
          VALUES (
            '00000000-0000-0000-0000-000000000261',
            '00000000-0000-0000-0000-000000000260',
            'Coincident Agent',
            'general',
            'process',
            '2026-01-05T00:10:00.000Z',
            '2026-01-05T00:10:00.000Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "issues" ("id", "company_id", "title", "status", "created_at", "updated_at")
          VALUES (
            '20000000-0000-0000-0000-000000000001',
            '00000000-0000-0000-0000-000000000260',
            'Coincident timestamp issue should not be touched',
            'todo',
            '2026-02-05T00:00:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(`
          INSERT INTO "heartbeat_runs" (
            "id",
            "company_id",
            "agent_id",
            "status",
            "started_at",
            "finished_at",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000262',
            '00000000-0000-0000-0000-000000000260',
            '00000000-0000-0000-0000-000000000261',
            'completed',
            '2026-02-05T10:00:00.000Z',
            '2026-02-05T10:30:00.000Z',
            '2026-02-05T09:55:00.000Z',
            '2026-04-03T12:00:00.123456Z'
          )
        `);
        await afterCleanReplay.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${repairSweepHash}'`,
        );
      } finally {
        await afterCleanReplay.end();
      }

      await applyPendingMigrations(connectionString);

      const afterRepair = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const repairedRows = await afterRepair.unsafe<{
          subject: string;
          updated_at: Date;
        }[]>(`
          SELECT 'company' AS subject, "updated_at"
          FROM "companies"
          WHERE "id" = '00000000-0000-0000-0000-000000000250'
          UNION ALL
          SELECT 'issue_with_comment' AS subject, "updated_at"
          FROM "issues"
          WHERE "id" = '10000000-0000-0000-0000-000000000001'
          UNION ALL
          SELECT 'issue_without_comment' AS subject, "updated_at"
          FROM "issues"
          WHERE "id" = '10000000-0000-0000-0000-000000000002'
          UNION ALL
          SELECT 'issue_with_state_activity' AS subject, "updated_at"
          FROM "issues"
          WHERE "id" = '10000000-0000-0000-0000-000000000003'
          UNION ALL
          SELECT 'heartbeat_run' AS subject, "updated_at"
          FROM "heartbeat_runs"
          WHERE "id" = '00000000-0000-0000-0000-000000000253'
          UNION ALL
          SELECT 'heartbeat_run_with_output' AS subject, "updated_at"
          FROM "heartbeat_runs"
          WHERE "id" = '00000000-0000-0000-0000-000000000256'
          UNION ALL
          SELECT 'other_company' AS subject, "updated_at"
          FROM "companies"
          WHERE "id" = '00000000-0000-0000-0000-000000000260'
          UNION ALL
          SELECT 'other_heartbeat_run' AS subject, "updated_at"
          FROM "heartbeat_runs"
          WHERE "id" = '00000000-0000-0000-0000-000000000262'
          UNION ALL
          SELECT 'other_issue' AS subject, "updated_at"
          FROM "issues"
          WHERE "id" = '20000000-0000-0000-0000-000000000001'
          UNION ALL
          SELECT 'routine' AS subject, "updated_at"
          FROM "routines"
          WHERE "id" = '00000000-0000-0000-0000-000000000254'
          UNION ALL
          SELECT 'routine_with_activity' AS subject, "updated_at"
          FROM "routines"
          WHERE "id" = '00000000-0000-0000-0000-000000000257'
          UNION ALL
          SELECT 'routine_run' AS subject, "updated_at"
          FROM "routine_runs"
          WHERE "id" = '00000000-0000-0000-0000-000000000255'
          UNION ALL
          SELECT 'routine_run_with_trigger' AS subject, "updated_at"
          FROM "routine_runs"
          WHERE "id" = '00000000-0000-0000-0000-000000000258'
          ORDER BY subject
        `);
        const repaired = Object.fromEntries(
          repairedRows.map((row) => [row.subject, row.updated_at.toISOString()]),
        );
        expect(repaired).toEqual({
          company: "2026-01-01T00:00:00.000Z",
          heartbeat_run: "2026-02-10T10:30:00.000Z",
          heartbeat_run_with_output: "2026-04-03T12:00:00.123Z",
          issue_with_comment: "2026-03-02T16:45:00.000Z",
          issue_with_state_activity: "2026-04-03T12:00:00.123Z",
          issue_without_comment: "2026-02-01T00:02:00.000Z",
          other_company: "2026-04-03T12:00:00.123Z",
          other_heartbeat_run: "2026-04-03T12:00:00.123Z",
          other_issue: "2026-04-03T12:00:00.123Z",
          routine: "2026-03-21T11:00:00.000Z",
          routine_run_with_trigger: "2026-04-03T12:00:00.123Z",
          routine_with_activity: "2026-04-03T12:00:00.123Z",
          routine_run: "2026-02-12T12:00:00.000Z",
        });

        await afterRepair.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${repairSweepHash}'`,
        );
      } finally {
        await afterRepair.end();
      }

      await applyPendingMigrations(connectionString);

      const afterSecondRun = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const secondRunRows = await afterSecondRun.unsafe<{ updated_at: Date }[]>(`
          SELECT "updated_at"
          FROM "issues"
          WHERE "id" = '10000000-0000-0000-0000-000000000001'
        `);
        expect(secondRunRows[0]?.updated_at.toISOString()).toBe("2026-03-02T16:45:00.000Z");
      } finally {
        await afterSecondRun.end();
      }
    },
    20_000,
  );

  it(
    "replays the run responsible user repair migration when heartbeat run issue refs are identifiers",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const runResponsibleUserRepairHash = await migrationHash(
          "0131_repair_run_responsible_user_context_refs.sql",
        );

        await sql.unsafe(`
          INSERT INTO "companies" ("id", "name", "issue_prefix", "created_at", "updated_at")
          VALUES ('00000000-0000-0000-0000-000000000130', 'Migration Test Co', 'TST130', now(), now())
        `);
        await sql.unsafe(`
          INSERT INTO "company_memberships" (
            "id",
            "company_id",
            "principal_type",
            "principal_id",
            "status",
            "membership_role",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000131',
            '00000000-0000-0000-0000-000000000130',
            'user',
            'owner-user',
            'active',
            'owner',
            now(),
            now()
          )
        `);
        await sql.unsafe(`
          INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "created_at", "updated_at")
          VALUES (
            '00000000-0000-0000-0000-000000000132',
            '00000000-0000-0000-0000-000000000130',
            'Migration Agent',
            'general',
            'process',
            now(),
            now()
          )
        `);
        await sql.unsafe(`
          INSERT INTO "issues" (
            "id",
            "company_id",
            "title",
            "status",
            "responsible_user_id",
            "identifier",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000133',
            '00000000-0000-0000-0000-000000000130',
            'Identifier referenced issue',
            'todo',
            'issue-user',
            'TST130-1',
            now(),
            now()
          )
        `);
        await sql.unsafe(`
          INSERT INTO "heartbeat_runs" (
            "id",
            "company_id",
            "agent_id",
            "status",
            "responsible_user_id",
            "context_snapshot",
            "created_at",
            "updated_at"
          )
          VALUES (
            '00000000-0000-0000-0000-000000000134',
            '00000000-0000-0000-0000-000000000130',
            '00000000-0000-0000-0000-000000000132',
            'completed',
            NULL,
            '{"issueId":"TST130-1"}'::jsonb,
            now(),
            now()
          )
        `);
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${runResponsibleUserRepairHash}'`,
        );
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0131_repair_run_responsible_user_context_refs.sql"],
        reason: "pending-migrations",
      });

      await applyPendingMigrations(connectionString);

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const runs = await verifySql.unsafe<{ responsible_user_id: string | null }[]>(`
          SELECT "responsible_user_id"
          FROM "heartbeat_runs"
          WHERE "id" = '00000000-0000-0000-0000-000000000134'
        `);
        expect(runs).toEqual([{ responsible_user_id: "issue-user" }]);

      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );
});
