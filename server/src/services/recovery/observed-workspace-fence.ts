import { inArray } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { hasConfirmedSandboxStopAndRetain } from "../sandbox-stop-and-retain.js";
import type { InProgressRecord, RecordOwner, SettleOutcome } from "./ownership-registry.js";

/**
 * The `observed_workspace_preservation_fence` ownership kind (plan Phase 2).
 *
 * The fence is held by the expired coordinator lease of a remote run. Expiry
 * alone never proves it gone; the provider's stop does: the run's one remote
 * lease carries a termination receipt and a confirmed stop-and-retain. The
 * settle is the one the environment-settlement worker already runs.
 */
export const OBSERVED_WORKSPACE_FENCE_SCOPE = "observed_workspace_preservation_fence";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The fence's owner. The current holder and the provider proof are read in
 * the report pass (`resolveFenceHolders`). */
export function observedWorkspaceFenceOwner(evidence: unknown): RecordOwner {
  const fence = object(object(evidence).observedWorkspacePreservation);
  const token = typeof fence.leaseOwner === "string" && fence.leaseOwner ? fence.leaseOwner : null;
  const generation = typeof fence.controllerGeneration === "number" && Number.isSafeInteger(fence.controllerGeneration)
    ? fence.controllerGeneration : null;
  return token ? { kind: "fence", stamp: { kind: "remote", scope: OBSERVED_WORKSPACE_FENCE_SCOPE, generation, fenceToken: token },
    fence: { currentFenceToken: null, currentGeneration: null, leaseExpiresAt: null } } : { kind: "none" };
}

/** Runs among `runIds` whose one lease shows the provider stopped and retained it. */
export async function providerStoppedObservedRuns(db: Db, runIds: readonly string[]): Promise<Set<string>> {
  const stopped = new Set<string>();
  if (runIds.length === 0) return stopped;
  const leases = await db.select().from(environmentLeases).where(inArray(environmentLeases.heartbeatRunId, [...runIds]));
  const byRun = new Map<string, typeof leases>();
  for (const lease of leases) byRun.set(lease.heartbeatRunId!, [...(byRun.get(lease.heartbeatRunId!) ?? []), lease]);
  for (const [runId, runLeases] of byRun) {
    if (runLeases.length === 1 && hasRemoteTerminationReceipt(runLeases[0]!) && hasConfirmedSandboxStopAndRetain(runLeases[0]!)) {
      stopped.add(runId);
    }
  }
  return stopped;
}

/** Adds the provider proof to observed-workspace fence records (after their
 * current holder was resolved), so a provider-stopped fence is judged gone. */
export async function applyObservedFenceProviderProof(db: Db, records: readonly InProgressRecord[]): Promise<void> {
  const observed = records.filter(record => record.owner.kind === "fence" && record.runId
    && record.owner.stamp.scope === OBSERVED_WORKSPACE_FENCE_SCOPE);
  const stopped = await providerStoppedObservedRuns(db, [...new Set(observed.map(record => record.runId!))]);
  for (const record of observed) {
    if (record.owner.kind === "fence" && stopped.has(record.runId!)) record.owner.fence = { ...record.owner.fence, provider: "stopped" };
  }
}

/** Settle a provider-stopped fence with `settleStoppedObservedWorkspace`, which
 * re-checks every fence field under its own locks. */
export async function settleObservedWorkspaceFence(db: Db, record: InProgressRecord): Promise<SettleOutcome> {
  if (!record.companyId || !record.runId) return { settled: false, reason: "owner_not_provable" };
  const { ObservedWorkspacePreservationBusyError, settleStoppedObservedWorkspace } =
    await import("../native-runtime/native-observed-workspace-preservation.js");
  try {
    return await settleStoppedObservedWorkspace(db, record.companyId, record.runId)
      ? { settled: true, reason: "provider_stopped" } : { settled: false, reason: "fence_not_settleable" };
  } catch (error) {
    // Another worker holds the source rows; a later pass retries.
    if (error instanceof ObservedWorkspacePreservationBusyError) return { settled: false, reason: "source_busy" };
    throw error;
  }
}
