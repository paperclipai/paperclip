/**
 * Per-suite embedded-Postgres test database.
 *
 * Two paths, selected automatically:
 *
 *   1. SHARED (RBR-912) — when `globalSetup` has published a run-wide cluster
 *      (see `test-embedded-postgres-shared.ts`), this clones a fresh database
 *      from the already-migrated template with
 *      `create database <fresh> template <template>`. Seconds, not a minute.
 *   2. LEGACY — no published cluster (for example the `@paperclipai/db` package's
 *      own migration tests, which run without that `globalSetup`). Boots a
 *      dedicated cluster per suite and migrates it, exactly as before.
 *
 * The low-level cluster primitives live in `test-embedded-postgres-cluster.ts`.
 */
import { randomUUID } from "node:crypto";
import { applyPendingMigrations, ensurePostgresDatabase } from "./client.js";
import { formatEmbeddedPostgresError } from "./embedded-postgres-error.js";
import {
  cleanupEmbeddedPostgresTestDirs,
  createEmbeddedPostgresCluster,
  destroyEmbeddedPostgresCluster,
  startEmbeddedPostgresWithRetry,
  stopEmbeddedPostgresBounded,
  type EmbeddedPostgresInstance,
  EMBEDDED_POSTGRES_START_MAX_ATTEMPTS,
  __setEmbeddedPostgresCtorProviderForTests,
} from "./test-embedded-postgres-cluster.js";
import {
  dropSharedEmbeddedPostgresDatabase,
  cloneSharedEmbeddedPostgresDatabase,
  getPublishedSharedEmbeddedPostgres,
} from "./test-embedded-postgres-shared.js";

export type EmbeddedPostgresTestSupport = {
  supported: boolean;
  reason?: string;
};

export type EmbeddedPostgresTestDatabase = {
  connectionString: string;
  cleanup(): Promise<void>;
};

let embeddedPostgresSupportPromise: Promise<EmbeddedPostgresTestSupport> | null = null;

// Re-exported for the existing retry unit test and for any caller that swapped
// the ctor provider before the cluster module was split out.
export { __setEmbeddedPostgresCtorProviderForTests };
export const __startEmbeddedPostgresWithRetryForTests = startEmbeddedPostgresWithRetry;
export const __embeddedPostgresStartMaxAttemptsForTests = EMBEDDED_POSTGRES_START_MAX_ATTEMPTS;

// Test seam. `getEmbeddedPostgresTestSupport` memoizes its probe for the life of
// the process, which is correct in a real run but leaks between cases in the
// guard's own unit test. Clearing the memo lets each case probe fresh.
export function __resetEmbeddedPostgresSupportForTests(): void {
  embeddedPostgresSupportPromise = null;
}

async function probeEmbeddedPostgresSupport(): Promise<EmbeddedPostgresTestSupport> {
  // RBR-912: when `globalSetup` already booted the run's shared cluster, that
  // boot *is* the support probe. Booting a throwaway probe cluster here would
  // pay the ~20 s cost again in every worker for no new information.
  if (getPublishedSharedEmbeddedPostgres()) return { supported: true };

  let started: { dataDir: string; instance: EmbeddedPostgresInstance } | null = null;

  try {
    started = await startEmbeddedPostgresWithRetry("paperclip-embedded-postgres-probe-");
    return { supported: true };
  } catch (error) {
    return {
      supported: false,
      reason: formatEmbeddedPostgresError(error, {
        fallbackMessage: "embedded Postgres startup failed",
      }).message,
    };
  } finally {
    if (started) {
      const { dataDir, instance } = started;
      await stopEmbeddedPostgresBounded(instance, () => cleanupEmbeddedPostgresTestDirs(dataDir));
    }
  }
}

/**
 * Escape hatch for environments that genuinely cannot run embedded Postgres.
 * Unset (the normal case), an unsupported probe is a hard failure rather than a
 * silent green run — see `getEmbeddedPostgresTestSupport`.
 */
export const ALLOW_SKIP_EMBEDDED_POSTGRES_ENV = "PAPERCLIP_ALLOW_SKIP_EMBEDDED_POSTGRES_TESTS";

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (!embeddedPostgresSupportPromise) {
    embeddedPostgresSupportPromise = probeEmbeddedPostgresSupport();
  }
  const support = await embeddedPostgresSupportPromise;

  // RBR-912 / AC4. Callers use this to pick `describe` vs `describe.skip`, so an
  // unsupported probe turns a whole suite green-by-omission: the tests report
  // `skipped` and nothing is red. That is exactly how ~56 service tests went
  // missing. Fail loudly instead. Opting out is explicit and per-environment.
  if (!support.supported && !process.env[ALLOW_SKIP_EMBEDDED_POSTGRES_ENV]) {
    throw new Error(
      `Embedded Postgres is required by this test suite but is unavailable: ${
        support.reason ?? "unknown reason"
      }\n` +
        `Skipping would report these tests as \`skipped\` and hide real coverage. ` +
        `Set ${ALLOW_SKIP_EMBEDDED_POSTGRES_ENV}=1 to allow the skip deliberately.`,
    );
  }

  return support;
}

/**
 * Fast path: clone a fresh, already-migrated database off the run's shared
 * template. No cluster boot and no migration run.
 */
async function startFromSharedCluster(
  shared: { adminConnectionString: string; templateDatabase: string },
): Promise<EmbeddedPostgresTestDatabase> {
  // Postgres identifiers are limited to 63 bytes and may not start with a digit.
  const databaseName = `paperclip_test_${randomUUID().replace(/-/g, "")}`;
  const connectionString = await cloneSharedEmbeddedPostgresDatabase(shared, databaseName);

  return {
    connectionString,
    cleanup: async () => {
      // Drop the clone so a long run does not accumulate hundreds of databases
      // in the shared cluster's data directory. The cluster itself is owned by
      // `globalSetup` and torn down once, at the end of the run.
      await dropSharedEmbeddedPostgresDatabase(shared, databaseName);
    },
  };
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  const shared = getPublishedSharedEmbeddedPostgres();
  if (shared) return await startFromSharedCluster(shared);

  // Legacy path: a dedicated cluster for this suite. The bounded retry hardens
  // the cluster start against the port race. It throws with the real Postgres
  // output if every attempt fails.
  const cluster = await createEmbeddedPostgresCluster(tempDirPrefix);

  try {
    await ensurePostgresDatabase(cluster.adminConnectionString, "paperclip");
    const connectionString = cluster.databaseConnectionString("paperclip");
    await applyPendingMigrations(connectionString);

    return {
      connectionString,
      cleanup: async () => {
        await destroyEmbeddedPostgresCluster(cluster);
      },
    };
  } catch (error) {
    await destroyEmbeddedPostgresCluster(cluster);
    throw new Error(
      `Failed to start embedded PostgreSQL test database: ${
        formatEmbeddedPostgresError(error, {
          fallbackMessage: "embedded Postgres startup failed",
        }).message
      }`,
    );
  }
}
