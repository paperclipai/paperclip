import { and, eq } from "drizzle-orm";
import { executionWorkspaceRuntimeLeases, type Db } from "@paperclipai/db";
import { persistActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import type { OwnerProof } from "./owner-proof.js";
import type { InProgressRecord, SettleOutcome } from "./recovery/ownership-registry.js";
import { proveWorkspaceRuntimeLeaseOwnerGone } from "./workspace-runtime-leases.js";

/**
 * Settle of the `execution_workspace_runtime_lease` ownership kind (plan Phase 2).
 *
 * The shared reconciler calls this only after it proved the lease's issue or run
 * owner gone (issue terminal, hidden or missing; run terminal or missing). Settle
 * releases exactly that lease: under the row lock it re-reads the row, requires
 * the same owner key, and re-proves the owner gone, so a lease renewed or taken
 * over since the proof is never released. Age plays no part. Agent-scoped leases
 * are never settled here: no identity proves such an owner gone, and their expiry
 * plus the next claim's locked takeover is the fenced handoff.
 */
export async function settleExecutionWorkspaceRuntimeLease(db: Db, record: InProgressRecord,
  _context: { now: Date; proof: OwnerProof }): Promise<SettleOutcome> {
  const ownerKey = record.owner.kind === "issue" ? `issue:${record.owner.issueId}`
    : record.owner.kind === "run" ? `run:${record.owner.runId}` : null;
  if (!ownerKey) return { settled: false, reason: "owner_not_provable" };
  let publication: ActivityPublication | undefined;
  const outcome = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [row] = await tx.select().from(executionWorkspaceRuntimeLeases)
      .where(and(eq(executionWorkspaceRuntimeLeases.id, record.recordId),
        eq(executionWorkspaceRuntimeLeases.ownerKey, ownerKey)))
      .for("update");
    if (!row) return { settled: false, reason: "lease_no_longer_held" };
    const gone = await proveWorkspaceRuntimeLeaseOwnerGone(tx, row);
    if (!gone) return { settled: false, reason: "owner_changed_since_proof" };
    const deleted = await tx.delete(executionWorkspaceRuntimeLeases)
      .where(and(eq(executionWorkspaceRuntimeLeases.id, row.id), eq(executionWorkspaceRuntimeLeases.ownerKey, ownerKey)))
      .returning({ id: executionWorkspaceRuntimeLeases.id });
    if (!deleted.length) return { settled: false, reason: "lease_no_longer_held" };
    // The lease row is gone; the activity entry keeps who held it and why it was released.
    publication = (await persistActivity(tx, {
      companyId: row.companyId, actorType: "system", actorId: "ownership-reconciler",
      action: "execution_workspace.runtime_lease_released", entityType: "execution_workspace",
      entityId: row.executionWorkspaceId, runId: row.ownerRunId, issueId: row.ownerIssueId,
      details: { leaseId: row.id, previousOwnerKey: row.ownerKey, lastAction: row.lastAction, proof: gone },
    })).publication;
    return { settled: true, reason: gone };
  });
  if (outcome.settled && publication) publishActivity(publication);
  return outcome;
}
