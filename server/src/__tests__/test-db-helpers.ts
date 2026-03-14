import { createDb, applyPendingMigrations, type Db } from "@paperclipai/db";

const DEFAULT_TEST_DATABASE_URL = "postgres://paperclip:paperclip@localhost:5432/paperclip_test";

/**
 * Returns true when a test database is available (TEST_DATABASE_URL is set).
 * Use with `describe.skipIf(!hasTestDatabase)` to guard integration tests.
 */
export const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);

export async function createTestDatabase(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  await applyPendingMigrations(url);
  return createDb(url);
}
