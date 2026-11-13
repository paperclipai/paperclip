import { and, eq, or, sql } from "drizzle-orm";
import { environmentLeases, sandboxCreationOperations, type Db } from "@paperclipai/db";
import { hasDeferredEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { nextAbandonedWorkspaceFileHoldExpiryAt } from "./remote-workspace-abandoned-files-hold.js";

export const ENVIRONMENT_CLEANUP_RETRY_MS = 5 * 60_000;

// Escalate and slow cleanup after this many attempts; never abandon a live lease.
export const PENDING_CLEANUP_SWEEP_ATTEMPT_CAP = 5;

// The reaper stores its retry attempt count under this key in the lease metadata.
export const PENDING_CLEANUP_ATTEMPTS_METADATA_KEY = "pendingCleanupRetryAttempts";

// Read the stored retry attempt count as a safe value, directly in SQL. A
// provider can write a malformed value under the attempts key. The type guard
// makes any non-number value read as zero. The reader computes as numeric and
// never casts to int, so a finite number outside the 32-bit range (for example
// 1e300) never throws. The reader clamps a negative value to zero and a positive
// value to the attempt cap. One malformed lease therefore never aborts the page
// sweep. This matches the TypeScript reader `readPendingCleanupRetryAttempts`,
// which clamps to the same range. The claim predicate compares the two readers,
// so both must yield the same value for every input.
export function pendingCleanupAttemptsSql() {
  return sql`
    case
      when jsonb_typeof(${environmentLeases.metadata} -> ${PENDING_CLEANUP_ATTEMPTS_METADATA_KEY}) = 'number'
        then least(
          greatest(
            floor((${environmentLeases.metadata} ->> ${PENDING_CLEANUP_ATTEMPTS_METADATA_KEY})::numeric),
            0
          ),
          ${PENDING_CLEANUP_SWEEP_ATTEMPT_CAP}
        )
      else 0
    end`;
}

// Choose the `jsonb_set` target root. A provider can write a scalar or array
// metadata root. `jsonb_set` fails on a non-object root, so the reader uses the
// stored metadata only when its root is an object. A NULL, scalar, or array root
// reads as an empty object. `jsonb_typeof(NULL)` is NULL, so the else branch also
// covers a NULL root.
export function pendingCleanupMetadataObjectSql() {
  return sql`case when jsonb_typeof(${environmentLeases.metadata}) = 'object' then ${environmentLeases.metadata} else '{}'::jsonb end`;
}

export function recoverableSandboxCreationCondition() {
  return or(eq(sandboxCreationOperations.state, "pending"), and(
    eq(sandboxCreationOperations.state, "needs_reconciliation"),
    sql`coalesce(${sandboxCreationOperations.metadata}->>'creationReconciliationReason', '') <> 'company_deleted'`,
    sql`${sandboxCreationOperations.metadata}->>'runnerTaskLease' = 'true'`,
    sql`jsonb_typeof(${sandboxCreationOperations.metadata}->'runnerTaskCreationContextId') = 'string' and ${sandboxCreationOperations.metadata}->>'runnerTaskCreationContextId' <> ''`,
    or(sql`jsonb_typeof(${sandboxCreationOperations.metadata}->'creationProviderLeaseId') = 'string' and ${sandboxCreationOperations.metadata}->>'creationProviderLeaseId' <> ''`,
      and(sql`${sandboxCreationOperations.metadata}->>'creationOperationVersion' = '1'`,
        sql`jsonb_typeof(${sandboxCreationOperations.metadata}->'providerMetadata') = 'object'`)),
  ));
}

/** A run lease the ownership settle moved to cleanup (an orphaned active
 * lease, or a retained orphan sandbox nothing references any more), before its first
 * cleanup attempt. Its holder is proven gone, so the first stop or teardown is
 * due now regardless of how recently the lease was used; a failed attempt
 * counts and the normal retry backoff applies from then on. */
export function recoveredOrphanFirstAttemptSql() {
  return sql`(${environmentLeases.failureReason} in ('orphaned_active_lease_recovered', 'retained_orphan_sandbox_released')
    or ${environmentLeases.metadata}->'sandboxStopAndRetain'->>'recoveredOrphanedRunLease' = 'true')
    and coalesce(${environmentLeases.metadata}->>'pendingCleanupRetryAttempts', '0') = '0'
    and coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') <> 'true'`;
}

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
  const [row] = await db.select({ next: sql<string | null>`min(case when ${recoveredOrphanFirstAttemptSql()}
    then ${pendingCleanupDeadlineSql()} else greatest(
    extract(epoch from ${environmentLeases.updatedAt}) * 1000 + ${backoffMs},
    ${pendingCleanupDeadlineSql()}) end)` }).from(environmentLeases).where(eq(environmentLeases.status, "pending_cleanup"));
  const [creation] = await db.select({ next: sql<string | null>`min(extract(epoch from ${sandboxCreationOperations.nextAttemptAt}) * 1000)` })
    .from(sandboxCreationOperations).where(recoverableSandboxCreationCondition());
  const expiry = await nextAbandonedWorkspaceFileHoldExpiryAt(db);
  const deadlines = [row?.next, creation?.next, expiry].filter((value): value is string | number => value != null).map(Number);
  const saved = deadlines.length ? Math.min(...deadlines) : null;
  const buffered = hasDeferredEnvironmentCleanup(db) ? Date.now() + backoffMs : null;
  return saved === null ? buffered : buffered === null ? saved : Math.min(saved, buffered);
}
