import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  DEFAULT_DATABASE_APPLICATION_NAME,
  applyPendingMigrations,
  createDb,
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

describeEmbeddedPostgres("createDb pool defaults", () => {
  it("names its backends and closes them once idle", async () => {
    const url = await createTempDatabase();
    const observer = postgres(url, { max: 1, onnotice: () => {} });
    cleanups.push(async () => {
      await observer.end({ timeout: 1 });
    });

    const backendsNamed = async (name: string) => {
      const rows = await observer`
        select count(*)::int as count from pg_stat_activity where application_name = ${name}
      `;
      return rows[0]?.count ?? 0;
    };

    const db = createDb(url);
    cleanups.push(async () => {
      await db.$client.end({ timeout: 1 });
    });
    const [self] = await db.$client`select application_name from pg_stat_activity where pid = pg_backend_pid()`;
    expect(self?.application_name).toBe(DEFAULT_DATABASE_APPLICATION_NAME);

    const shortLived = createDb(url, { applicationName: "paperclip-idle-test", idleTimeoutSeconds: 1 });
    cleanups.push(async () => {
      await shortLived.$client.end({ timeout: 1 });
    });
    await shortLived.$client`select 1`;
    expect(await backendsNamed("paperclip-idle-test")).toBe(1);

    // The driver closes the idle connection after `idle_timeout`; without the
    // option (the driver default) the backend would stay until the process
    // exits. Wait past the timeout, then poll PostgreSQL's own view.
    const deadline = Date.now() + 10_000;
    let remaining = await backendsNamed("paperclip-idle-test");
    while (remaining > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      remaining = await backendsNamed("paperclip-idle-test");
    }
    expect(remaining).toBe(0);
  }, 30_000);
});

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
    "backfills missing webhook secret bindings for legacy webhook triggers (enabled and disabled) and is idempotent",
    async () => {
      const connectionString = await createTempDatabase();
      const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => sql.end());

      const companyId = randomUUID();
      const enabledRoutineId = randomUUID();
      const disabledRoutineId = randomUUID();
      const alreadyBoundRoutineId = randomUUID();
      const enabledSecretId = randomUUID();
      const disabledSecretId = randomUUID();
      const alreadyBoundSecretId = randomUUID();
      const enabledTriggerId = randomUUID();
      const disabledTriggerId = randomUUID();
      const alreadyBoundTriggerId = randomUUID();

      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, 'Backfill webhook company', 'BWH')
      `;
      for (const routineId of [enabledRoutineId, disabledRoutineId, alreadyBoundRoutineId]) {
        await sql`
          INSERT INTO "routines" (
            "id", "company_id", "title"
          ) VALUES (
            ${routineId}, ${companyId}, ${`Legacy routine ${routineId}`}
          )
        `;
      }
      for (const secretId of [enabledSecretId, disabledSecretId, alreadyBoundSecretId]) {
        await sql`
          INSERT INTO "company_secrets" (
            "id", "company_id", "key", "name"
          ) VALUES (
            ${secretId}, ${companyId}, ${`webhookSecret:${secretId}`}, ${`webhook-${secretId}`}
          )
        `;
      }
      await sql`
        INSERT INTO "routine_triggers" (
          "id", "company_id", "routine_id", "kind", "enabled", "secret_id"
        ) VALUES (
          ${enabledTriggerId}, ${companyId}, ${enabledRoutineId}, 'webhook', true, ${enabledSecretId}
        )
      `;
      await sql`
        INSERT INTO "routine_triggers" (
          "id", "company_id", "routine_id", "kind", "enabled", "secret_id"
        ) VALUES (
          ${disabledTriggerId}, ${companyId}, ${disabledRoutineId}, 'webhook', false, ${disabledSecretId}
        )
      `;
      await sql`
        INSERT INTO "routine_triggers" (
          "id", "company_id", "routine_id", "kind", "enabled", "secret_id"
        ) VALUES (
          ${alreadyBoundTriggerId}, ${companyId}, ${alreadyBoundRoutineId}, 'webhook', true, ${alreadyBoundSecretId}
        )
      `;
      await sql`
        INSERT INTO "company_secret_bindings" (
          "company_id", "secret_id", "target_type", "target_id", "config_path"
        ) VALUES (
          ${companyId}, ${alreadyBoundSecretId}, 'routine', ${alreadyBoundRoutineId},
          ${`webhookSecret:${alreadyBoundSecretId}`}
        )
      `;
      await sql`
        DELETE FROM "company_secret_bindings"
        WHERE "secret_id" IN (${enabledSecretId}, ${disabledSecretId})
      `;

      const hash = await migrationHash("0506_backfill_webhook_secret_bindings.sql");
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}
      `;

      await expect(applyPendingMigrations(connectionString)).resolves.toBeUndefined();

      const bindings = await sql<
        { secret_id: string; target_id: string; config_path: string }[]
      >`
        SELECT "secret_id", "target_id", "config_path"
        FROM "company_secret_bindings"
        WHERE "company_id" = ${companyId}
        ORDER BY "secret_id"
      `;
      expect(bindings).toHaveLength(3);

      const bySecret = new Map(bindings.map((row) => [row.secret_id, row]));
      expect(bySecret.get(enabledSecretId)).toEqual({
        secret_id: enabledSecretId,
        target_id: enabledRoutineId,
        config_path: `webhookSecret:${enabledSecretId}`,
      });
      expect(bySecret.get(disabledSecretId)).toEqual({
        secret_id: disabledSecretId,
        target_id: disabledRoutineId,
        config_path: `webhookSecret:${disabledSecretId}`,
      });
      expect(bySecret.get(alreadyBoundSecretId)).toEqual({
        secret_id: alreadyBoundSecretId,
        target_id: alreadyBoundRoutineId,
        config_path: `webhookSecret:${alreadyBoundSecretId}`,
      });

      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}
      `;
      await expect(applyPendingMigrations(connectionString)).resolves.toBeUndefined();
      const afterReplay = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM "company_secret_bindings"
        WHERE "company_id" = ${companyId}
      `;
      expect(afterReplay[0]?.count).toBe(3);
    },
    45_000,
  );
});
