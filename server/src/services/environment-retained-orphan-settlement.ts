import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { nativeWorkspaceExportPendingForLease } from "./native-runtime/native-workspace-finalization-state.js";
import type { OwnerProof } from "./owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./recovery/ownership-registry.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { ORPHANED_SANDBOX_RECOVERY_KEY } from "./sandbox-stop-and-retain.js";

/** Failure reason on a retained orphan sandbox released for destruction. */
export const RETAINED_ORPHAN_RELEASED_REASON = "retained_orphan_sandbox_released";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
/** Runs on the same issue that may still continue from this sandbox. */
const OPEN_RUN_STATUSES = ["queued", "scheduled_retry", "running"];

type LeaseRow = typeof environmentLeases.$inferSelect;

/** A retained orphan: the ownership settle stopped and kept its sandbox, and
 * the stop is confirmed. */
export function retainedOrphanSandboxCondition() {
  return and(eq(environmentLeases.status, "released"), eq(environmentLeases.cleanupStatus, "success"),
    // An ephemeral lease only: a reusable lease stays for warm reuse, and a
    // retain-on-failure lease belongs to workspace restore recovery.
    eq(environmentLeases.leasePolicy, "ephemeral"),
    sql`${environmentLeases.heartbeatRunId} is not null`, sql`${environmentLeases.provider} is not null`,
    sql`${environmentLeases.providerLeaseId} is not null`,
    sql`${environmentLeases.metadata} ? ${ORPHANED_SANDBOX_RECOVERY_KEY}`,
    sql`${environmentLeases.metadata} ? 'sandboxStopAndRetainReceipt'`);
}

/** SQL mirror of the "held only while the stop is a usable source" checks in
 * `heldBy`, so a held orphan is not listed (and not polled) until its last
 * reference clears or its retention window ends. The settle re-checks all of
 * them, plus the pending native export, under the row lock. */
function softlyHeldSql(now?: Date) {
  const at = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;
  const issue = sql`coalesce(run.native_issue_id, run.issue_id, ${environmentLeases.issueId})`;
  return sql`(${environmentLeases.expiresAt} is null or ${environmentLeases.expiresAt} > ${at}) and (
    exists (select 1 from issue_recovery_actions action, heartbeat_runs run
      where run.id = ${environmentLeases.heartbeatRunId} and action.company_id = ${environmentLeases.companyId}
      and action.source_issue_id = ${issue} and action.status not in ('resolved', 'cancelled'))
    or exists (select 1 from heartbeat_runs run, heartbeat_runs other
      where run.id = ${environmentLeases.heartbeatRunId} and other.company_id = ${environmentLeases.companyId}
      and other.id <> run.id and other.status in ('queued', 'scheduled_retry', 'running')
      and (other.issue_id = ${issue} or other.native_issue_id = ${issue})))`;
}

function alwaysHeldSql() {
  return sql`(${environmentLeases.metadata} ?| array['nativeWorkspaceExportResume', 'sandboxStopAndRetain',
      'workspaceRestoreRecovery', 'workspaceRecoveryCleanup', 'runnerTaskSourceConsumer']
    or coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') = 'true'
    or coalesce(${environmentLeases.metadata}#>>'{legacyShutdownWorkspaceSettlement,state}' = 'pending', false)
    or exists (select 1 from heartbeat_runs run where run.id = ${environmentLeases.heartbeatRunId}
      and run.status not in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'))
    -- A prepared native workspace bound to this exact sandbox, for a run with
    -- workspace access. This is deliberately no wider than the settle's own
    -- export check: an orphan the settle would release must never be hidden
    -- here. Narrower cases (a prepared remote workspace, an observed failure)
    -- are listed and held by the settle until their export settles.
    -- The descriptor must also be one the settle's reader accepts
    -- (readNativeWorkspaceSyncReference); an invalid one holds nothing.
    or exists (select 1 from heartbeat_runs run where run.id = ${environmentLeases.heartbeatRunId}
      and run.runtime_mode = 'native'
      and run.runner_profile_json#>>'{nativeWorkspaceSync,schema}' in
        ('paperclip.native-workspace-sync/v1', 'paperclip.native-workspace-sync/v2', 'paperclip.native-workspace-sync/v3')
      and run.runner_profile_json#>>'{nativeWorkspaceSync,state}' = 'prepared'
      and coalesce(run.runner_profile_json#>>'{nativeWorkspaceSync,descriptorSha256}' ~ '^[0-9a-f]{64}$', false)
      and coalesce(run.runner_profile_json#>>'{nativeWorkspaceSync,baselineSha256}' ~ '^[0-9a-f]{64}$', false)
      and coalesce(jsonb_typeof(run.runner_profile_json#>'{nativeWorkspaceSync,finalHostSha256}'), 'null') = 'null'
      and jsonb_typeof(run.runner_profile_json#>'{nativeWorkspaceSync,workspaceId}') = 'string'
      and jsonb_typeof(run.runner_profile_json#>'{nativeWorkspaceSync,remoteCwd}') = 'string'
      and coalesce(run.runner_profile_json#>>'{nativeWorkspaceSync,resourceDisposition}', 'destroy')
        in ('keep_running', 'stop_and_retain', 'destroy')
      and run.runner_profile_json#>>'{nativeWorkspaceSync,leaseId}' = ${environmentLeases.id}::text
      and run.runner_profile_json#>>'{nativeWorkspaceSync,providerLeaseId}' = ${environmentLeases.providerLeaseId}
      and coalesce(run.runner_profile_json#>>'{nativeExecutionInput,workspace,access}', '') <> 'none')
    or exists (select 1 from environment_leases other where other.id <> ${environmentLeases.id}
      and other.provider = ${environmentLeases.provider} and other.provider_lease_id = ${environmentLeases.providerLeaseId}
      and other.status in ('active', 'retained', 'pending_cleanup')))`;
}

/** Retained orphans that nothing appears to reference now. */
// The listing is built once, so it reads the database clock.
export function releasableRetainedOrphanCondition(now?: Date) {
  return and(retainedOrphanSandboxCondition(), sql`not ${alwaysHeldSql()}`, sql`not (${softlyHeldSql(now)})`);
}

/** When the next retained orphan's retention window ends while only soft
 * references hold it; the reconciler wakes then to release it. */
export async function nextRetainedOrphanDueAt(db: Db, now: Date): Promise<Date | null> {
  const [row] = await db.select({ due: sql<string | null>`min(${environmentLeases.expiresAt})` }).from(environmentLeases)
    .where(and(retainedOrphanSandboxCondition(), sql`not ${alwaysHeldSql()}`, sql`${softlyHeldSql(now)}`,
      sql`${environmentLeases.expiresAt} is not null`));
  return row?.due ? new Date(row.due) : null;
}

/**
 * Settle of the `environment_retained_orphan_sandbox` kind (plan Phase 2).
 *
 * The orphaned-run-lease settle stops a dead holder's sandbox and keeps it,
 * because recovery may still need its files. This settle destroys that
 * retained orphan once no obligation references it, so it is never kept
 * longer than the environment's own retention allows.
 *
 * It decides from database facts only, inside one transaction that locks the
 * lease row:
 * - the run is terminal;
 * - always held: an active operation on the sandbox (a native export resume,
 *   a stop-and-retain intent, an in-flight cleanup claim, a workspace restore
 *   recovery, a pending legacy shutdown fence, a bound source-recovery
 *   consumer) or another live lease on the same provider resource;
 * - always held: a pending native workspace export or preservation fence;
 * - held while the stop receipt is still a usable workspace source (the
 *   lease's provider-attested `expiresAt` has not passed): an open recovery
 *   action on the issue, or a queued, scheduled or running run on the issue. Past that
 *   retention window no recovery path accepts the stopped sandbox as a source
 *   (`hasConfirmedSandboxStopAndRetain`), so these no longer hold it.
 *
 * Then it hands the sandbox to the pending-cleanup sweep for destruction,
 * with a compare-and-swap on the exact row it judged. It never calls a
 * provider itself and never runs on the turn path.
 */
export async function settleRetainedOrphanSandbox(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (!record.runId) return { settled: false, reason: "lease_has_no_run" };
  const runId = record.runId;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [lease] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, record.recordId),
      eq(environmentLeases.heartbeatRunId, runId), eq(environmentLeases.status, "released"),
      eq(environmentLeases.cleanupStatus, "success"))).for("update");
    if (!lease || !hasRemoteTerminationReceipt(lease) || lease.leasePolicy !== "ephemeral" || !lease.metadata?.[ORPHANED_SANDBOX_RECOVERY_KEY]
      || !lease.provider || !lease.providerLeaseId) {
      return { settled: false, reason: "no_longer_a_retained_orphan" };
    }
    const held = await heldBy(tx, lease, runId, context.now);
    if (held) return { settled: false, reason: held };
    const now = context.now;
    // The destroy is queued through the recognized stopped-cleanup contract
    // (`workspaceRecoveryCleanup` with the verified stop receipt), so admission
    // and Retry keep treating the sandbox as stopped while it waits.
    const released = await writeEnvironmentCleanup(tx, write => write.update(environmentLeases).set({
      status: "pending_cleanup", cleanupStatus: "failed",
      failureReason: RETAINED_ORPHAN_RELEASED_REASON, updatedAt: now,
      metadata: sql`(${environmentLeases.metadata} - 'remoteExecutionTermination') || ${JSON.stringify({
        workspaceRecoveryCleanup: { runId, stopReceipt: lease.metadata?.remoteExecutionTermination,
          reason: RETAINED_ORPHAN_RELEASED_REASON, releasedAt: now.toISOString(), ownerProof: context.proof.reason },
        pendingCleanupInFlight: false, pendingCleanupRetryAfterMs: 0, pendingCleanupRetryAttempts: 0,
        pendingCleanupLeaseExpiresAtMs: 0 })}::jsonb`,
    }).where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.heartbeatRunId, runId),
      eq(environmentLeases.status, "released"), eq(environmentLeases.cleanupStatus, "success"),
      sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`))
      .returning({ id: environmentLeases.id }), { companyId: lease.companyId, runId, leaseId: lease.id });
    return released.length ? { settled: true, reason: context.proof.reason } : { settled: false, reason: "lease_changed_since_proof" };
  });
}

async function heldBy(tx: Db, lease: LeaseRow, runId: string, now: Date): Promise<string | null> {
  const metadata = lease.metadata ?? {};
  const [run] = await tx.select({ status: heartbeatRuns.status, issueId: heartbeatRuns.issueId,
    nativeIssueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  if (run && !TERMINAL_RUN_STATUSES.includes(run.status)) return "run_active";

  // Always held: an operation on this sandbox is still in progress.
  if (metadata.nativeWorkspaceExportResume !== undefined) return "native_export_resume";
  if (metadata.sandboxStopAndRetain !== undefined) return "stop_and_retain_intent";
  if (metadata.pendingCleanupInFlight === true) return "cleanup_claim_in_flight";
  if (metadata.workspaceRestoreRecovery !== undefined) return "workspace_restore_recovery";
  if (metadata.workspaceRecoveryCleanup !== undefined) return "workspace_recovery_cleanup";
  if (metadata.runnerTaskSourceConsumer !== undefined) return "source_recovery_consumer";
  const shutdown = metadata.legacyShutdownWorkspaceSettlement as Record<string, unknown> | undefined;
  if (shutdown?.state === "pending") return "legacy_shutdown_fence";
  const [other] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider!),
    eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
    inArray(environmentLeases.status, ["active", "retained", "pending_cleanup"]))).limit(1);
  if (other) return "provider_resource_shared";

  // A pending native export is an active preservation operation; the cleanup
  // sweep would defer the destroy anyway, so it always holds the sandbox.
  if (await nativeWorkspaceExportPendingForLease(tx, lease)) return "workspace_preservation_pending";
  // Held only while the stopped sandbox is still a usable workspace source.
  if (lease.expiresAt && lease.expiresAt <= now) return null;
  const issueId = run?.nativeIssueId ?? run?.issueId ?? lease.issueId;
  if (!issueId) return null;
  const [action] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, lease.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    notInArray(issueRecoveryActions.status, ["resolved", "cancelled"]))).limit(1);
  if (action) return "recovery_action_open";
  const [next] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, lease.companyId), ne(heartbeatRuns.id, runId),
    inArray(heartbeatRuns.status, OPEN_RUN_STATUSES),
    sql`(${heartbeatRuns.issueId} = ${issueId} or ${heartbeatRuns.nativeIssueId} = ${issueId})`)).limit(1);
  if (next) return "issue_run_pending";
  return null;
}
