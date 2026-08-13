/**
 * RBR-912 — boot embedded Postgres once per vitest run, not once per suite.
 *
 * Vitest calls `setup` before it forks any worker and `teardown` after the last
 * one exits, so the cluster booted here is visible (via `process.env`, which
 * forks inherit) to every suite in the run and torn down exactly once.
 *
 * Suites do not need to know about this. `startEmbeddedPostgresTestDatabase()`
 * detects the published cluster and clones a fresh database from the migrated
 * template instead of booting; with no published cluster it falls back to the
 * original boot-per-suite path.
 */
import { startSharedEmbeddedPostgresCluster } from "@paperclipai/db/test-embedded-postgres-shared";

type SharedCluster = Awaited<ReturnType<typeof startSharedEmbeddedPostgresCluster>>;

let cluster: SharedCluster | null = null;

export async function setup(): Promise<void> {
  cluster = await startSharedEmbeddedPostgresCluster();
  // Printed so a slow run is diagnosable: this number is the whole run's
  // Postgres boot cost, previously paid once per suite.
  console.log(
    `[embedded-postgres] shared cluster ready in ${(cluster.bootMs / 1000).toFixed(1)}s ` +
      `(template ${cluster.templateDatabase})`,
  );
}

export async function teardown(): Promise<void> {
  await cluster?.stop();
  cluster = null;
}
