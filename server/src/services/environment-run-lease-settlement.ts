import { and, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { currentControllerBootId } from "./controller-process-identity.js";
import { writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { pendingCleanupMetadataObjectSql } from "./environment-cleanup-state.js";
import { readEnvironmentLeaseController } from "./environment-lease-controller.js";
import { allowLegacyShutdownWorkspaceCleanup } from "./legacy-shutdown-workspace-settlement.js";
import { nativeWorkspaceExportPendingForLease } from "./native-runtime/native-workspace-finalization-state.js";
import type { OwnerProof } from "./owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./recovery/ownership-registry.js";
import { isBuiltinSandboxProvider } from "./sandbox-provider-runtime.js";
import { prepareSandboxStopAndRetain } from "./sandbox-stop-and-retain.js";

/** Failure reason written on a run lease the shared ownership path settled. */
export const ORPHANED_RUN_LEASE_FAILURE_REASON = "orphaned_active_lease_recovered";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const TERMINAL_NATIVE_PHASES = ["committed", "terminal_failure", "applied"];

type LeaseRow = typeof environmentLeases.$inferSelect;

/**
 * Settle of the `environment_run_lease_active` ownership kind (plan Phase 2).
 *
 * A run's executor writes the terminal run status and then releases the run's
 * environment lease from its `finally`. A crash between the two writes, or a
 * release that skipped the lease, leaves the lease `active` with no holder.
 * Previously a sweep released such a lease once it had been idle for five
 * minutes. The shared reconciler now calls this only after the lease holder
 * (the run while it is active, then the stamped lease holder) is proven gone.
 *
 * The settle compares and swaps on the exact lease row the proof judged: the
 * same run, status `active`, and the same metadata (which holds the holder
 * stamp). It settles ownership only:
 * - a sandbox is stopped and kept (the stop-and-retain intent), never
 *   destroyed: deciding whether its files are still needed is the workspace
 *   preservation obligation, not this one;
 * - a lease without a remote sandbox moves to `pending_cleanup`, as before;
 * - a lease still needed by another obligation is left alone: a pending native
 *   workspace export, a legacy shutdown fence, another live lease on the same
 *   provider resource, or an accepted native result whose settlement can
 *   release the lease (its environment still exists) with the run's own
 *   resource disposition.
 */
export async function settleEnvironmentRunLease(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (!record.runId) return { settled: false, reason: "lease_has_no_run" };
  const runId = record.runId;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [lease] = await tx.select().from(environmentLeases)
      .where(and(eq(environmentLeases.id, record.recordId), eq(environmentLeases.status, "active"),
        eq(environmentLeases.heartbeatRunId, runId)))
      .for("update");
    if (!lease) return { settled: false, reason: "lease_no_longer_active" };
    if (!holderUnchanged(lease, record)) return { settled: false, reason: "owner_changed_since_proof" };
    const [run] = await tx.select({ status: heartbeatRuns.status, controllerBootId: heartbeatRuns.controllerBootId })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    if (run && !TERMINAL_RUN_STATUSES.includes(run.status)) return { settled: false, reason: "owner_run_active" };
    if (record.owner.kind === "run" && !context.proof.localExecutionsKnown
      && await currentBootOwnsRun(tx, lease, run?.controllerBootId ?? null)) {
      // A lease saved before holders were stamped: this boot may be releasing
      // it right now (a hot-restart adoption), so only an earlier boot's
      // lease is released by the run fact alone, unless the caller named every
      // run this process executes.
      return { settled: false, reason: "current_boot_owns_run" };
    }
    const kept = await keptByAnotherObligation(tx, lease);
    if (kept) return { settled: false, reason: kept };

    const recovery = { recoveredOrphanedRunLease: true, ownerProof: context.proof.reason };
    if (await stopsASandbox(tx, lease)) {
      const stopped = await prepareSandboxStopAndRetain(tx, lease, recovery);
      return stopped ? { settled: true, reason: context.proof.reason } : { settled: false, reason: "lease_no_longer_active" };
    }
    // Keep the row's updatedAt, so the pending_cleanup sweep accepts it in the
    // same tick instead of waiting out its own retry backoff.
    const flipped = await writeEnvironmentCleanup(tx, write => write.update(environmentLeases)
      .set({ status: "pending_cleanup", failureReason: ORPHANED_RUN_LEASE_FAILURE_REASON,
        // When the first cleanup attempt became due (the row keeps updatedAt).
        // A scalar or array root reads as an empty object, so the key is top level.
        metadata: sql`${pendingCleanupMetadataObjectSql()} || ${JSON.stringify({
          pendingCleanupRecoveredAtMs: context.now.getTime() })}::jsonb` })
      .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.status, "active"),
        eq(environmentLeases.heartbeatRunId, runId),
        sql`${environmentLeases.metadata} is not distinct from ${lease.metadata === null ? null : JSON.stringify(lease.metadata)}::jsonb`))
      .returning({ id: environmentLeases.id }), { companyId: lease.companyId, runId, leaseId: lease.id });
    return flipped.length ? { settled: true, reason: context.proof.reason } : { settled: false, reason: "lease_no_longer_active" };
  });
}

/** The proof judged a holder stamp (or its absence, for a legacy row); a lease
 * re-stamped since then belongs to someone else. */
function holderUnchanged(lease: LeaseRow, record: InProgressRecord): boolean {
  const holder = readEnvironmentLeaseController(lease.metadata);
  if (record.owner.kind === "run") return holder === null;
  if (record.owner.kind !== "process") return false;
  const stamp = record.owner.stamp;
  return holder !== null && holder.bootId === stamp.bootId && holder.pid === stamp.pid
    && holder.hostHash === stamp.processSpace && holder.processStartedAt === (stamp.processStartedAt ?? null);
}

async function currentBootOwnsRun(tx: Db, lease: LeaseRow, runControllerBootId: string | null): Promise<boolean> {
  const bootId = currentControllerBootId();
  if (runControllerBootId === bootId) return true;
  const [native] = await tx.select({ controllerBootId: nativeRunFinalizations.controllerBootId })
    .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, lease.heartbeatRunId!),
      eq(nativeRunFinalizations.companyId, lease.companyId)));
  return native?.controllerBootId === bootId;
}

async function keptByAnotherObligation(tx: Db, lease: LeaseRow): Promise<string | null> {
  if (await nativeWorkspaceExportPendingForLease(tx, lease)) return "workspace_export_pending";
  if (!(await allowLegacyShutdownWorkspaceCleanup(tx, lease))) return "legacy_shutdown_fence";
  // One provider resource id names one physical sandbox; another live lease
  // on it still owns that sandbox.
  if (lease.provider && lease.providerLeaseId) {
    const [other] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
      inArray(environmentLeases.status, ["active", "retained", "pending_cleanup"]))).limit(1);
    if (other) return "provider_resource_shared";
  }
  // An accepted native result is finalized and then releases this lease with
  // the run's resource disposition (native environment settlement).
  const [accepted] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.runId, nativeRunFinalizations.runId), eq(nativeRunResults.companyId, nativeRunFinalizations.companyId),
      eq(nativeRunResults.schemaStatus, "accepted")))
    .where(and(eq(nativeRunFinalizations.runId, lease.heartbeatRunId!), eq(nativeRunFinalizations.companyId, lease.companyId),
      or(notInArray(nativeRunFinalizations.phase, TERMINAL_NATIVE_PHASES), eq(nativeRunFinalizations.phase, "committed"),
        and(eq(nativeRunFinalizations.phase, "terminal_failure"),
          sql`${nativeRunFinalizations.failureDetail} ? 'workspaceFinalizeAttempt'`)))).limit(1);
  // Native settlement releases through the lease's environment; with the
  // environment row gone it skips the lease, so this settle must not wait.
  if (accepted && lease.environmentId) {
    const [environment] = await tx.select({ id: environments.id }).from(environments)
      .where(eq(environments.id, lease.environmentId));
    if (environment) return "native_result_settles_lease";
  }
  return null;
}

/** A sandbox lease whose stop can be dispatched from the recorded lease alone
 * (the same pins the stop-only cleanup requires). */
async function stopsASandbox(tx: Db, lease: LeaseRow): Promise<boolean> {
  if (!lease.provider || lease.provider === "local" || !lease.providerLeaseId) return false;
  let driver = typeof lease.metadata?.driver === "string" ? lease.metadata.driver : null;
  if (!driver && lease.environmentId) {
    const [environment] = await tx.select({ driver: environments.driver }).from(environments)
      .where(eq(environments.id, lease.environmentId));
    driver = environment?.driver ?? null;
  }
  if ((driver ?? "sandbox") !== "sandbox") return false;
  const plugin = lease.metadata?.pluginId;
  if (isBuiltinSandboxProvider(lease.provider)) return plugin == null && !lease.metadata?.sandboxProviderPlugin;
  return typeof plugin === "string" && plugin.length > 0;
}
