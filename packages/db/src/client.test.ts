import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import {
  DEFAULT_DATABASE_APPLICATION_NAME,
  acquireDeploymentLease,
  assertDeploymentSchemaCompatible,
  assertSameDeploymentDatabase,
  applyPendingMigrations,
  createDb,
  inspectMigrations,
  resetPostgresDatabase,
} from "./client.js";
import {
  agents,
  budgetPolicies,
  companies,
  companySecrets,
  companySecretVersions,
  deploymentResources,
} from "./schema/index.js";
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

describeEmbeddedPostgres("managed deployment database ownership", () => {
  it("excludes a second controller until the first releases its connection", async () => {
    const url = await createTempDatabase();
    const lost = vi.fn();
    const release = await acquireDeploymentLease(url, lost);
    cleanups.push(release);
    await expect(acquireDeploymentLease(url, vi.fn())).rejects.toThrow("already owns");
    await release();
    await release();
    expect(lost).not.toHaveBeenCalled();
    const next = await acquireDeploymentLease(url, vi.fn());
    cleanups.push(next);
    await next();
  }, 30_000);

  it("reports lease loss once and does not reacquire after its backend is terminated", async () => {
    const url = await createTempDatabase();
    const observer = postgres(url, { max: 1, onnotice: () => {} });
    cleanups.push(async () => { await observer.end({ timeout: 1 }); });
    const lost = vi.fn();
    const release = await acquireDeploymentLease(url, lost);
    cleanups.push(release);
    const [owner] = await observer`
      select pid from pg_locks where locktype = 'advisory' and objid = 1735289202
      and database = (select oid from pg_database where datname = current_database())`;
    expect(owner?.pid).toEqual(expect.any(Number));
    await observer`select pg_terminate_backend(${owner.pid})`;
    await expect.poll(() => lost.mock.calls.length).toBe(1);
    const next = await acquireDeploymentLease(url, vi.fn());
    cleanups.push(next);
    await release();
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(acquireDeploymentLease(url, vi.fn())).rejects.toThrow("already owns");
  }, 30_000);

  it("refuses unknown migration hashes without changing the journal", async () => {
    const url = await createTempDatabase();
    await expect(assertDeploymentSchemaCompatible(url)).resolves.toBeUndefined();
    const observer = postgres(url, { max: 1, onnotice: () => {} });
    cleanups.push(async () => { await observer.end({ timeout: 1 }); });
    await observer`insert into drizzle.__drizzle_migrations (hash, created_at)
      values ('unknown-managed-deployment-migration', 9999999999999)`;
    const before = await observer`select * from drizzle.__drizzle_migrations order by id`;
    await expect(assertDeploymentSchemaCompatible(url)).rejects.toThrow("unknown or newer migrations");
    expect(await observer`select * from drizzle.__drizzle_migrations order by id`).toEqual(before);
  }, 30_000);
});

describeEmbeddedPostgres("deployment ownership database guards", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-deployment-ownership-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  it("protects declared fields and deletion while preserving operational pauses and spending", async () => {
    const [company] = await db.insert(companies).values({ name: "Managed", issuePrefix: "MAN" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", status: "idle", adapterType: "process" }).returning();
    await db.insert(deploymentResources).values({ owner: "test", kind: "agent", key: "worker", resourceId: agent.id,
      companyId: company.id, fields: { name: "Worker" } });
    await expect(db.update(agents).set({ name: "Changed" }).where(eq(agents.id, agent.id))).rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned field cannot be changed" } });
    await expect(db.delete(agents).where(eq(agents.id, agent.id))).rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned resources cannot be deleted" } });
    await db.update(agents).set({ status: "paused", spentMonthlyCents: 123 }).where(eq(agents.id, agent.id));
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0]).toMatchObject({ name: "Worker", status: "paused", spentMonthlyCents: 123 });
    await db.transaction(async tx => {
      await tx.execute(sql`select set_config('paperclip.deployment_apply', 'on', true)`);
      await tx.update(agents).set({ name: "Declared rename" }).where(eq(agents.id, agent.id));
    });
    await expect(db.update(agents).set({ name: "Outside transaction" }).where(eq(agents.id, agent.id))).rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned field cannot be changed" } });
    await db.update(deploymentResources).set({ enabled: false }).where(eq(deploymentResources.resourceId, agent.id));
    await expect(db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id))).rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively disabled resource cannot be resumed" } });
  });

  it("rejects ordinary secret-version changes for declared credentials", async () => {
    const [company] = await db.insert(companies).values({ name: "Secrets", issuePrefix: "SEC" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId: company.id, key: "worker_token", name: "Worker token", provider: "local_encrypted" }).returning();
    await db.insert(deploymentResources).values({ owner: "test", kind: "secret", key: "token", resourceId: secret.id,
      companyId: company.id, fields: {} });
    await expect(db.insert(companySecretVersions).values({ secretId: secret.id, version: 1,
      material: { fixture: "ciphertext" }, valueSha256: "fixture-hash", fingerprintSha256: "fixture-fingerprint" }))
      .rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned secret versions cannot be changed" } });
    expect(await db.select().from(companySecretVersions)).toHaveLength(0);
  });

  it("keeps a declared budget limit enforced", async () => {
    const [company] = await db.insert(companies).values({ name: "Budgeted", issuePrefix: "BUD" }).returning();
    await db.insert(deploymentResources).values({ owner: "test", kind: "company", key: "budgeted", resourceId: company.id,
      companyId: company.id, fields: { budgetMonthlyCents: 500 } });
    const [policy] = await db.insert(budgetPolicies).values({ companyId: company.id, scopeType: "company", scopeId: company.id,
      windowKind: "calendar_month_utc", amount: 500 }).returning();
    for (const change of [{ isActive: false }, { hardStopEnabled: false }, { amount: 900 }]) {
      await expect(db.update(budgetPolicies).set(change).where(eq(budgetPolicies.id, policy.id)))
        .rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned budget policy cannot be changed" } });
    }
    await expect(db.delete(budgetPolicies).where(eq(budgetPolicies.id, policy.id)))
      .rejects.toMatchObject({ cause: { code: "23514", message: "Declaratively owned budget policy cannot be deleted" } });
    const [lifetime] = await db.insert(budgetPolicies).values({ companyId: company.id, scopeType: "company", scopeId: company.id,
      windowKind: "lifetime", amount: 700 }).returning();
    await db.update(budgetPolicies).set({ amount: 800, isActive: false }).where(eq(budgetPolicies.id, lifetime.id));
    await db.update(budgetPolicies).set({ enforcementDeliveredVersion: 1 }).where(eq(budgetPolicies.id, policy.id));
  });

  it("refuses a migration connection that reaches another database", async () => {
    const url = database.connectionString;
    await assertSameDeploymentDatabase(url, url);
    await assertSameDeploymentDatabase(url, `${url}?application_name=migration`);
    const tokyo = new URL(url);
    tokyo.searchParams.set("options", "-c TimeZone=Asia/Tokyo -c DateStyle=SQL,DMY");
    await assertSameDeploymentDatabase(url, tokyo.toString());
    const other = new URL(url);
    other.pathname = "/postgres";
    await expect(assertSameDeploymentDatabase(url, other.toString())).rejects.toThrow("leased database");
  });
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
});
