import { setTimeout as delay } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";

// Every workspace-recovery test file that uses
// PAPERCLIP_WORKSPACE_RECOVERY_TEST_DATABASE_URL truncates that database.
// A file holds this session advisory lock from setup to teardown, so the files
// queue on the database, even across separate test processes. Ending the
// returned client releases the lock.
//
// Poll with pg_try_advisory_lock rather than block in pg_advisory_lock: the
// holder's migrations include CREATE INDEX CONCURRENTLY, which waits for every
// open query in the database, and a blocked lock call would never finish.
export async function lockWorkspaceRecoveryTestDatabase(url: string) {
  const lock = createDb(url, { maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  for (;;) {
    const [row] = await lock.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_lock(hashtext('paperclip:workspace-recovery-tests')) AS locked`);
    if (row?.locked) return lock;
    await delay(500);
  }
}

// Waiting for the lock can take as long as the other files run.
export const WORKSPACE_RECOVERY_EXTERNAL_SETUP_TIMEOUT_MS = 30 * 60_000;
