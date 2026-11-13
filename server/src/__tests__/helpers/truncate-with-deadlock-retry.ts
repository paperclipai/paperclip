import { sql } from "drizzle-orm";
import type { createDb } from "@paperclipai/db";

type Db = ReturnType<typeof createDb>;

const LATE_COMMENT_FOREIGN_KEY = "issue_comments_issue_id_issues_id_fk";
const DEADLOCK_DETECTED_CODE = "40P01";

export function errorHasPostgresCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object") return false;
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === code) return true;
    current = record.cause;
  }
  return false;
}

function isLateWriterRace(error: unknown): boolean {
  if (errorHasPostgresCode(error, DEADLOCK_DETECTED_CODE)) return true;
  return error instanceof Error && error.message.includes(LATE_COMMENT_FOREIGN_KEY);
}

// A fixture cleanup can race a background write that the test's drain step
// cannot see yet. Two forms of that race show up in this suite: a PostgreSQL
// deadlock (code 40P01) when a late writer holds a row lock that the
// TRUNCATE's lock ordering also needs, and a foreign-key violation when a
// dependent row lands between two deletes. Retry a fixed number of times with
// a backoff delay before the caller gives up and rethrows.
export async function truncateTablesWithDeadlockRetry(
  db: Db,
  truncateStatement: string,
  opts: { attempts?: number; delayMs?: (attempt: number) => number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 10;
  const delayMs = opts.delayMs ?? ((attempt: number) => 50 * (attempt + 1));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await db.execute(sql.raw(truncateStatement));
      return;
    } catch (error) {
      if (!isLateWriterRace(error) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs(attempt)));
    }
  }
}
