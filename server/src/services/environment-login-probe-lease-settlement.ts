import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { writeEnvironmentCleanup } from "./environment-cleanup-notifications.js";
import { pendingCleanupMetadataObjectSql } from "./environment-cleanup-state.js";
import { holderUnchanged, ORPHANED_RUN_LEASE_FAILURE_REASON } from "./environment-run-lease-settlement.js";
import { allowLegacyShutdownWorkspaceCleanup } from "./legacy-shutdown-workspace-settlement.js";
import type { OwnerProof } from "./owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./recovery/ownership-registry.js";

export async function settleEnvironmentLoginProbeLease(db: Db, record: InProgressRecord,
  context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  if (record.owner.kind !== "process") return { settled: false, reason: "owner_not_provable" };
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [lease] = await tx.select().from(environmentLeases)
      .where(and(eq(environmentLeases.id, record.recordId), eq(environmentLeases.status, "active"),
        isNull(environmentLeases.heartbeatRunId)))
      .for("update");
    if (!lease) return { settled: false, reason: "lease_no_longer_active" };
    if (!holderUnchanged(lease, record)) return { settled: false, reason: "owner_changed_since_proof" };
    if (!(await allowLegacyShutdownWorkspaceCleanup(tx, lease))) return { settled: false, reason: "legacy_shutdown_fence" };
    if (lease.provider && lease.providerLeaseId) {
      const [other] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
        ne(environmentLeases.id, lease.id), eq(environmentLeases.provider, lease.provider),
        eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
        inArray(environmentLeases.status, ["active", "retained", "pending_cleanup"]))).limit(1);
      if (other) return { settled: false, reason: "provider_resource_shared" };
    }
    const flipped = await writeEnvironmentCleanup(tx, write => write.update(environmentLeases)
      .set({ status: "pending_cleanup", failureReason: ORPHANED_RUN_LEASE_FAILURE_REASON,
        metadata: sql`${pendingCleanupMetadataObjectSql()} || ${JSON.stringify({
          pendingCleanupRecoveredAtMs: context.now.getTime(), recoveredRunlessLease: { ownerProof: context.proof.reason } })}::jsonb` })
      .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.status, "active"),
        isNull(environmentLeases.heartbeatRunId),
        sql`${environmentLeases.metadata} is not distinct from ${lease.metadata === null ? null : JSON.stringify(lease.metadata)}::jsonb`))
      .returning({ id: environmentLeases.id }), { companyId: lease.companyId, leaseId: lease.id });
    return flipped.length ? { settled: true, reason: context.proof.reason } : { settled: false, reason: "lease_no_longer_active" };
  });
}
