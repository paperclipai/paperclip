/**
 * RBR-912 — one embedded-Postgres cluster per vitest run.
 *
 * Booting embedded Postgres and applying the full migration set is expensive.
 * Measured on an M-series laptop:
 *
 *   import @paperclipai/db .................. 19.5 s
 *   probe boot (getEmbeddedPostgresTestSupport) 21.7 s
 *   boot + ensureDatabase + migrate ......... 53.7 s   <-- per suite, previously
 *
 * 147 server suites boot their own cluster in `beforeAll`, so the run paid that
 * ~54 s over and over and every one of those hooks had to be budgeted for it.
 * That is what made the inline `20_000` ms budgets unpayable (RBR-912).
 *
 * The fix is a shared cluster:
 *
 *   1. `startSharedEmbeddedPostgresCluster()` runs ONCE per vitest run (from the
 *      project's `globalSetup`). It boots one cluster and applies all migrations
 *      into a *template* database.
 *   2. It publishes the cluster's admin connection string and template name into
 *      `process.env`. Vitest spawns its worker forks after `globalSetup`, so every
 *      worker inherits those variables.
 *   3. `startEmbeddedPostgresTestDatabase()` sees the published cluster and, instead
 *      of booting, issues `create database <fresh> template <template>` — a physical
 *      copy of an already-migrated directory. That is seconds, not a minute, and it
 *      still gives each suite a fully isolated database.
 *
 * Suites that run outside a project with this `globalSetup` (for example the
 * `@paperclipai/db` package's own migration tests) see no published cluster and
 * fall back to the original boot-per-suite path, unchanged.
 */
import postgres from "postgres";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";
import { formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import {
  createEmbeddedPostgresCluster,
  destroyEmbeddedPostgresCluster,
  type EmbeddedPostgresCluster,
} from "./test-embedded-postgres-cluster.js";

/**
 * Admin (`postgres` database) connection string for the run's shared cluster.
 * Absent when no shared cluster is running, which selects the legacy
 * boot-per-suite path.
 */
export const SHARED_EMBEDDED_POSTGRES_ADMIN_URL_ENV = "PAPERCLIP_TEST_SHARED_POSTGRES_ADMIN_URL";

/**
 * Name of the fully-migrated template database that per-suite databases are
 * cloned from.
 */
export const SHARED_EMBEDDED_POSTGRES_TEMPLATE_ENV = "PAPERCLIP_TEST_SHARED_POSTGRES_TEMPLATE";

const SHARED_TEMPLATE_DATABASE = "paperclip_template";

export type SharedEmbeddedPostgresCluster = {
  adminConnectionString: string;
  templateDatabase: string;
  /** Milliseconds spent booting and migrating. Reported by `globalSetup`. */
  bootMs: number;
  stop(): Promise<void>;
};

/**
 * Read the shared cluster published by `globalSetup`, or `null` when this process
 * is not running under one.
 */
export function getPublishedSharedEmbeddedPostgres(): {
  adminConnectionString: string;
  templateDatabase: string;
} | null {
  const adminConnectionString = process.env[SHARED_EMBEDDED_POSTGRES_ADMIN_URL_ENV];
  const templateDatabase = process.env[SHARED_EMBEDDED_POSTGRES_TEMPLATE_ENV];
  if (!adminConnectionString || !templateDatabase) return null;
  return { adminConnectionString, templateDatabase };
}

/**
 * Boot the run's single shared cluster and migrate its template database.
 *
 * Intended to be called exactly once per vitest run, from `globalSetup`. Calling
 * it a second time in the same process boots a second cluster; the caller owns
 * that decision.
 */
export async function startSharedEmbeddedPostgresCluster(): Promise<SharedEmbeddedPostgresCluster> {
  const startedAt = Date.now();
  let cluster: EmbeddedPostgresCluster | null = null;

  try {
    cluster = await createEmbeddedPostgresCluster("paperclip-shared-embedded-postgres-");
    const adminConnectionString = cluster.adminConnectionString;

    // The template database carries the migrated schema. Per-suite databases are
    // `create database ... template`-cloned from it, so the migration cost is
    // paid exactly once for the whole run.
    await ensurePostgresDatabase(adminConnectionString, SHARED_TEMPLATE_DATABASE);
    await applyPendingMigrations(cluster.databaseConnectionString(SHARED_TEMPLATE_DATABASE));

    process.env[SHARED_EMBEDDED_POSTGRES_ADMIN_URL_ENV] = adminConnectionString;
    process.env[SHARED_EMBEDDED_POSTGRES_TEMPLATE_ENV] = SHARED_TEMPLATE_DATABASE;

    const owned = cluster;
    return {
      adminConnectionString,
      templateDatabase: SHARED_TEMPLATE_DATABASE,
      bootMs: Date.now() - startedAt,
      stop: async () => {
        delete process.env[SHARED_EMBEDDED_POSTGRES_ADMIN_URL_ENV];
        delete process.env[SHARED_EMBEDDED_POSTGRES_TEMPLATE_ENV];
        await destroyEmbeddedPostgresCluster(owned);
      },
    };
  } catch (error) {
    if (cluster) await destroyEmbeddedPostgresCluster(cluster);
    throw new Error(
      `Failed to start shared embedded PostgreSQL test cluster: ${
        formatEmbeddedPostgresError(error, {
          fallbackMessage: "embedded Postgres startup failed",
        }).message
      }`,
    );
  }
}

type PublishedSharedCluster = {
  adminConnectionString: string;
  templateDatabase: string;
};

function assertSafeDatabaseName(databaseName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }
}

/**
 * Swap the database component of the shared cluster's admin URL. The cluster
 * lives on `127.0.0.1` with a fixed user, so only the pathname differs.
 */
export function sharedEmbeddedPostgresDatabaseUrl(
  adminConnectionString: string,
  databaseName: string,
): string {
  const url = new URL(adminConnectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * `create database <databaseName> template <template>` against the run's shared
 * cluster and return the connection string for the clone.
 *
 * `create database ... template` is a physical directory copy of an
 * already-migrated database, so this costs seconds instead of a cluster boot
 * plus the whole migration set. Postgres refuses the copy while any other
 * session is connected to the template, and vitest's serialized server shard
 * never connects to the template, so the copy is safe.
 */
export async function cloneSharedEmbeddedPostgresDatabase(
  shared: PublishedSharedCluster,
  databaseName: string,
): Promise<string> {
  assertSafeDatabaseName(databaseName);
  const sql = postgres(shared.adminConnectionString, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(
      `create database "${databaseName}" template "${shared.templateDatabase}"`,
    );
  } finally {
    await sql.end();
  }
  return sharedEmbeddedPostgresDatabaseUrl(shared.adminConnectionString, databaseName);
}

/**
 * Drop a cloned per-suite database. Best-effort: a failed drop leaks one
 * database inside a cluster that is destroyed at the end of the run anyway, so
 * it must never fail a suite's `afterAll`.
 */
export async function dropSharedEmbeddedPostgresDatabase(
  shared: PublishedSharedCluster,
  databaseName: string,
): Promise<void> {
  assertSafeDatabaseName(databaseName);
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(shared.adminConnectionString, { max: 1, onnotice: () => {} });
    // Suites can leave idle pooled connections behind; `drop database` fails
    // while any session is attached, so evict them first.
    await sql`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${databaseName}
        and pid <> pg_backend_pid()
    `;
    await sql.unsafe(`drop database if exists "${databaseName}"`);
  } catch {
    // Ignore: the whole cluster is torn down when the run ends.
  } finally {
    await sql?.end().catch(() => {});
  }
}
