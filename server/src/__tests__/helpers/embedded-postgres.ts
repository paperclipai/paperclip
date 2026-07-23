import { createDb } from "@paperclipai/db";

export {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db";

/**
 * Close the underlying postgres-js client for a test db handle. Shared by the
 * settings-surface suites so each afterAll doesn't redefine it locally.
 */
export async function closeDbClient(
  db: ReturnType<typeof createDb> | undefined | null,
): Promise<void> {
  await db?.$client?.end?.({ timeout: 5 });
}
