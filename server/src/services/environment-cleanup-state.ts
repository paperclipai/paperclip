import { eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { hasDeferredEnvironmentCleanup } from "./environment-cleanup-notifications.js";

export const ENVIRONMENT_CLEANUP_RETRY_MS = 5 * 60_000;

export function pendingCleanupDeadlineSql(now = Date.now()) {
  const deadline = sql`case
    when ${environmentLeases.metadata}->>'pendingCleanupInFlight' = 'true'
      and ${environmentLeases.metadata} ? 'pendingCleanupLeaseExpiresAtMs'
      then ${environmentLeases.metadata}->'pendingCleanupLeaseExpiresAtMs'
    else ${environmentLeases.metadata}->'pendingCleanupRetryAfterMs' end`;
  return sql`case when jsonb_typeof(${deadline}) = 'number' then
    case when (${deadline})::numeric <= ${now + 30 * 60_000 + 1_000}
      then greatest(0, (${deadline})::numeric) else 0 end
    else 0 end`;
}

export async function nextEnvironmentCleanupAt(db: Db, backoffMs = ENVIRONMENT_CLEANUP_RETRY_MS): Promise<number | null> {
  const [row] = await db.select({ next: sql<string | null>`min(greatest(
    extract(epoch from ${environmentLeases.updatedAt}) * 1000 + ${backoffMs},
    ${pendingCleanupDeadlineSql()}))` }).from(environmentLeases).where(eq(environmentLeases.status, "pending_cleanup"));
  const saved = row?.next == null ? null : Number(row.next);
  const buffered = hasDeferredEnvironmentCleanup(db) ? Date.now() + backoffMs : null;
  return saved === null ? buffered : buffered === null ? saved : Math.min(saved, buffered);
}
