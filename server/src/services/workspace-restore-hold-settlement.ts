import { and, eq, ne, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, workspaceOperations, type Db } from "@paperclipai/db";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { retiredReusableLeasePredecessors } from "./environment-lease-handoff.js";
import { nativeWorkspaceExportPendingForLease } from "./native-runtime/native-workspace-finalization-state.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";
import { hasConfirmedSandboxStopAndRetain } from "./sandbox-stop-and-retain.js";
import { completedWorkspaceRecoveryCondition } from "./workspace-recovery-receipt.js";
import { LEGACY_WORKSPACE_RECOVERY_KEY, LEGACY_WORKSPACE_RECOVERY_SCHEMA, SETTLED_WORKSPACE_RESTORE_HOLD_KEY } from "./workspace-restore-recovery-state.js";

type Source = { companyId: string; issueId: string; runId: string; actionId: string };

/**
 * A restore hold stops a warm sandbox and changes its lease to
 * `retain_on_failure` only while its files are at risk. Once recovery has
 * saved them, return the sandbox to warm reuse so the next run resumes it
 * instead of paying a new allocation and a full workspace realize.
 *
 * Call inside the transaction that completes the recovery. Every guard is
 * checked again against the current row, and the policy write is a
 * compare-and-swap on the exact metadata that was checked. A hold that has not
 * settled, holds unsaved writer state, or has an ambiguous owner keeps its
 * protection. Returns the lease IDs returned to reuse.
 */
export async function settleRecoveredWorkspaceRestoreHolds(db: Db, input: Source): Promise<string[]> {
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!run) return [];
  // A recovered workspace whose recorded disposition is `destroy` owes cleanup
  // (scheduleRecoveredWorkspaceCleanup), not reuse.
  const legacy = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  const remote = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  const disposition = legacy?.resourceDisposition ?? (remote.success ? run.runnerProfileJson?.nativeResourceDisposition : undefined);
  if (disposition === "destroy") return [];
  // The hold settled only when this recovery is complete with saved files and
  // its own workspace_finalize receipt.
  const [action] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    eq(issueRecoveryActions.id, input.actionId), completedWorkspaceRecoveryCondition(run.id))).limit(1);
  const operationIds = (action?.evidence.systemRecovery as { preservationOperationIds?: unknown } | undefined)?.preservationOperationIds;
  if (!action || !Array.isArray(operationIds)) return [];
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    eq(environmentLeases.leasePolicy, "retain_on_failure"), eq(environmentLeases.status, "released"),
    sql`${environmentLeases.metadata}->${LEGACY_WORKSPACE_RECOVERY_KEY}->>'schema' = ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}`,
    sql`${environmentLeases.metadata}->${LEGACY_WORKSPACE_RECOVERY_KEY}->>'runId' = ${run.id}`));
  const restored: string[] = [];
  for (const lease of leases) {
    const marker = lease.metadata![LEGACY_WORKSPACE_RECOVERY_KEY] as Record<string, unknown>;
    // Only a hold over a reusable sandbox returns to reuse. Rows saved before
    // the marker recorded the original policy prove it by their reuse scope,
    // which only a `reuse_by_environment` acquisition writes.
    const original = marker.originalLeasePolicy
      ?? (isRecord(lease.metadata?.reusableSandboxLease) ? "reuse_by_environment" : undefined);
    if (original !== "reuse_by_environment" || !lease.provider || !lease.providerLeaseId) continue;
    // The stop that the hold required is confirmed and nothing is reopening it.
    if (!hasConfirmedSandboxStopAndRetain(lease)) continue;
    // These files were saved by this recovery, from this exact allocation.
    const [saved] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.heartbeatRunId, run.id),
      eq(workspaceOperations.status, "succeeded"),
      sql`${workspaceOperations.id}::text in (select jsonb_array_elements_text(${JSON.stringify(operationIds)}::jsonb))`,
      sql`${workspaceOperations.metadata}->>'leaseId' = ${lease.id}`,
      sql`${workspaceOperations.metadata}->>'providerLeaseId' = ${lease.providerLeaseId}`)).limit(1);
    if (!saved) continue;
    // No unsaved writer or pending native export may remain on the allocation.
    if (await nativeWorkspaceExportPendingForLease(db, lease)) continue;
    // A single verified owner chain: any other live owner keeps the hold.
    const history = await db.select().from(environmentLeases).where(and(ne(environmentLeases.id, lease.id),
      eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId)));
    if (!retiredReusableLeasePredecessors(lease, history)) continue;
    const { [LEGACY_WORKSPACE_RECOVERY_KEY]: _held, ...metadata } = lease.metadata!;
    const [updated] = await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment", updatedAt: new Date(),
      metadata: { ...metadata, [SETTLED_WORKSPACE_RESTORE_HOLD_KEY]: { ...marker, actionId: input.actionId,
        snapshotOperationId: saved.id, restoredLeasePolicy: "reuse_by_environment", settledAt: new Date().toISOString() } },
    }).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, lease.id),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.leasePolicy, "retain_on_failure"),
      eq(environmentLeases.status, "released"), sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`,
    )).returning({ id: environmentLeases.id });
    if (updated) restored.push(updated.id);
  }
  return restored;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
