import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
  inspectMigrations,
  migrationContentAlreadyApplied,
  MIGRATION_RECONCILE_INSERT_LOCK_KEYS,
  migrationStatementAlreadyApplied,
  reconcilePendingMigrationHistory,
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

/**
 * Polls `pg_locks` until `expectedWaiters` distinct backends are blocked
 * waiting (not yet granted) on the two-int advisory lock identified by
 * `key1`/`key2`. For the two-int overload of `pg_advisory_xact_lock` /
 * `pg_advisory_lock`, Postgres records the lock in `pg_locks` with
 * `locktype = 'advisory'`, `classid = key1`, `objid = key2`, `objsubid = 2`
 * - see https://www.postgresql.org/docs/current/view-pg-locks.html.
 *
 * Used to deterministically control the two-replica race test below: rather
 * than guessing a fixed delay long enough for both replicas' pre-lock reads
 * to finish (flaky under CI scheduling variance), this polls the real lock
 * table until both are actually confirmed blocked at the exact chokepoint,
 * however long that takes.
 */
async function waitForAdvisoryLockWaiters(
  sql: ReturnType<typeof postgres>,
  key1: number,
  key2: number,
  expectedWaiters: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await sql.unsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM pg_locks
       WHERE locktype = 'advisory' AND classid = ${key1} AND objid = ${key2}
         AND objsubid = 2 AND granted = false`,
    );
    if ((rows[0]?.count ?? 0) >= expectedWaiters) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${expectedWaiters} advisory-lock waiter(s) on (${key1}, ${key2})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Stands in for a `sql` client in tests that assert a code path never
// touches `sql` at all. Any property access or call throws a descriptive
// error instead of a generic `TypeError: Cannot read properties of
// undefined`, so a future regression that DOES touch `sql` fails with an
// immediately diagnostic message.
function createUntouchedSqlProxy(): ReturnType<typeof postgres> {
  const fail = (detail: string): never => {
    throw new Error(`sql should not be called in this test path (attempted: ${detail})`);
  };
  return new Proxy(function () {}, {
    get(_target, prop) {
      fail(`property access "${String(prop)}"`);
    },
    apply(_target, _thisArg, args) {
      fail(`function call with args ${JSON.stringify(args)}`);
    },
  }) as unknown as ReturnType<typeof postgres>;
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

describeEmbeddedPostgres("migrationStatementAlreadyApplied", () => {
  it("recognizes standalone SET session-config statements as trivially already-applied", async () => {
    // SET statements are session-scoped runtime parameters with no persistent
    // schema effect, so this must return true without ever touching `sql`.
    const untouchedSql = createUntouchedSqlProxy();

    await expect(
      migrationStatementAlreadyApplied(untouchedSql, "SET lock_timeout = '2s';"),
    ).resolves.toBe(true);
    await expect(
      migrationStatementAlreadyApplied(untouchedSql, "SET statement_timeout = '30s';"),
    ).resolves.toBe(true);
    await expect(
      migrationStatementAlreadyApplied(untouchedSql, "set lock_timeout to '2s';"),
    ).resolves.toBe(true);
    await expect(
      migrationStatementAlreadyApplied(untouchedSql, "SET LOCAL lock_timeout = '2s';"),
    ).resolves.toBe(true);
    await expect(
      migrationStatementAlreadyApplied(untouchedSql, "SET SESSION statement_timeout TO '30s';"),
    ).resolves.toBe(true);
  });

  it("still requires manual migration for statements it cannot reason about", async () => {
    const untouchedSql = createUntouchedSqlProxy();

    await expect(
      migrationStatementAlreadyApplied(untouchedSql, "DROP TABLE \"widgets\";"),
    ).resolves.toBe(false);
  });

  it("recognizes SET statements with dotted GUC parameter names (e.g. extension settings)", async () => {
    const untouchedSql = createUntouchedSqlProxy();

    await expect(
      migrationStatementAlreadyApplied(untouchedSql, "SET pg_stat_statements.track = 'all';"),
    ).resolves.toBe(true);
    await expect(
      migrationStatementAlreadyApplied(
        untouchedSql,
        "SET LOCAL timescaledb.max_background_workers TO 8;",
      ),
    ).resolves.toBe(true);
  });

  it(
    "does NOT treat a SET statement immediately followed by real DDL in the same chunk as already-applied",
    async () => {
      // This is the exact compound-chunk scenario the anchoring fix (`$` at
      // the end of the SET regex) exists to prevent: a `SET ...;` followed by
      // real DDL with no `--> statement-breakpoint` separator between them.
      // If this were ever misclassified as "already applied", the real DDL
      // would be silently skipped.
      const untouchedSql = createUntouchedSqlProxy();

      await expect(
        migrationStatementAlreadyApplied(
          untouchedSql,
          `SET lock_timeout = '2s'; ALTER TABLE foo ADD COLUMN bar text`,
        ),
      ).resolves.toBe(false);
    },
  );

  it("still recognizes a SET statement followed by a paperclip:migration-safety-ignore comment", async () => {
    // `-- paperclip:migration-safety-ignore <rule>: <reason>` is this
    // codebase's real convention (see check-migration-safety.ts) for
    // annotating a statement that intentionally trips the migration-safety
    // linter. Confirm such a trailing comment on its own line after a SET
    // statement doesn't interfere with recognizing the SET statement itself
    // when it is its own chunk.
    const untouchedSql = createUntouchedSqlProxy();

    await expect(
      migrationStatementAlreadyApplied(
        untouchedSql,
        "SET LOCAL lock_timeout = '2s'; -- paperclip:migration-safety-ignore some-reason",
      ),
    ).resolves.toBe(true);
    await expect(
      migrationStatementAlreadyApplied(
        untouchedSql,
        "SET lock_timeout = '2s';\n-- paperclip:migration-safety-ignore large-create-index-not-concurrently: reason",
      ),
    ).resolves.toBe(true);
  });

  it(
    "does NOT let a paperclip:migration-safety-ignore comment on one line swallow real DDL on a later line",
    async () => {
      // Regression test for the whitespace-normalization bug: `normalized`
      // used to collapse newlines to spaces BEFORE the SET-statement regex
      // ran, so a trailing `-- ...` comment on the SET line had nothing
      // stopping it from also consuming a `CREATE INDEX ...;` statement that
      // originally lived on its own line right after it (e.g. because a
      // migration ever omitted the `--> statement-breakpoint` separator
      // between them). That would make this function incorrectly report the
      // whole chunk as already-applied, silently skipping the real DDL.
      //
      // Unlike the two earlier "SET + real DDL" tests above (which can use
      // `createUntouchedSqlProxy` because the trailing DDL there is
      // unrecognizable, e.g. unquoted identifiers), the trailing `CREATE
      // INDEX "not_yet_applied_idx" ...` here IS a recognized shape once
      // isolated as its own statement - the whole point of the real fix is
      // that it now gets independently verified against the database rather
      // than being rejected outright by a blunt guard. So this needs a real
      // temp database: prove `false` when the index genuinely does not
      // exist, and `true` once it does, confirming the trailing statement is
      // actually checked rather than merely not-swallowed.
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`CREATE TABLE "widgets" ("id" integer PRIMARY KEY)`);

        const combinedChunk = [
          "SET LOCAL lock_timeout = '2s'; -- paperclip:migration-safety-ignore some-reason",
          'CREATE INDEX "not_yet_applied_idx" ON "widgets" ("id");',
        ].join("\n");

        await expect(migrationStatementAlreadyApplied(sql, combinedChunk)).resolves.toBe(false);

        await sql.unsafe(`CREATE INDEX "not_yet_applied_idx" ON "widgets" ("id")`);

        await expect(migrationStatementAlreadyApplied(sql, combinedChunk)).resolves.toBe(true);
      } finally {
        await sql.end();
      }
    },
  );

  it("does not change behavior for the four previously recognized statement shapes", async () => {
    const connectionString = await createTempDatabase();
    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql.unsafe(`CREATE TABLE "widgets" ("id" integer PRIMARY KEY)`);
      await sql.unsafe(`CREATE INDEX "widgets_id_idx" ON "widgets" ("id")`);
      await sql.unsafe(
        `ALTER TABLE "widgets" ADD CONSTRAINT "widgets_id_check" CHECK ("id" > 0)`,
      );

      await expect(
        migrationStatementAlreadyApplied(sql, `CREATE TABLE "widgets" ("id" integer PRIMARY KEY)`),
      ).resolves.toBe(true);
      await expect(
        migrationStatementAlreadyApplied(sql, `CREATE TABLE "does_not_exist" ("id" integer)`),
      ).resolves.toBe(false);

      await expect(
        migrationStatementAlreadyApplied(sql, `ALTER TABLE "widgets" ADD COLUMN "id" integer`),
      ).resolves.toBe(true);
      await expect(
        migrationStatementAlreadyApplied(sql, `ALTER TABLE "widgets" ADD COLUMN "missing_col" integer`),
      ).resolves.toBe(false);

      await expect(
        migrationStatementAlreadyApplied(sql, `CREATE INDEX "widgets_id_idx" ON "widgets" ("id")`),
      ).resolves.toBe(true);
      await expect(
        migrationStatementAlreadyApplied(sql, `CREATE INDEX "missing_idx" ON "widgets" ("id")`),
      ).resolves.toBe(false);

      await expect(
        migrationStatementAlreadyApplied(
          sql,
          `ALTER TABLE "widgets" ADD CONSTRAINT "widgets_id_check" CHECK ("id" > 0)`,
        ),
      ).resolves.toBe(true);
      await expect(
        migrationStatementAlreadyApplied(
          sql,
          `ALTER TABLE "widgets" ADD CONSTRAINT "missing_constraint" CHECK ("id" > 0)`,
        ),
      ).resolves.toBe(false);
    } finally {
      await sql.end();
    }
  });

  it(
    "does not treat a constraint name existing on a DIFFERENT table as already-applied",
    async () => {
      // Regression coverage for the table-scoping gap in `constraintExists()`:
      // it used to check whether a constraint with a given name existed
      // ANYWHERE in the `public` schema, without regard to which table the
      // `ADD CONSTRAINT` statement being checked actually targets. Unlike
      // index/table/sequence names (which Postgres itself requires to be
      // unique per-schema, making a genuine name collision across tables
      // impossible to construct), constraint names are only required to be
      // unique PER TABLE - two different tables can legitimately each have a
      // constraint named e.g. `..._ownership_check`, which is exactly the
      // shape multiple `ADD CONSTRAINT` statements in a single migration
      // chunk produce (see `0182_connections_v3_schema_core.sql`). Create a
      // constraint with a given name on table A, then check for that SAME
      // name against table B, which does NOT have it. Before the
      // table-scoping fix, this would have incorrectly returned `true` for
      // table B purely because a same-named constraint existed somewhere in
      // `public` (on table A) - which could make every statement in a
      // multi-`ADD CONSTRAINT` chunk resolve `true` and the whole migration
      // get marked already-applied in the journal even though the DDL never
      // ran against table B's actual constraint - silent schema drift with
      // no error surfaced anywhere.
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`CREATE TABLE "table_a" ("id" integer PRIMARY KEY)`);
        await sql.unsafe(`CREATE TABLE "table_b" ("id" integer PRIMARY KEY)`);
        await sql.unsafe(
          `ALTER TABLE "table_a" ADD CONSTRAINT "shared_name_check" CHECK ("id" > 0)`,
        );

        // Sanity check: the constraint exists, correctly, when checked
        // against the table it actually belongs to (table A).
        await expect(
          migrationStatementAlreadyApplied(
            sql,
            `ALTER TABLE "table_a" ADD CONSTRAINT "shared_name_check" CHECK ("id" > 0)`,
          ),
        ).resolves.toBe(true);

        // The actual regression: the same constraint name, checked against
        // table B (which does not have it), must resolve `false` - not
        // `true` just because the name exists elsewhere in `public`.
        await expect(
          migrationStatementAlreadyApplied(
            sql,
            `ALTER TABLE "table_b" ADD CONSTRAINT "shared_name_check" CHECK ("id" > 0)`,
          ),
        ).resolves.toBe(false);

        // And once the DDL is actually applied to table B too (its own,
        // independent constraint of the same name - legal in Postgres), it
        // correctly flips to `true` there as well - proving this isn't just
        // "always false for table B", but genuinely scoped per-table.
        await sql.unsafe(
          `ALTER TABLE "table_b" ADD CONSTRAINT "shared_name_check" CHECK ("id" > 0)`,
        );
        await expect(
          migrationStatementAlreadyApplied(
            sql,
            `ALTER TABLE "table_b" ADD CONSTRAINT "shared_name_check" CHECK ("id" > 0)`,
          ),
        ).resolves.toBe(true);
      } finally {
        await sql.end();
      }
    },
  );

  it(
    "scopes CREATE INDEX existence checks to the statement's actual target table",
    async () => {
      // Companion coverage for `indexExists()`'s table-scoping fix. Unlike
      // constraint names, Postgres itself requires index names to be unique
      // per-schema (indexes share the table/view/sequence namespace), so a
      // genuine same-name collision across two tables cannot be constructed
      // the way the constraint regression above can. This instead proves
      // the fix directly: an index that exists on table A must NOT be
      // reported as already-applied for an (otherwise identical) `CREATE
      // INDEX` statement whose `ON` clause names table B - which the old,
      // table-blind `indexExists()` would have gotten wrong purely because
      // it never looked at which table the index actually belonged to.
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`CREATE TABLE "table_a" ("id" integer PRIMARY KEY)`);
        await sql.unsafe(`CREATE TABLE "table_b" ("id" integer PRIMARY KEY)`);
        await sql.unsafe(`CREATE INDEX "table_a_id_idx" ON "table_a" ("id")`);

        await expect(
          migrationStatementAlreadyApplied(sql, `CREATE INDEX "table_a_id_idx" ON "table_a" ("id")`),
        ).resolves.toBe(true);

        // Same index name, but the statement's `ON` clause names table B,
        // which has no such index - must resolve false.
        await expect(
          migrationStatementAlreadyApplied(sql, `CREATE INDEX "table_a_id_idx" ON "table_b" ("id")`),
        ).resolves.toBe(false);
      } finally {
        await sql.end();
      }
    },
  );

  it(
    "fails closed (returns false, not mis-parsed as true) for a TAGGED dollar-quoted body with an embedded semicolon",
    async () => {
      // `splitIntoIndividualSqlStatements()` only recognizes ANONYMOUS
      // `$$...$$` dollar-quotes; TAGGED variants like `$tag$...$tag$` are not
      // supported and get mis-split on any `;` inside them, since the
      // isolator's dollar-quote detection only looks for a literal `$$`, not
      // a matching `$tag$...$tag$` pair. Confirm this documented limitation
      // fails CLOSED: the mis-split fragments are unrecognized shapes (not
      // valid SQL on their own), so `singleSqlStatementAlreadyApplied()`
      // returns `false` for at least one of them, and the whole chunk
      // resolves `false` (triggering a retry via the normal migration path)
      // rather than being silently misparsed as `true`.
      const untouchedSql = createUntouchedSqlProxy();

      // The embedded semicolons here are deliberately NOT inside any
      // single-quoted string, so single-quote tracking (which the isolator
      // does support) cannot incidentally protect them the way it would for
      // e.g. a `RAISE EXCEPTION '...; ...'` message. Only genuine `$tag$`
      // recognition could keep this block from being split apart, and since
      // that is not supported, the isolator incorrectly splits it into three
      // fragments at these `;` characters - none of which match any
      // recognized statement shape, so the chunk still safely resolves
      // `false` overall (fails closed) rather than being misparsed as `true`.
      const taggedDollarQuoteBody = [
        "DO $tag$",
        "BEGIN",
        "  PERFORM 1;",
        "  PERFORM 2;",
        "END",
        "$tag$;",
      ].join("\n");

      await expect(
        migrationStatementAlreadyApplied(untouchedSql, taggedDollarQuoteBody),
      ).resolves.toBe(false);
    },
  );

  describe("multi-statement chunks (no statement-breakpoint between statements)", () => {
    // Regression coverage for the real-world shape found in e.g.
    // `0182_connections_v3_schema_core.sql`: a single chunk containing
    // several `;`-terminated DDL statements with no `--> statement-breakpoint`
    // separating them. The CREATE TABLE / ADD COLUMN / CREATE INDEX / ADD
    // CONSTRAINT matchers are prefix-only (anchored at `^` but not `$`), so a
    // naive implementation would misjudge such a chunk based solely on its
    // first statement. The correct behavior (what these tests verify) is: a
    // chunk is split into its individual statements, each is independently
    // checked against real schema state, and the chunk is "already applied"
    // only if EVERY statement in it independently resolves to already
    // applied.

    it("reports true only once every statement in a multi-ADD-COLUMN chunk is applied", async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`CREATE TABLE "widgets" ("id" integer PRIMARY KEY)`);
        await sql.unsafe(`ALTER TABLE "widgets" ADD COLUMN "a" integer`);

        const combinedChunk = [
          'ALTER TABLE "widgets" ADD COLUMN "a" integer;',
          'ALTER TABLE "widgets" ADD COLUMN "b" integer;',
        ].join("\n");

        // "b" does not exist yet - adversarial mix of one already-applied
        // ADD COLUMN alongside one genuinely-not-yet-applied ADD COLUMN in
        // the same chunk. The whole chunk must be reported as NOT applied,
        // even though the first statement in it is applied.
        await expect(migrationStatementAlreadyApplied(sql, combinedChunk)).resolves.toBe(false);

        await sql.unsafe(`ALTER TABLE "widgets" ADD COLUMN "b" integer`);

        // Now both are applied - the whole chunk must resolve true.
        await expect(migrationStatementAlreadyApplied(sql, combinedChunk)).resolves.toBe(true);
      } finally {
        await sql.end();
      }
    });

    it("does not treat a CREATE-INDEX-then-CREATE-TABLE chunk as already-applied based only on its first statement", async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`CREATE TABLE "widgets" ("id" integer PRIMARY KEY)`);
        await sql.unsafe(`CREATE INDEX "foo_idx" ON "widgets" ("id")`);

        const combinedChunk = [
          'CREATE INDEX "foo_idx" ON "widgets" ("id");',
          'CREATE TABLE "bar" ("id" integer PRIMARY KEY);',
        ].join(" ");

        // "foo_idx" exists but "bar" does not - the chunk must resolve
        // false because of the second (unapplied) statement, not true
        // purely because the first statement matched.
        await expect(migrationStatementAlreadyApplied(sql, combinedChunk)).resolves.toBe(false);

        await sql.unsafe(`CREATE TABLE "bar" ("id" integer PRIMARY KEY)`);

        await expect(migrationStatementAlreadyApplied(sql, combinedChunk)).resolves.toBe(true);
      } finally {
        await sql.end();
      }
    });

    it("does not treat a CREATE-TABLE-then-ADD-COLUMN chunk as already-applied based only on its first statement", async () => {
      // Same shape as above, but exercised with CREATE TABLE leading and
      // ADD COLUMN trailing, so coverage isn't limited to CREATE INDEX as
      // the leading statement.
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(`CREATE TABLE "widgets" ("id" integer PRIMARY KEY)`);

        const combinedChunk = [
          'CREATE TABLE "widgets" ("id" integer PRIMARY KEY);',
          'ALTER TABLE "widgets" ADD COLUMN "new_col" integer;',
        ].join(" ");

        await expect(migrationStatementAlreadyApplied(sql, combinedChunk)).resolves.toBe(false);

        await sql.unsafe(`ALTER TABLE "widgets" ADD COLUMN "new_col" integer`);

        await expect(migrationStatementAlreadyApplied(sql, combinedChunk)).resolves.toBe(true);
      } finally {
        await sql.end();
      }
    });

    it("returns false when a later statement in the chunk is an entirely unrecognized shape", async () => {
      // Even when every recognizable statement in the chunk is applied, an
      // unrecognized statement anywhere in the chunk (e.g. an UPDATE, which
      // this module has no way to verify against schema state) must still
      // make the whole chunk resolve false - "cannot reason about it safely"
      // remains the correct, fail-closed answer for that statement.
      const untouchedSql = createUntouchedSqlProxy();
      const combinedChunk = [
        `SET lock_timeout = '2s';`,
        `UPDATE "widgets" SET "a" = 1 WHERE "id" = 1;`,
      ].join("\n");

      await expect(migrationStatementAlreadyApplied(untouchedSql, combinedChunk)).resolves.toBe(
        false,
      );
    });

    it("returns false for an empty or whitespace-only chunk", async () => {
      const untouchedSql = createUntouchedSqlProxy();

      await expect(migrationStatementAlreadyApplied(untouchedSql, "")).resolves.toBe(false);
      await expect(migrationStatementAlreadyApplied(untouchedSql, "   \n\t  ")).resolves.toBe(
        false,
      );
      // A chunk that is nothing but statement terminators/whitespace once
      // comments are stripped (no actual statement content between them).
      await expect(migrationStatementAlreadyApplied(untouchedSql, " ; ; ")).resolves.toBe(false);
    });
  });
});

describeEmbeddedPostgres("migrationContentAlreadyApplied", () => {
  it(
    "treats a migration with leading SET statements as already-applied once the DDL is already applied",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // createTempDatabase() already applies every migration, including
        // 0212, so "companies"."enforce_agent_ownership" already exists.
        const migrationContent = [
          "SET lock_timeout = '2s';--> statement-breakpoint",
          "SET statement_timeout = '30s';--> statement-breakpoint",
          'ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "enforce_agent_ownership" boolean DEFAULT false NOT NULL;',
        ].join("\n");

        await expect(migrationContentAlreadyApplied(sql, migrationContent)).resolves.toBe(true);
      } finally {
        await sql.end();
      }
    },
  );

  it(
    "still reports not-applied when the trailing DDL statement hasn't run yet",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        // Simulate the column not having been applied yet.
        await sql.unsafe(`ALTER TABLE "companies" DROP COLUMN "enforce_agent_ownership"`);

        const migrationContent = [
          "SET lock_timeout = '2s';--> statement-breakpoint",
          "SET statement_timeout = '30s';--> statement-breakpoint",
          'ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "enforce_agent_ownership" boolean DEFAULT false NOT NULL;',
        ].join("\n");

        await expect(migrationContentAlreadyApplied(sql, migrationContent)).resolves.toBe(false);
      } finally {
        await sql.end();
      }
    },
  );
});

describeEmbeddedPostgres("reconcilePendingMigrationHistory", () => {
  it(
    "repairs migration 0212 (stale pre-consolidation hash) instead of treating it as unrecognized",
    async () => {
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      // Reproduce the real production failure mode: a history row for 0212
      // already exists, but it was recorded before a later commit in this
      // same PR consolidated what had originally been a separate
      // schema-flag migration into this file — folding the `agents.is_public`
      // and `companies.enforce_agent_ownership` ALTER TABLE statements (plus
      // their supporting foreign keys and indexes) directly onto the end of
      // what had, at the time this row was recorded, been just the two
      // `CREATE TABLE` statements for `agent_ownership_grants` and
      // `agent_ownership_transfers`. Its hash was computed from that
      // pre-consolidation file content, so it no longer matches the hash of
      // 0212_cooing_zaran.sql on disk today — this is a stale/mismatched
      // row, not a missing one.
      // The two CREATE TABLE statements below are reproduced from the
      // current migration file (see
      // packages/db/src/migrations/0212_cooing_zaran.sql) since those
      // predate the consolidation and are unchanged; everything from the
      // `agents.is_public` column addition onward is omitted, to simulate
      // the file's content as it existed when this stale row was recorded.
      const preConsolidationCooingZaranContent = `${[
        'CREATE TABLE "agent_ownership_grants" (',
        '  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,',
        '  "company_id" uuid NOT NULL,',
        '  "agent_id" uuid NOT NULL,',
        '  "principal_type" text NOT NULL,',
        '  "principal_id" text NOT NULL,',
        '  "role" text NOT NULL,',
        '  "granted_by_user_id" text,',
        '  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,',
        '  "revoked_at" timestamp with time zone,',
        '  "revoked_by_user_id" text,',
        '  "revoked_reason" text,',
        '  "transition_from_grant_id" uuid,',
        '  "is_instance_admin_override" boolean DEFAULT false NOT NULL,',
        '  "source" text NOT NULL,',
        '  "created_at" timestamp with time zone DEFAULT now() NOT NULL,',
        '  CONSTRAINT "agent_ownership_grants_principal_type_check" CHECK ("agent_ownership_grants"."principal_type" in (\'user\', \'agent\')),',
        '  CONSTRAINT "agent_ownership_grants_role_check" CHECK ("agent_ownership_grants"."role" in (\'owner\', \'admin\', \'user\')),',
        '  CONSTRAINT "agent_ownership_grants_source_check" CHECK ("agent_ownership_grants"."source" in (',
        "        'agent_create',",
        "        'agent_created_default',",
        "        'agent_hire',",
        "        'manual_grant',",
        "        'transfer_accept',",
        "        'instance_admin_override',",
        "        'instance_admin_bootstrap'",
        '      ))',
        ');',
        '--> statement-breakpoint',
        'CREATE TABLE "agent_ownership_transfers" (',
        '  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,',
        '  "company_id" uuid NOT NULL,',
        '  "agent_id" uuid NOT NULL,',
        '  "from_user_id" text NOT NULL,',
        '  "to_user_id" text NOT NULL,',
        '  "status" text DEFAULT \'pending\' NOT NULL,',
        '  "proposed_by_user_id" text NOT NULL,',
        '  "proposed_at" timestamp with time zone DEFAULT now() NOT NULL,',
        '  "responded_by_user_id" text,',
        '  "responded_at" timestamp with time zone,',
        '  "forced_by_instance_admin_user_id" text,',
        '  "resulting_grant_id" uuid,',
        '  "created_at" timestamp with time zone DEFAULT now() NOT NULL,',
        '  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,',
        '  CONSTRAINT "agent_ownership_transfers_status_check" CHECK ("agent_ownership_transfers"."status" in (\'pending\', \'accepted\', \'declined\', \'cancelled\', \'forced\'))',
        ');',
      ].join("\n")}\n`;
      const stalePreRewriteHash = createHash("sha256")
        .update(preConsolidationCooingZaranContent)
        .digest("hex");
      const cooingZaranHash = await migrationHash("0212_cooing_zaran.sql");

      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${cooingZaranHash}'`,
        );
        await sql.unsafe(
          `
            INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
            VALUES ('${stalePreRewriteHash}', 1786223854510)
          `,
        );
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0212_cooing_zaran.sql"],
        reason: "pending-migrations",
      });

      // Before the orphan-repointing fix, reconcilePendingMigrationHistory()
      // had no notion of a stale orphan row at all: finding no existing row
      // whose hash or name matched the current migration file, it would
      // simply INSERT a brand-new row for 0212 alongside the pre-existing
      // stale-hash row rather than repointing that row — leaving two rows in
      // the history table for a single applied migration. The assertions
      // below (single row remaining, total row count matching available
      // migrations) confirm the fix repoints the orphan instead.
      const repair = await reconcilePendingMigrationHistory(connectionString);
      expect(repair.repairedMigrations).toEqual(["0212_cooing_zaran.sql"]);
      expect(repair.remainingMigrations).toEqual([]);

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      // Verify the orphan-stale-row fix: reconciliation must repoint the
      // existing stale-hash row at the correct hash rather than leaving it
      // in place and INSERTing a second row alongside it. Exactly one row
      // for migration 0212 should remain — not two.
      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<{ hash: string }[]>(
          `SELECT hash FROM "drizzle"."__drizzle_migrations" WHERE hash = '${cooingZaranHash}' OR hash = '${stalePreRewriteHash}'`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.hash).toBe(cooingZaranHash);

        const totalRows = await verifySql.unsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations"`,
        );
        // Row count should match what a normal, never-corrupted history
        // would have: one row per applied migration, no leftover orphan.
        expect(totalRows[0]?.count).toBe(pendingState.availableMigrations.length);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );

  it(
    "does not throw, double-insert, or double-count when two replicas race the same missing migration row",
    async () => {
      // Exercises the advisory-lock-guarded check-then-insert path's
      // concurrent-replica branch (`alreadyRecordedByAnotherReplica`),
      // which previously had zero test coverage. Delete the history row for
      // an already-applied migration entirely (no stale-hash orphan left
      // behind), so both concurrent calls take the INSERT branch for the
      // same migration rather than the UPDATE-orphan branch exercised by
      // the test above.
      const connectionString = await createTempDatabase();

      await applyPendingMigrations(connectionString);

      const cooingZaranHash = await migrationHash("0212_cooing_zaran.sql");
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(
          `DELETE FROM "drizzle"."__drizzle_migrations" WHERE hash = '${cooingZaranHash}'`,
        );
      } finally {
        await sql.end();
      }

      const pendingState = await inspectMigrations(connectionString);
      expect(pendingState).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: ["0212_cooing_zaran.sql"],
        reason: "pending-migrations",
      });

      // Two concurrent "replicas" both reconcile at once. The advisory lock
      // (`MIGRATION_RECONCILE_INSERT_LOCK_KEYS`) serializes their INSERT
      // attempts: whichever acquires the lock first inserts and reports the
      // repair; the second must see `alreadyRecordedByOtherReplica`, skip
      // its own insert, and must NOT report the migration as repaired too.
      //
      // Naively racing two real `reconcilePendingMigrationHistory()` calls
      // via a bare `Promise.all` (as an earlier version of this test did) is
      // NOT safe to assert on precisely: the pre-lock reads each replica
      // does before ever reaching the advisory lock (existing-row-by-hash,
      // existing-row-by-name, stale-orphan lookup) are themselves
      // unsynchronized reads. If one replica's real Postgres connection is
      // slow enough that the OTHER replica fully completes its insert
      // *before* the slow replica's pre-lock reads even run, the slow
      // replica would see the row via its plain pre-lock `existingByHash`
      // check and take the "already exists" branch itself, rather than ever
      // reaching the advisory lock at all - a real, legal ordering of two
      // independent Postgres connections, not a bug, but not the
      // winner/loser shape this test wants to assert on either. Whether
      // that happens is a race with real wall-clock time, which is exactly
      // what made assertions written against a bare `Promise.all`
      // intermittently flaky in CI (at least 3 legal interleavings, only 1
      // of which matches the assertions below).
      //
      // To make the outcome deterministic without weakening the assertions,
      // this test manually acquires the SAME advisory lock key up front
      // (session-scoped, from a dedicated connection) before starting either
      // replica. Both replicas can then race through their pre-lock reads
      // freely - but since neither of them can possibly have inserted yet
      // (the only place either replica inserts is gated behind this lock,
      // which this test is holding), those pre-lock reads are guaranteed to
      // observe "no existing row" for both replicas, every time. Each
      // replica then blocks trying to acquire the lock this test already
      // holds. Only once `waitForAdvisoryLockWaiters` confirms BOTH
      // replicas are actually blocked there (via `pg_locks`, not a guessed
      // timeout) does this test release its lock - at which point exactly
      // one of the two remaining legal Postgres lock-grant orderings occurs,
      // and either one produces the same winner/loser shape asserted below.
      const lockSql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const [lockKey1, lockKey2] = MIGRATION_RECONCILE_INSERT_LOCK_KEYS;
        await lockSql.unsafe(`SELECT pg_advisory_lock(${lockKey1}, ${lockKey2})`);

        const racePromise = Promise.all([
          reconcilePendingMigrationHistory(connectionString),
          reconcilePendingMigrationHistory(connectionString),
        ]);
        // Attach a handler immediately so a rejection here is never
        // "unhandled" from Node's perspective, even if waitForAdvisoryLockWaiters
        // below throws (e.g. a CI timeout) before the real `await racePromise`
        // on line ~2131 runs. The real result/error is still surfaced by that
        // later await; this no-op catch exists purely to prevent an unhandled
        // rejection from destabilizing unrelated Vitest workers.
        racePromise.catch(() => {});

        await waitForAdvisoryLockWaiters(lockSql, lockKey1, lockKey2, 2);

        await lockSql.unsafe(`SELECT pg_advisory_unlock(${lockKey1}, ${lockKey2})`);

        const [first, second] = await racePromise;

        const totalRepairedCount =
          first.repairedMigrations.length + second.repairedMigrations.length;
        expect(totalRepairedCount).toBe(1);
        expect([...first.repairedMigrations, ...second.repairedMigrations]).toEqual([
          "0212_cooing_zaran.sql",
        ]);

        // The winning replica is whichever call actually performed the
        // repair; the losing replica is the one that found the row already
        // inserted by the time it acquired the advisory lock. Confirm the
        // loser's result surfaces that via `alreadyRecordedByOtherReplica`
        // (the whole reason this field exists - so callers can tell
        // "another replica already handled it" apart from "nothing
        // happened, still genuinely pending") and that the winner's
        // `alreadyRecordedByOtherReplica` stays empty (it performed the
        // repair itself, so it never took the "already recorded by someone
        // else" branch). Which of `first`/`second` is the winner is still
        // arbitrary (Postgres does not guarantee FIFO lock-grant order) -
        // that arbitrariness is exactly why the test sorts by outcome
        // rather than by call position - but it no longer matters which one
        // wins: both remaining legal grant orders now produce this same
        // shape, which is what makes the test deterministic.
        const [winner, loser] =
          first.repairedMigrations.length > 0 ? [first, second] : [second, first];
        expect(winner.repairedMigrations).toEqual(["0212_cooing_zaran.sql"]);
        expect(winner.alreadyRecordedByOtherReplica).toEqual([]);
        expect(loser.repairedMigrations).toEqual([]);
        expect(loser.alreadyRecordedByOtherReplica).toEqual(["0212_cooing_zaran.sql"]);
      } finally {
        await lockSql.end();
      }

      const finalState = await inspectMigrations(connectionString);
      expect(finalState.status).toBe("upToDate");

      const verifySql = postgres(connectionString, { max: 1, onnotice: () => {} });
      try {
        const rows = await verifySql.unsafe<{ count: number }[]>(
          `SELECT count(*)::int AS count FROM "drizzle"."__drizzle_migrations" WHERE hash = '${cooingZaranHash}'`,
        );
        expect(rows[0]?.count).toBe(1);
      } finally {
        await verifySql.end();
      }
    },
    20_000,
  );
});
